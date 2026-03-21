import * as path from 'path';
import * as vscode from 'vscode';
import { registerSaveHandler, outputChannel } from './saveHandler';
import { AIProvider } from './ai/aiProvider';
import { OpenAIProvider } from './ai/openaiProvider';
import { ClaudeProvider } from './ai/claudeProvider';
import { OllamaProvider } from './ai/ollamaProvider';
import { GitHubModelsProvider } from './ai/githubModelsProvider';
import { validateResponse } from './utils/validateResponse';
import { processingQueue } from './utils/processingQueue';
import { writeSpecFile, mergeSpecFile, resolveSpecPath } from './fileWriter';
import { runGapFinder } from './gapFinder';
import { TelemetryService } from './telemetry';
import { healSpec } from './utils/specHealer';

// Module-level — track active controllers for clean abort on deactivate
const activeControllers = new Set<AbortController>();

// Race guard — prevents duplicate cost warnings on simultaneous saves
let costCheckInProgress = false;

// Ollama auto-detect — live check on every generation
async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// One-time cost acknowledgement for paid providers
async function checkCostAcknowledgement(
  context: vscode.ExtensionContext,
  providerName: string
): Promise<boolean> {
  if (providerName !== 'claude' && providerName !== 'openai') { return true; }
  if (costCheckInProgress) { return false; }

  const key = `silentspec.${providerName}.costAcknowledged`;
  const acknowledged = context.globalState.get<boolean>(key, false);
  if (acknowledged) { return true; }

  costCheckInProgress = true;
  const action = await vscode.window.showWarningMessage(
    `SilentSpec will use your ${providerName === 'claude' ? 'Claude (Anthropic)' : 'OpenAI'} API key. ` +
    'Your API provider may charge per request. Typical cost is ~$0.003 per generation.',
    'I understand — continue',
    'Cancel'
  );
  costCheckInProgress = false;

  if (action !== 'I understand — continue') { return false; }
  await context.globalState.update(key, true);
  return true;
}

// Provider factory
function getProvider(
  context: vscode.ExtensionContext,
  providerOverride?: string
): AIProvider {
  const config = vscode.workspace.getConfiguration('silentspec');
  const providerName = providerOverride ?? config.get<string>('provider', 'github');
  const modelOverride = config.get<string>('model', '') || undefined;

  if (providerName === 'openai') {
    return new OpenAIProvider(modelOverride).withSecrets(context.secrets);
  }
  if (providerName === 'claude') {
    return new ClaudeProvider(modelOverride).withSecrets(context.secrets);
  }
  if (providerName === 'github') {
    return new GitHubModelsProvider(modelOverride).withSecrets(context.secrets);
  }
  return new OllamaProvider(modelOverride);
}

// post-processing: correct import statement using AST export type data
// Fixes AI hallucination where default exports are imported as named exports
function fixImportStatement(
  validated: string,
  filePath: string,
  specPath: string,
  exportedFunctions: string[],
  exportTypes: Record<string, 'default' | 'named'>,
  log: (msg: string) => void
): string {
  const sourceBaseName = path.basename(filePath, path.extname(filePath));
  const specDir = path.dirname(specPath);
  const sourceDir = path.dirname(filePath);

  let relativePath = path.relative(specDir, path.join(sourceDir, sourceBaseName));
  if (!relativePath.startsWith('.')) { relativePath = './' + relativePath; }

  const defaultExport = exportedFunctions.find(f => exportTypes[f] === 'default');
  const namedExports = exportedFunctions.filter(f => exportTypes[f] === 'named');

  let correctImport: string;
  const namedPart = namedExports.length > 0 ? `{ ${namedExports.join(', ')} }` : '';

  if (defaultExport && namedPart) {
    correctImport = `import ${defaultExport}, ${namedPart} from '${relativePath}';`;
  } else if (defaultExport) {
    correctImport = `import ${defaultExport} from '${relativePath}';`;
  } else {
    correctImport = `import ${namedPart} from '${relativePath}';`;
  }

  const filenameNoExt = sourceBaseName.replace(/\.[tj]sx?$/, '');
  const nuclearRegex = new RegExp(`import\\s+[\\s\\S]*?\\s+from\\s+['"].*${filenameNoExt}['"];?`, 'gm');

  if (nuclearRegex.test(validated)) {
    log(`Import corrected for ${filenameNoExt}`);
    return validated.replace(nuclearRegex, correctImport);
  }

  log(`Warning: no import found for ${filenameNoExt} — injecting after SS-GENERATED-START`);
  return validated.replace(
    '// <SS-GENERATED-START>',
    `// <SS-GENERATED-START>\n${correctImport}`
  );
}

export function activate(context: vscode.ExtensionContext) {

  // Track install date — used for accurate weekly projections
  let installDate = context.globalState.get<string>('silentspec.installDate');
  if (!installDate) {
    installDate = new Date().toISOString();
    context.globalState.update('silentspec.installDate', installDate);
  }

  // Telemetry — local only, never transmitted
  const telemetry = new TelemetryService(context, installDate);

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBar.command = 'silentspec.togglePause';

  let isPaused = context.workspaceState.get<boolean>('silentspec.paused', false);
  let lastUsedProvider = vscode.workspace
    .getConfiguration('silentspec')
    .get<string>('provider', 'github');

  function updateStatusBar(text?: string) {
    if (text) {
      statusBar.text = text;
      statusBar.backgroundColor = undefined;
      return;
    }
    statusBar.text = isPaused
      ? '$(debug-pause) SS: Paused'
      : `$(zap) SS: On (${lastUsedProvider})`;
    statusBar.tooltip = isPaused
      ? 'SilentSpec paused — click to resume'
      : `SilentSpec active — using ${lastUsedProvider}. Click to pause.`;
    statusBar.backgroundColor = isPaused
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  function updateStatus(text: string): void {
    if (!text) { updateStatusBar(); return; }
    statusBar.text = text;
    statusBar.tooltip = 'SilentSpec only generates tests for exported functions. Add export keyword to enable generation.';
    statusBar.backgroundColor = undefined;
  }

  async function getActiveProvider(): Promise<AIProvider> {
    const config = vscode.workspace.getConfiguration('silentspec');
    const configuredProvider = config.get<string>('provider', 'github');
    if (configuredProvider === 'github') {
      const ollamaUp = await isOllamaRunning();
      if (ollamaUp) { return getProvider(context, 'ollama'); }
    }
    return getProvider(context);
  }

  async function getActiveProviderName(): Promise<string> {
    const config = vscode.workspace.getConfiguration('silentspec');
    const configuredProvider = config.get<string>('provider', 'github');
    if (configuredProvider === 'github') {
      const ollamaUp = await isOllamaRunning();
      if (ollamaUp) { return 'ollama'; }
    }
    return configuredProvider;
  }

  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Toggle pause
  const toggleCmd = vscode.commands.registerCommand(
    'silentspec.togglePause',
    async () => {
      isPaused = !isPaused;
      await context.workspaceState.update('silentspec.paused', isPaused);
      updateStatusBar();
    }
  );
  context.subscriptions.push(toggleCmd);

  // Set API key
  const setKeyCmd = vscode.commands.registerCommand(
    'silentspec.setApiKey',
    async () => {
      const provider = await vscode.window.showQuickPick(
        ['claude', 'openai', 'github'],
        { placeHolder: 'Select provider to set API key for' }
      );
      if (!provider) { return; }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider === 'claude' ? 'Anthropic' : provider === 'github' ? 'GitHub' : 'OpenAI'} API key`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: provider === 'claude' ? 'sk-ant-...' : provider === 'github' ? 'ghp_...' : 'sk-...',
      });

      if (!key || key.trim().length === 0) { return; }

      const secretKey = provider === 'claude'
        ? 'silentspec.claudeApiKey'
        : provider === 'github'
          ? 'silentspec.githubToken'
          : 'silentspec.openaiApiKey';

      const displayName = provider === 'claude' ? 'Claude'
        : provider === 'github' ? 'GitHub' : 'OpenAI';

      await context.secrets.store(secretKey, key.trim());
      vscode.window.showInformationMessage(
        `SilentSpec: ${displayName} API key saved ✓`
      );
    }
  );
  context.subscriptions.push(setKeyCmd);

  // Open output log
  const openLogCmd = vscode.commands.registerCommand(
    'silentspec.openLog',
    () => outputChannel.show()
  );
  context.subscriptions.push(openLogCmd);

  // Show impact stats — dual mode: simple for devs, advanced for CTOs
  const statsCmd = vscode.commands.registerCommand(
    'silentspec.showStats',
    async () => {
      const stats = telemetry.getStats();
      const lastDate = stats.lastGeneratedAt === 'none'
        ? 'never'
        : new Date(stats.lastGeneratedAt).toLocaleDateString();

      const reliabilityRate = stats.totalGenerations > 0
        ? Math.round((stats.successfulGenerations / stats.totalGenerations) * 100)
        : 0;

      // ── SIMPLE VIEW (for individual developers) ──────────────────
      const selection = await vscode.window.showInformationMessage(
        `$(zap) SilentSpec — Your Impact\n` +
        `Functions Covered: ${stats.functionsCovered}\n` +
        `Tests Auto-Healed: ${stats.testsHealed ?? 0}\n` +
        `Time Reclaimed: ${stats.estimatedHoursSaved} hrs (net)\n` +
        `Reliability: ${reliabilityRate}% (${stats.successfulGenerations}/${stats.totalGenerations} generations)\n` +
        `Last Provider: ${stats.lastProvider} · ${lastDate}`,
        { modal: false },
        'Team ROI Report'
      );

      // ── ADVANCED VIEW (for CTOs / team leads) ────────────────────
      if (selection === 'Team ROI Report') {
        const MINS_PER_FUNCTION = 15;
        const HOURLY_RATE = 85;

        const teamSizeInput = await vscode.window.showInputBox({
          prompt: 'How many developers on your team?',
          placeHolder: '5',
          value: '5',
          validateInput: (val) => {
            const n = parseInt(val);
            if (isNaN(n) || n < 1 || n > 10000) { return 'Enter a number between 1 and 10000'; }
            return null;
          }
        });

        if (!teamSizeInput) { return; }
        const TEAM_SIZE = parseInt(teamSizeInput);

        const installDateStr = telemetry.getInstallDate();
        const firstDate = new Date(installDateStr);
        const weeksActive = Math.max(1,
          (Date.now() - firstDate.getTime()) / (7 * 24 * 60 * 60 * 1000)
        );

        const weeklyFunctions = Number((stats.functionsCovered / weeksActive).toFixed(1));
        const weeklyHoursSaved = Number((weeklyFunctions * MINS_PER_FUNCTION / 60).toFixed(1));
        const annualImpact = Math.round(weeklyHoursSaved * 52 * TEAM_SIZE * HOURLY_RATE);
        const grossHours = Number((stats.successfulGenerations * 15 / 60).toFixed(1));
        const repairTaxHours = Number((stats.failedGenerations * 5 / 60).toFixed(1));

        vscode.window.showInformationMessage(
          `SilentSpec — Team ROI Report\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Gross Time Saved:    ${grossHours} hrs\n` +
          `AI Repair Tax:      -${repairTaxHours} hrs (${stats.failedGenerations} failed)\n` +
          `NET Time Reclaimed:  ${stats.estimatedHoursSaved} hrs\n` +
          `Reliability Rate:    ${reliabilityRate}%\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Weekly Velocity Boost:  ${weeklyHoursSaved} hrs/dev\n` +
          `Annual Team Impact:    ~$${annualImpact.toLocaleString()}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `Assumptions: ${MINS_PER_FUNCTION} min/function · $${HOURLY_RATE}/hr · ${TEAM_SIZE}-dev team\n` +
          `Methodology: Microsoft Research dev productivity benchmarks (2019)`,
          { modal: true },
          'OK'
        );
      }
    }
  );
  context.subscriptions.push(statsCmd);

  // Manual generate — triggers full generation via save pipeline
  const generateNowCmd = vscode.commands.registerCommand(
    'silentspec.generateNow',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('SilentSpec: No active file open');
        return;
      }
      if (/\.(test|spec)\.[tj]sx?$/.test(editor.document.uri.fsPath)) {
        vscode.window.showWarningMessage('SilentSpec: Cannot generate tests for a test file');
        return;
      }
      await vscode.workspace.save(editor.document.uri);
    }
  );
  context.subscriptions.push(generateNowCmd);

  // Gap Finder command
  const gapFinderCmd = vscode.commands.registerCommand(
    'silentspec.findGaps',
    async () => {
      await runGapFinder(
        (msg: string) => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`),
        async (prompt, filePath, log, abortSignal, isMerge, exportedFunctions, exportTypes) => {
          processingQueue.enqueue(async () => {
            const providerName = await getActiveProviderName();
            lastUsedProvider = providerName;
            updateStatusBar();
            const provider = await getActiveProvider();

            const canProceed = await checkCostAcknowledgement(context, providerName);
            if (!canProceed) {
              updateStatusBar('$(info) SS: Cancelled');
              setTimeout(() => updateStatusBar(), 3000);
              return;
            }

            log(`Gap Finder: calling ${providerName}...`);
            updateStatusBar('$(sync~spin) SS: Generating...');

            const controller = new AbortController();
            activeControllers.add(controller);

            try {
              const raw = await provider.generateTests(prompt, log, controller.signal);

              if (!raw) {
                telemetry.recordFailure(providerName);
                updateStatusBar('$(warning) SS: Failed');
                setTimeout(() => updateStatusBar(), 3000);
                return;
              }

              const validated = validateResponse(raw, log);
              if (!validated) {
                telemetry.recordFailure(providerName);
                updateStatusBar('$(warning) SS: Failed');
                setTimeout(() => updateStatusBar(), 3000);
                return;
              }

              const specPath = await resolveSpecPath(filePath);
              const fixedValidated = fixImportStatement(
                validated,
                filePath,
                specPath,
                exportedFunctions,
                exportTypes,
                log
              );

              if (fixedValidated !== validated) {
                log('Gap Finder: import statement corrected — default/named export mismatch fixed');
              }

              const healResult = healSpec(fixedValidated, path.basename(specPath), filePath, log);
              const finalContent = healResult.wasHealed ? healResult.healed : fixedValidated;
              if (healResult.wasHealed) {
                log(`Healer: removed ${healResult.healedCount} failing test(s): ${healResult.removedTests.join(', ')}`);
              }

              if (isMerge) {
                await mergeSpecFile(filePath, finalContent, log);
              } else {
                await writeSpecFile(filePath, finalContent, log);
              }

              const fnCount = (fixedValidated.match(/describe\(/g) || []).length;
              telemetry.recordSuccess(providerName, fnCount);

              updateStatusBar('$(check) SS: Done');
              setTimeout(() => updateStatusBar(), 3000);
            } finally {
              activeControllers.delete(controller);
            }
          });
        }
      );
    }
  );
  context.subscriptions.push(gapFinderCmd);

  // Register save handler
  registerSaveHandler(context, () => isPaused, updateStatus, async (
    prompt,
    filePath,
    log,
    abortSignal,
    exportedFunctions,
    exportTypes
  ) => {
    processingQueue.enqueue(async () => {
      const providerName = await getActiveProviderName();
      lastUsedProvider = providerName;
      updateStatusBar();
      const provider = await getActiveProvider();

      const canProceed = await checkCostAcknowledgement(context, providerName);
      if (!canProceed) {
        updateStatusBar('$(info) SS: Cancelled');
        setTimeout(() => updateStatusBar(), 3000);
        return;
      }

      log(`Calling ${providerName} for ${filePath}...`);
      updateStatusBar('$(sync~spin) SS: Generating...');

      const controller = new AbortController();
      activeControllers.add(controller);

      abortSignal.addEventListener('abort', () => controller.abort());

      try {
        const raw = await provider.generateTests(prompt, log, controller.signal);

        if (!raw) {
          telemetry.recordFailure(providerName);
          updateStatusBar('$(warning) SS: Failed');
          setTimeout(() => updateStatusBar(), 3000);
          return;
        }

        const validated = validateResponse(raw, log);
        if (!validated) {
          telemetry.recordFailure(providerName);
          updateStatusBar('$(warning) SS: Failed');
          setTimeout(() => updateStatusBar(), 3000);
          return;
        }

        const specPath = await resolveSpecPath(filePath);
        const fixedValidated = fixImportStatement(
          validated,
          filePath,
          specPath,
          exportedFunctions,
          exportTypes,
          log
        );

        if (fixedValidated !== validated) {
          log('Import statement corrected — default/named export mismatch fixed');
        }

        // Extract covered function names from describe blocks for header
        const coveredFunctions = (
          fixedValidated.match(/describe\(['"`]([^'"`]+)['"`]/g) || []
        ).map(m => m.replace(/describe\(['"`]/, '').replace(/['"`]$/, ''));

        // Auto-heal: remove failing it() blocks using TypeScript compiler API
        const healResult = healSpec(fixedValidated, path.basename(specPath), filePath, log);
        const finalContent = healResult.wasHealed ? healResult.healed : fixedValidated;
        if (healResult.wasHealed) {
          log(`Healer: removed ${healResult.healedCount} failing test(s): ${healResult.removedTests.join(', ')}`);
          telemetry.recordHealing(healResult.healedCount);
        }

        log(`Response validated — writing spec file for ${filePath}`);
        await writeSpecFile(filePath, finalContent, log, coveredFunctions);

        // Auto-trigger Gap Finder if partial generation
        if (fixedValidated.includes('// [SS-PARTIAL]')) {
          log(`Partial generation detected — auto-triggering Gap Finder for remaining functions`);
          updateStatusBar('$(sync~spin) SS: Filling gaps...');
          void vscode.commands.executeCommand('silentspec.findGaps');
        }

        // Telemetry
        telemetry.recordSuccess(providerName, coveredFunctions.length);

        // First-run success notification — shown once ever
        const firstSuccess = context.globalState.get<boolean>(
          'silentspec.firstSuccessShown', false
        );
        if (!firstSuccess) {
          await context.globalState.update('silentspec.firstSuccessShown', true);
          void vscode.window.showInformationMessage(
            `SilentSpec generated tests for ${path.basename(filePath)} ✓`,
            'Open Test File'
          ).then(async action => {
            if (action === 'Open Test File') {
              const specPath = await resolveSpecPath(filePath);
              void vscode.window.showTextDocument(
                vscode.Uri.file(specPath),
                { viewColumn: vscode.ViewColumn.Beside }
              );
            }
          });
        }

        if (!fixedValidated.includes('// [SS-PARTIAL]')) {
          updateStatusBar('$(check) SS: Done');
          setTimeout(() => updateStatusBar(), 3000);
        }

      } finally {
        activeControllers.delete(controller);
      }
    });
  });

  context.subscriptions.push(outputChannel);
}

export function deactivate() {
  for (const controller of activeControllers) {
    controller.abort();
  }
  activeControllers.clear();
}