import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeFile } from './astAnalyzer';
import { registerSaveHandler, outputChannel, lastProcessedHash, lastProcessedTime, FRAMEWORK_DISPLAY_CMDS, checkedRoots } from './saveHandler';
import { AIProvider } from './ai/aiProvider';
import { OpenAIProvider } from './ai/openaiProvider';
import { ClaudeProvider } from './ai/claudeProvider';
import { OllamaProvider } from './ai/ollamaProvider';
import { GitHubModelsProvider } from './ai/githubModelsProvider';
import { validateResponse } from './utils/validateResponse';
import { processingQueue } from './utils/processingQueue';
import { writeSpecFile, appendGapTests, resolveSpecPath, updateMarker } from './fileWriter';
import { runGapFinder } from './gapFinder';
import { buildPrompt } from './promptBuilder';
import { extractContext, SilentSpecContext } from './contextExtractor';
import { TelemetryService } from './telemetry';
import { healSpec } from './utils/specHealer';
import {
  SSMarker,
  readMarker,
  reconcile,
  computeWorkList,
  verifyGenerated,
  buildUpdatedMarker,
  rebuildMarkerFromContent,
  DEFAULT_MAX_FUNCTIONS_PER_RUN,
  MAX_RETRIES_PER_FUNCTION,
} from './utils/markerManager';

const activeControllers = new Set<AbortController>();
let costCheckInProgress = false;
let cachedOllamaRunning: boolean | null = null;
// Project roots where the "Copy Fix Command" notification has been shown this session.
// Prevents repeated notifications on every save when @types is missing.
const typesWarningShownRoots = new Set<string>();
// Project roots where the tsconfig types-array warning has been shown this session.
const tsconfigWarningShownRoots = new Set<string>();
const processingLock = new Set<string>();
// Files where a generation-failure toast was shown this session.
// Cleared on success so the next failure after a fix still surfaces.
const failureNotifiedFiles = new Set<string>();
const MAX_QUEUE_DEPTH = 5;
// Tracks concurrent generations — status bar only transitions to Done/Partial/Error
// when this reaches 0, preventing flicker when two files save simultaneously.
let activeGenerations = 0;

// Adaptive batch sizing — scales down for large files to avoid token overflow.
// Uses file content length as a proxy since AST has no per-function line counts.
// MAX_ADAPTIVE_CAP is the ceiling when file is small; falls to 5 on large files.
const MAX_ADAPTIVE_CAP = 8;

function getAdaptiveBatchSize(fileContentLength: number, userMax: number): number {
  // Large files (>12k chars) carry more context per function — cap at 5.
  // Small files can safely generate up to MAX_ADAPTIVE_CAP functions per batch.
  const cap = fileContentLength > 12_000 ? 5 : MAX_ADAPTIVE_CAP;
  return Math.min(cap, userMax);
}
const pendingRetryCount = new Map<string, number>();

function incrementRetryIfPreviouslyPending(fn: string, previousPending: string[]): number {
  if (!previousPending.includes(fn)) { pendingRetryCount.set(fn, 1); return 1; }
  const count = (pendingRetryCount.get(fn) ?? 1) + 1;
  pendingRetryCount.set(fn, count);
  return count;
}

function resetRetry(fn: string): void { pendingRetryCount.delete(fn); }

function filterRetryable(nowPending: string[], previousPending: string[], log: (msg: string) => void): string[] {
  const retryable: string[] = [];
  for (const fn of nowPending) {
    const count = incrementRetryIfPreviouslyPending(fn, previousPending);
    if (count <= MAX_RETRIES_PER_FUNCTION) {
      retryable.push(fn);
    } else {
      log(`Retry cap reached for "${fn}" after ${MAX_RETRIES_PER_FUNCTION} attempts — dropping`);
      pendingRetryCount.delete(fn);
    }
  }
  return retryable;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, log: (msg: string) => void): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => { log(`${label}: timed out after ${timeoutMs / 1000}s`); resolve(null); }, timeoutMs); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer!); }
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  github: 'GitHub Models',
  ollama: 'Ollama',
};

type FailureKind = { reason: string; isAuth: boolean };

function classifyProviderError(err: unknown, timedOut: boolean): FailureKind {
  if (timedOut) { return { reason: 'Request timed out',    isAuth: false }; }
  if (err === null || err === undefined) { return { reason: 'Unexpected error', isAuth: false }; }
  const msg = String(err).toLowerCase();
  if (/\b529\b/.test(msg))                                { return { reason: 'API overloaded',        isAuth: false }; }
  if (/\b(401|403)\b/.test(msg) ||
      /unauthorized|forbidden/.test(msg))                 { return { reason: 'Authentication failed', isAuth: true  }; }
  if (/fetch|network|econnrefused|enotfound/.test(msg))   { return { reason: 'Network error',         isAuth: false }; }
  return { reason: 'Unexpected error', isAuth: false };
}

function showProviderFailureToast(filePath: string, providerName: string, kind: FailureKind): void {
  if (failureNotifiedFiles.has(filePath)) { return; }
  failureNotifiedFiles.add(filePath);
  const display = PROVIDER_DISPLAY_NAMES[providerName] ?? providerName;
  const msg = `SilentSpec: ${display} generation failed — ${kind.reason}. Save the file again to retry.`;
  if (kind.isAuth) {
    void vscode.window.showErrorMessage(msg);
  } else {
    void vscode.window.showWarningMessage(msg);
  }
}

async function isOllamaRunning(): Promise<boolean> {
  try { const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}

async function checkCostAcknowledgement(context: vscode.ExtensionContext, providerName: string): Promise<boolean> {
  if (providerName !== 'claude' && providerName !== 'openai') { return true; }
  if (costCheckInProgress) { return false; }
  const key = `silentspec.${providerName}.costAcknowledged`;
  const acknowledged = context.globalState.get<boolean>(key, false);
  if (acknowledged) { return true; }
  costCheckInProgress = true;
  const action = await vscode.window.showWarningMessage(
    `SilentSpec will use your ${providerName === 'claude' ? 'Claude (Anthropic)' : 'OpenAI'} API key. Typical cost is ~$0.003 per generation.`,
    'I understand — continue', 'Cancel'
  );
  costCheckInProgress = false;
  if (action !== 'I understand — continue') { return false; }
  await context.globalState.update(key, true);
  return true;
}

function getProvider(context: vscode.ExtensionContext, providerOverride?: string): AIProvider {
  const config = vscode.workspace.getConfiguration('silentspec');
  const providerName = providerOverride ?? config.get<string>('provider', 'github');
  const modelOverride = config.get<string>('model', '') || undefined;
  if (providerName === 'openai') { return new OpenAIProvider(modelOverride).withSecrets(context.secrets); }
  if (providerName === 'claude') { return new ClaudeProvider(modelOverride).withSecrets(context.secrets); }
  if (providerName === 'github') { return new GitHubModelsProvider(modelOverride).withSecrets(context.secrets); }
  return new OllamaProvider(modelOverride);
}

// Adds the framework type entry to compilerOptions.types in tsconfig.json.
// Reads as JSONC (strips comments), modifies, writes back as formatted JSON.
// Called from the "Fix tsconfig automatically" button in the tsconfig warning notification.
// Returns true on success, false on failure (caller handles notifications).
async function fixTsconfigTypes(projectRoot: string, framework: string): Promise<boolean> {
  const tsconfigUri = vscode.Uri.file(path.join(projectRoot, 'tsconfig.json'));
  try {
    const raw = await vscode.workspace.fs.readFile(tsconfigUri);
    const text = Buffer.from(raw).toString('utf8');
    const stripped = text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const tsconfig = JSON.parse(stripped) as Record<string, unknown>;
    const compilerOptions = ((tsconfig['compilerOptions'] ?? {}) as Record<string, unknown>);
    const existing = [...((compilerOptions['types'] as string[] | undefined) ?? [])];
    if (!existing.includes(framework) && !existing.includes(`@types/${framework}`)) {
      existing.push(framework);
    }
    compilerOptions['types'] = existing;
    tsconfig['compilerOptions'] = compilerOptions;
    const updated = JSON.stringify(tsconfig, null, 2) + '\n';
    const doc = await vscode.workspace.openTextDocument(tsconfigUri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(tsconfigUri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), updated);
    await vscode.workspace.applyEdit(edit);
    return true;
  } catch {
    return false;
  }
}

function fixImportStatement(validated: string, filePath: string, specPath: string, exportedFunctions: string[], exportTypes: Record<string, 'default' | 'named'>, log: (msg: string) => void): string {
  const sourceBaseName = path.basename(filePath, path.extname(filePath));
  const specDir = path.dirname(specPath);
  const sourceDir = path.dirname(filePath);
  let relativePath = path.relative(specDir, path.join(sourceDir, sourceBaseName));
  if (!relativePath.startsWith('.')) { relativePath = './' + relativePath; }
  const defaultExport = exportedFunctions.find(f => exportTypes[f] === 'default');
  const namedExports = exportedFunctions.filter(f => exportTypes[f] === 'named');
  const namedPart = namedExports.length > 0 ? `{ ${namedExports.join(', ')} }` : '';
  let correctImport: string;
  if (defaultExport && namedPart) { correctImport = `import ${defaultExport}, ${namedPart} from '${relativePath}';`; }
  else if (defaultExport) { correctImport = `import ${defaultExport} from '${relativePath}';`; }
  else { correctImport = `import ${namedPart} from '${relativePath}';`; }
  const filenameNoExt = sourceBaseName.replace(/\.[tj]sx?$/, '');
  const escapedFilename = filenameNoExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nuclearRegex = new RegExp(
    `import\\s+[\\s\\S]*?\\s+from\\s+['"](?:\\.\\./|\\./)(?:[^'"]*/)*${escapedFilename}['"];?`,
    'gm'
  );
  if (nuclearRegex.test(validated)) { log(`Import corrected for ${filenameNoExt}`); return validated.replace(nuclearRegex, correctImport); }
  log(`Warning: no import found for ${filenameNoExt} — injecting after SS-GENERATED-START`);
  return validated.replace(/\/\/ <SS-GENERATED-START[^\n]*/, (match) => `${match}\n${correctImport}`);
}

async function runOneGapBatch(
  filePath: string, exportedFunctions: string[], exportTypes: Record<string, 'default' | 'named'>,
  previousPending: string[], provider: AIProvider, providerName: string,
  context: vscode.ExtensionContext, telemetry: TelemetryService,
  log: (msg: string) => void, updateStatusBar: (text?: string) => void,
  healerMode?: 'full' | 'safe'
): Promise<string[]> {
  const specPath = await resolveSpecPath(filePath);
  let existingMarker = null;
  try { const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath)); const { marker } = readMarker(Buffer.from(bytes).toString('utf8')); existingMarker = marker; } catch { /* no existing spec */ }
  const reconciled = reconcile(existingMarker, exportedFunctions);
  const maxPerRun = vscode.workspace.getConfiguration('silentspec').get<number>('maxFunctionsPerRun', DEFAULT_MAX_FUNCTIONS_PER_RUN);
  const workList = computeWorkList(reconciled, maxPerRun);
  if (workList.length === 0) { log('Gap batch: all functions covered'); return []; }
  const astResult = analyzeFile(filePath, log);
  if (!astResult.isTestable) { log('Gap batch: source is no longer testable — stopping'); return []; }
  const ctx = extractContext(filePath, workList, astResult.imports, log, exportTypes);
  ctx.specPath = specPath;
  ctx.healerMode = healerMode;
  const prompt = buildPrompt(ctx);
  const AI_TIMEOUT_MS = vscode.workspace.getConfiguration('silentspec').get<number>('aiTimeoutSeconds', 60) * 1000;
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    log(`Gap batch: calling ${providerName} for [${workList.join(', ')}]...`);
    const raw = await withTimeout(provider.generateTests(prompt, log, controller.signal), AI_TIMEOUT_MS, 'Gap batch', log);
    if (!raw) {
      telemetry.recordFailure(providerName, 'provider_error');
      log('[SilentSpec] Spec written: no');
      log('[SilentSpec] Spec compile-ready: no');
      log('[SilentSpec] Reason: provider returned null response');
      return [];
    }
    // validateResponse handles truncation — returns null if output is truncated or unbalanced
    const validated = validateResponse(raw, log);
    if (!validated) {
      telemetry.recordFailure(providerName, 'invalid_response');
      log('[SilentSpec] Spec written: no');
      log('[SilentSpec] Spec compile-ready: no');
      log('[SilentSpec] Reason: AI response failed validation');
      return previousPending;
    }
    const fixedValidated = fixImportStatement(validated, filePath, specPath, exportedFunctions, exportTypes, log);
    if (fixedValidated !== validated) { log('Gap batch: import corrected'); }
    const { nowCovered, nowPending } = verifyGenerated(fixedValidated, workList);
    log(`Gap batch verified — covered: [${nowCovered.join(', ')}] pending: [${nowPending.join(', ')}]`);
    if (nowCovered.length === 0 && workList.length > 0) { telemetry.recordFailure(providerName, 'no_describe_found'); }
    nowCovered.forEach(fn => resetRetry(fn));
    const healResult = healSpec(fixedValidated, path.basename(specPath), filePath, log, ctx.healerMode, ctx.framework);
    const finalContent = healResult.wasHealed ? healResult.healed : fixedValidated;
    if (healResult.wasHealed) { log(`Healer: removed ${healResult.healedCount} test(s) — reasons: ${JSON.stringify(healResult.removedTestReasons)}`); telemetry.recordHealing(healResult.healedCount, 0); }
    const updatedMarker = buildUpdatedMarker(reconciled.covered, nowCovered, nowPending);
    await appendGapTests(filePath, finalContent, updatedMarker, log);
    telemetry.recordSuccess(providerName, nowCovered, nowPending);
    const gapSpecCompileReady = !healResult.missingTypes && !healResult.hasGlobalErrors;
    const gapSpecReason = healResult.missingTypes
      ? `missing ${ctx.framework} typings`
      : healResult.hasGlobalErrors
        ? 'global TypeScript errors'
        : 'ok';
    log(`[SilentSpec] Spec written: yes`);
    log(`[SilentSpec] Spec compile-ready: ${gapSpecCompileReady ? 'yes' : 'no'}`);
    log(`[SilentSpec] Reason: ${gapSpecReason}`);
    return nowPending;
  } finally { activeControllers.delete(controller); }
}

export function activate(context: vscode.ExtensionContext) {
  let installDate = context.globalState.get<string>('silentspec.installDate');
  if (!installDate) {
    installDate = new Date().toISOString();
    context.globalState.update('silentspec.installDate', installDate);
    void (async () => {
      const action = await vscode.window.showInformationMessage('Welcome to SilentSpec! Save any TypeScript file to auto-generate tests.', 'View README', 'Set API Key');
      if (action === 'View README') { void vscode.env.openExternal(vscode.Uri.parse('https://github.com/bharadwajmadduri/silent-spec#readme')); }
      else if (action === 'Set API Key') { void vscode.commands.executeCommand('silentspec.setApiKey'); }
    })();
  }

  const telemetry = new TelemetryService(context, installDate);
  void isOllamaRunning().then(running => { cachedOllamaRunning = running; });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'silentspec.togglePause';
  let isPaused = context.workspaceState.get<boolean>('silentspec.paused', false);
  let lastUsedProvider = vscode.workspace.getConfiguration('silentspec').get<string>('provider', 'github');

  function updateStatusBar(text?: string) {
    if (text) { statusBar.text = text; statusBar.backgroundColor = undefined; return; }
    statusBar.text = isPaused ? '$(debug-pause) Paused' : `SilentSpec $(check) — ${lastUsedProvider}`;
    statusBar.tooltip = isPaused ? 'SilentSpec paused — click to resume' : `SilentSpec active — using ${lastUsedProvider}. Click to pause.`;
    statusBar.backgroundColor = isPaused ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  // Session-only dedup for the "environment not ready" fallback notification.
  // Kept separate from typesWarningShownRoots so showTypesWarningIfNeeded is the
  // sole mutator of that Set and workspaceState-cleared roots can resurface correctly.
  const envNotReadyShownRoots = new Set<string>();

  // Unified types-warning notification helper.
  // Shows once per project root per session (typesWarningShownRoots).
  // "Copy Fix Command" — copies command, keeps session dedup (won't show again this session).
  // "Dismiss" or closed — removes from session set so the warning reappears on the next save.
  // Returns true if the notification was shown, false if suppressed by session dedup.
  // Callers use the return value to decide whether to show the "environment not ready" fallback.
  function showTypesWarningIfNeeded(projectRoot: string, framework: string, installAttempted: boolean): boolean {
    if (typesWarningShownRoots.has(projectRoot)) { return false; }
    typesWarningShownRoots.add(projectRoot);
    const displayCmd = FRAMEWORK_DISPLAY_CMDS[framework] ?? FRAMEWORK_DISPLAY_CMDS['jest'];
    const msg = installAttempted
      ? `SilentSpec tried to install ${framework} types automatically but failed. Please run manually: ${displayCmd}`
      : `SilentSpec detected ${framework} but test type definitions are missing. Suggested fix: ${displayCmd}`;
    void vscode.window.showWarningMessage(msg, 'Copy Fix Command', 'Dismiss')
      .then(choice => {
        if (choice === 'Copy Fix Command') {
          void vscode.env.clipboard.writeText(displayCmd);
        } else {
          // 'Dismiss' or notification closed without clicking — remove from session
          // set so the warning reappears on the next save.
          typesWarningShownRoots.delete(projectRoot);
        }
      });
    return true;
  }

  function updateStatus(text: string): void {
    if (!text) { updateStatusBar(); return; }
    statusBar.text = text;
    statusBar.tooltip = 'SilentSpec only generates tests for exported functions.';
    statusBar.backgroundColor = undefined;
  }

  function getActiveProvider(): AIProvider {
    const config = vscode.workspace.getConfiguration('silentspec');
    const configuredProvider = config.get<string>('provider', 'github');
    if (configuredProvider === 'github' && cachedOllamaRunning === true) { return getProvider(context, 'ollama'); }
    return getProvider(context);
  }

  function getActiveProviderName(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    const configuredProvider = config.get<string>('provider', 'github');
    if (configuredProvider === 'github' && cachedOllamaRunning === true) { return 'ollama'; }
    return configuredProvider;
  }

  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.togglePause', async () => {
    isPaused = !isPaused;
    await context.workspaceState.update('silentspec.paused', isPaused);
    updateStatusBar();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.setApiKey', async () => {
    const provider = await vscode.window.showQuickPick(['claude', 'openai', 'github'], { placeHolder: 'Select provider to set API key for' });
    if (!provider) { return; }
    const key = await vscode.window.showInputBox({ prompt: `Enter your ${provider === 'claude' ? 'Anthropic' : provider === 'github' ? 'GitHub' : 'OpenAI'} API key`, password: true, ignoreFocusOut: true, placeHolder: provider === 'claude' ? 'sk-ant-...' : provider === 'github' ? 'ghp_...' : 'sk-...' });
    if (!key || key.trim().length === 0) { return; }
    const secretKey = provider === 'claude' ? 'silentspec.claudeApiKey' : provider === 'github' ? 'silentspec.githubToken' : 'silentspec.openaiApiKey';
    await context.secrets.store(secretKey, key.trim());
    vscode.window.showInformationMessage(`SilentSpec: ${provider === 'claude' ? 'Claude' : provider === 'github' ? 'GitHub' : 'OpenAI'} API key saved`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.openLog', () => outputChannel.show()));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.showStats', async () => {
    const stats = telemetry.getStats();
    const avgRetries = telemetry.getAvgRetries();
    const healRate = telemetry.getHealSuccessRate();
    const failSummary = telemetry.getFailureSummary();
    const lastDate = stats.lastGeneratedAt === 'none' ? 'never' : new Date(stats.lastGeneratedAt).toLocaleDateString();
    const reliabilityRate = stats.totalGenerations > 0 ? Math.round((stats.successfulGenerations / stats.totalGenerations) * 100) : 0;
    const selection = await vscode.window.showInformationMessage(
      `$(zap) SilentSpec — Your Impact\nFunctions Covered: ${stats.functionsCovered}\nTests Auto-Healed: ${stats.testsHealed ?? 0} removed, ${stats.testsHealedSuccessfully ?? 0} repaired\nHeal Success Rate: ${healRate}%\nTime Reclaimed: ${stats.estimatedHoursSaved} hrs (net)\nReliability: ${reliabilityRate}% (${stats.successfulGenerations}/${stats.totalGenerations})\nAvg Retries/fn: ${avgRetries}\nFailure Breakdown: ${failSummary}\nLast Provider: ${stats.lastProvider} · ${lastDate}`,
      { modal: false }, 'Team ROI Report'
    );
    if (selection === 'Team ROI Report') {
      const MINS_PER_FUNCTION = 15; const HOURLY_RATE = 85;
      const teamSizeInput = await vscode.window.showInputBox({ prompt: 'How many developers on your team?', placeHolder: '5', value: '5', validateInput: (val) => { const n = parseInt(val); if (isNaN(n) || n < 1 || n > 10000) { return 'Enter a number between 1 and 10000'; } return null; } });
      if (!teamSizeInput) { return; }
      const TEAM_SIZE = parseInt(teamSizeInput);
      const firstDate = new Date(telemetry.getInstallDate());
      const weeksActive = Math.max(1, (Date.now() - firstDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
      const weeklyFns = Number((stats.functionsCovered / weeksActive).toFixed(1));
      const weeklyHrs = Number((weeklyFns * MINS_PER_FUNCTION / 60).toFixed(1));
      const annualImpact = Math.round(weeklyHrs * 52 * TEAM_SIZE * HOURLY_RATE);
      const grossHours = Number((stats.successfulGenerations * 15 / 60).toFixed(1));
      const repairTax = Number((stats.failedGenerations * 5 / 60).toFixed(1));
      const problematic = telemetry.getProblematicFunctions(3);
      const probStr = problematic.length > 0 ? problematic.map(p => `${p.fn} (${p.successRate}% success, ${p.attempts} attempts)`).join(', ') : 'none';
      vscode.window.showInformationMessage(
        `SilentSpec — Team ROI Report\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nGross Time Saved: ${grossHours} hrs\nAI Repair Tax: -${repairTax} hrs\nNET Time Reclaimed: ${stats.estimatedHoursSaved} hrs\nReliability Rate: ${reliabilityRate}%\nAvg Retries / fn: ${avgRetries}\nHeal Success Rate: ${healRate}%\nFailure Breakdown: ${failSummary}\nProblematic Functions: ${probStr}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nWeekly Velocity Boost: ${weeklyHrs} hrs/dev\nAnnual Team Impact: ~$${annualImpact.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nAssumptions: ${MINS_PER_FUNCTION} min/fn · $${HOURLY_RATE}/hr · ${TEAM_SIZE}-dev team`,
        { modal: true }, 'OK'
      );
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.generateNow', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('SilentSpec: No active file open'); return; }
    if (/\.(test|spec)\.[tj]sx?$/.test(editor.document.uri.fsPath)) { vscode.window.showWarningMessage('SilentSpec: Cannot generate tests for a test file'); return; }
    await vscode.workspace.save(editor.document.uri);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.rebuildMarker', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('SilentSpec: No active file open'); return; }
    const filePath = editor.document.uri.fsPath;
    if (/\.(test|spec)\.[tj]sx?$/.test(filePath)) { vscode.window.showWarningMessage('SilentSpec: Open the source file, not the test file'); return; }
    const log = (msg: string) => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
    try {
      const result = analyzeFile(filePath, log);
      if (!result.isTestable) { vscode.window.showWarningMessage('SilentSpec: No testable exports found'); return; }
      const specPath = await resolveSpecPath(filePath);
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath));
      const specContent = Buffer.from(bytes).toString('utf8');
      const rebuilt = rebuildMarkerFromContent(specContent, result.exportedFunctions);
      if (!rebuilt) { vscode.window.showWarningMessage('SilentSpec: No SS-GENERATED block found — save the source file first'); return; }
      await updateMarker(filePath, rebuilt, log);
      const total = result.exportedFunctions.length;
      log(`Marker rebuilt — ${rebuilt.covered.length}/${total} covered, ${rebuilt.pending.length} pending`);
      vscode.window.showInformationMessage(`SilentSpec: Marker rebuilt — ${rebuilt.covered.length}/${total} covered${rebuilt.pending.length > 0 ? `, ${rebuilt.pending.length} pending` : ' ✓'}`);
      if (rebuilt.pending.length > 0) {
        const action = await vscode.window.showInformationMessage(`SilentSpec: ${rebuilt.pending.length} function(s) missing tests. Generate now?`, 'Yes', 'No');
        if (action === 'Yes') { void vscode.commands.executeCommand('silentspec.findGaps'); }
      }
    } catch (error: unknown) { const msg = error instanceof Error ? error.message : String(error); vscode.window.showErrorMessage(`SilentSpec: Rebuild failed — ${msg}`); }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.explainFailure', async () => {
    const stats = telemetry.getStats();
    const problematic = telemetry.getProblematicFunctions(10);
    if (problematic.length === 0) { vscode.window.showInformationMessage('SilentSpec: No problematic functions found'); return; }
    const items = problematic.map(p => `${p.fn} — ${p.successRate}% success rate (${p.attempts} attempts)`);
    const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a function to see failure details' });
    if (!selected) { return; }
    const fnName = selected.split(' — ')[0];
    const record = stats.functionAttempts[fnName];
    if (!record) { vscode.window.showInformationMessage(`SilentSpec: No data for "${fnName}"`); return; }
    const failureRate = Math.round(((record.attempts - record.successes) / record.attempts) * 100);
    const retryCount = pendingRetryCount.get(fnName) ?? 0;
    vscode.window.showInformationMessage(
      `SilentSpec — Failure Report: ${fnName}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nAttempts: ${record.attempts}\nSuccesses: ${record.successes}\nFailure Rate: ${failureRate}%\nActive Retries (this session): ${retryCount}\nSystem Failure Breakdown: ${telemetry.getFailureSummary()}`,
      { modal: true }, 'OK'
    );
  }));

  context.subscriptions.push(vscode.commands.registerCommand('silentspec.findGaps', async () => {
    await runGapFinder(
      (msg: string) => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`),
      async (_ctx: SilentSpecContext, filePath, log, abortSignal, exportedFunctions, exportTypes) => {
        if (processingQueue.size >= MAX_QUEUE_DEPTH) { log(`Gap Finder: queue full (${processingQueue.size}/${MAX_QUEUE_DEPTH}) — skipping`); return; }
        processingQueue.enqueue(async () => {
          if (abortSignal.aborted) { log('Gap Finder: aborted before execution — skipping'); return; }
          const providerName = await getActiveProviderName();
          lastUsedProvider = providerName;
          updateStatusBar();
          const provider = await getActiveProvider();
          const canProceed = await checkCostAcknowledgement(context, providerName);
          if (!canProceed) { updateStatusBar('$(circle-slash) Skipped: cancelled'); setTimeout(() => updateStatusBar(), 3000); return; }
          let pendingToResume = await runOneGapBatch(filePath, exportedFunctions, exportTypes, [], provider, providerName, context, telemetry, log, updateStatusBar, 'full');
          while (pendingToResume.length > 0) {
            const retryable = filterRetryable(pendingToResume, pendingToResume, log);
            if (retryable.length === 0) { log('Gap Finder: all pending functions hit retry cap — stopping'); break; }
            log(`Gap Finder: ${retryable.length} function(s) pending — continuing loop...`);
            updateStatusBar(`$(sync~spin) Generating... (${retryable.length} pending)...`);
            pendingToResume = await runOneGapBatch(filePath, exportedFunctions, exportTypes, pendingToResume, provider, providerName, context, telemetry, log, updateStatusBar, 'full');
          }
          log('Gap Finder: done');
          updateStatusBar('$(check) Done');
          setTimeout(() => updateStatusBar(), 3000);
        });
      }
    );
  }));

  // ── Save handler — main generation pipeline ──────────────────────────────

  registerSaveHandler(context, () => isPaused, updateStatus, async (ctx: SilentSpecContext, filePath, log, abortSignal, exportedFunctions, exportTypes) => {
    if (processingLock.has(filePath)) { log(`Skipped: already processing ${path.basename(filePath)}`); return; }
    if (processingQueue.size >= MAX_QUEUE_DEPTH) { log(`Skipped: queue full (${processingQueue.size}/${MAX_QUEUE_DEPTH}) — ${path.basename(filePath)}`); return; }

    processingQueue.enqueue(async () => {
      if (abortSignal.aborted) { log(`Skipped: aborted before execution — ${path.basename(filePath)}`); return; }
      processingLock.add(filePath);
      try {
        const specPath = ctx.specPath ?? await resolveSpecPath(filePath);
        let existingCovered: string[] = [];
        let previousPending: string[] = [];
        try { const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath)); const { marker } = readMarker(Buffer.from(bytes).toString('utf8')); existingCovered = marker?.covered ?? []; previousPending = marker?.pending ?? []; } catch { /* first run */ }

        const reconciled = reconcile(
          existingCovered.length > 0 || previousPending.length > 0 ? { version: 1, covered: existingCovered, pending: previousPending } : null,
          exportedFunctions
        );
        if (reconciled.gaps.length === 0 && reconciled.pending.length === 0) { log(`Skipped: all ${exportedFunctions.length} functions covered — no generation needed`); updateStatus(''); return; }

        // Determine provider before batch sizing — GitHub Models needs a lower cap.
        const providerName = await getActiveProviderName();
        lastUsedProvider = providerName;
        updateStatusBar();

        // Compute the work list — at most maxFunctionsPerRun functions this batch.
        // Stamp it onto ctx so buildFunctionSection/buildSignatureSection use only
        // these functions, while buildImportSection keeps the full exportedFunctions
        // list for a correct import statement that covers all previously-written tests.
        const maxPerRun = vscode.workspace.getConfiguration('silentspec').get<number>('maxFunctionsPerRun', DEFAULT_MAX_FUNCTIONS_PER_RUN);
        let batchSize   = getAdaptiveBatchSize(ctx.fileContent.length, maxPerRun);
        if (providerName === 'github') {
          // Files with many exports produce longer output — use a tighter cap
          // to prevent gpt-4o from truncating mid-test on the output token limit.
          const githubCap = exportedFunctions.length > 5 ? 2 : 3;
          if (batchSize > githubCap) {
            log(`Batch size capped at ${githubCap} for GitHub Models (output token limit, ${exportedFunctions.length} fns)`);
            batchSize = githubCap;
          }
        }
        const workList     = computeWorkList(reconciled, batchSize);
        if (workList.length === 0) { log('Skipped: work list is empty after reconcile'); updateStatus(''); return; }
        ctx.workList = workList;
        log(`Batch size: ${batchSize} (file: ${ctx.fileContent.length} chars, user max: ${maxPerRun})`);
        log(`Work list: [${workList.join(', ')}] (${workList.length}/${exportedFunctions.length} functions)`);
        const prompt = buildPrompt(ctx);

        const provider = await getActiveProvider();
        const canProceed = await checkCostAcknowledgement(context, providerName);
        if (!canProceed) { updateStatusBar('$(circle-slash) Skipped: cancelled'); setTimeout(() => updateStatusBar(), 3000); return; }

        // Fix 3 — pre-flight types warning notification (Improvement 1/3).
        // Does not block generation — we proceed in safe mode.
        // When the types warning is shown we skip "environment not ready" — the types
        // warning is more actionable and showing both causes the user to dismiss it
        // before clicking "Copy Fix Command". When the types warning is suppressed
        // ("Don't show again"), fall back to the plain "environment not ready" notice.
        if (ctx.typesWarning && ctx.preflightProjectRoot) {
          const typesWarnShown = showTypesWarningIfNeeded(ctx.preflightProjectRoot, ctx.framework, ctx.installAttempted ?? false);
          if (!typesWarnShown && !envNotReadyShownRoots.has(ctx.preflightProjectRoot)) {
            // Types warning suppressed by "Don't show again" — show environment not ready.
            envNotReadyShownRoots.add(ctx.preflightProjectRoot);
            void vscode.window.showInformationMessage('SilentSpec generated tests (environment not ready)');
          }
        }

        // tsconfig types-array warning: @types installed but not referenced in tsconfig.
        // Auto-fix silently; only prompt if the write fails. Does not affect generation.
        if (ctx.tsconfigTypesWarning && ctx.preflightProjectRoot &&
            !tsconfigWarningShownRoots.has(ctx.preflightProjectRoot)) {
          tsconfigWarningShownRoots.add(ctx.preflightProjectRoot);
          const root = ctx.preflightProjectRoot;
          const fw   = ctx.framework;
          void (async () => {
            const ok = await fixTsconfigTypes(root, fw);
            if (ok) {
              // Bug 2 fix — tsconfig is now correct; mark root as fully verified so
              // pre-flight doesn't re-run the tsconfig check on the next save.
              checkedRoots.add(root);
              void vscode.window.showInformationMessage(`SilentSpec added "${fw}" to tsconfig.json types array.`);
            } else {
              // Write failed — fall back to manual instruction with buttons.
              void vscode.window.showWarningMessage(
                `SilentSpec: @types/${fw} is installed but not referenced in tsconfig.json. Add "types": ["${fw}"] to compilerOptions.`,
                'Fix tsconfig automatically', 'Show me how'
              ).then(async choice => {
                if (choice === 'Fix tsconfig automatically') {
                  const retry = await fixTsconfigTypes(root, fw);
                  if (retry) {
                    void vscode.window.showInformationMessage(`SilentSpec added "${fw}" to tsconfig.json types array.`);
                  }
                } else if (choice === 'Show me how') {
                  void vscode.env.openExternal(vscode.Uri.parse('https://silentspec.dev/docs/tsconfig'));
                }
              });
            }
          })();
        }

        // Track concurrent generations — final status only shows when all reach 0.
        activeGenerations++;
        log(`Calling ${providerName} for ${path.basename(filePath)}...`);
        if (activeGenerations > 1) {
          updateStatusBar(`$(sync~spin) Generating (${activeGenerations} files)...`);
        } else {
          updateStatusBar('$(sync~spin) Generating...');
        }

        const controller = new AbortController();
        activeControllers.add(controller);
        abortSignal.addEventListener('abort', () => controller.abort());

        // Default to error so an unhandled throw never leaves the status bar stuck.
        // Every normal path overwrites this before the finally block runs.
        let generationStatus = '$(error) Failed: unexpected error';
        let gapFillScheduled = false;

        try {
          const AI_TIMEOUT_MS = vscode.workspace.getConfiguration('silentspec').get<number>('aiTimeoutSeconds', 60) * 1000;
          const callStartMs = Date.now();
          let raw: string | null;
          try {
            raw = await withTimeout(provider.generateTests(prompt, log, controller.signal), AI_TIMEOUT_MS, 'Save handler', log);
          } catch (providerErr) {
            // Providers catch internally and return null — this handles any unexpected throws.
            telemetry.recordFailure(providerName, 'provider_error');
            generationStatus = '$(error) Failed: provider exception';
            showProviderFailureToast(filePath, providerName, classifyProviderError(providerErr, false));
            log(`[SilentSpec] Spec written: no`);
            log(`[SilentSpec] Spec compile-ready: no`);
            log(`[SilentSpec] Reason: provider exception`);
            return;
          }
          if (!raw) {
            telemetry.recordFailure(providerName, 'provider_error');
            generationStatus = '$(error) Failed: provider error';
            // withTimeout returns null when its timer fires. If elapsed ≈ AI_TIMEOUT_MS the
            // timer fired first; otherwise the provider returned null for a different reason.
            const elapsed = Date.now() - callStartMs;
            const timedOut = elapsed >= AI_TIMEOUT_MS - 500;
            showProviderFailureToast(filePath, providerName, classifyProviderError(null, timedOut));
            log(`[SilentSpec] Spec written: no`);
            log(`[SilentSpec] Spec compile-ready: no`);
            log(`[SilentSpec] Reason: provider error`);
            return;
          }

          // validateResponse handles truncation — null if missing end marker or unbalanced braces
          const validated = validateResponse(raw, log);
          if (!validated) {
            telemetry.recordFailure(providerName, 'invalid_response');
            generationStatus = '$(error) Failed: invalid response';
            log(`[SilentSpec] Spec written: no`);
            log(`[SilentSpec] Spec compile-ready: no`);
            log(`[SilentSpec] Reason: invalid response`);
            return;
          }

          const fixedValidated = fixImportStatement(validated, filePath, specPath, exportedFunctions, exportTypes, log);
          if (fixedValidated !== validated) { log('Import statement corrected — default/named export mismatch fixed'); }

          // Verify only against the work list — the AI was only asked to generate
          // tests for these functions. Using the full exportedFunctions here would
          // incorrectly mark already-covered functions as pending.
          const { nowCovered, nowPending } = verifyGenerated(fixedValidated, workList);
          log(`Generation verified — covered: [${nowCovered.join(', ')}] pending: [${nowPending.join(', ')}]`);
          if (nowCovered.length === 0 && workList.length > 0) { telemetry.recordFailure(providerName, 'no_describe_found'); }
          nowCovered.forEach(fn => resetRetry(fn));

          const healResult = healSpec(fixedValidated, path.basename(specPath), filePath, log, ctx.healerMode ?? 'full', ctx.framework);
          const finalContent = healResult.wasHealed ? healResult.healed : fixedValidated;
          if (healResult.wasHealed) { log(`Healer: removed ${healResult.healedCount} test(s) — reasons: ${JSON.stringify(healResult.removedTestReasons)}`); telemetry.recordHealing(healResult.healedCount, 0); }

          // Fix 2 — healer detected missing @types via TS2582/TS2304 on test globals
          // (Improvement 1/3). Uses the same helper and dedupe Set as Fix 3.
          if (healResult.missingTypes) {
            const root = ctx.preflightProjectRoot ?? ctx.specPath ?? filePath;
            const fw   = healResult.framework ?? ctx.framework ?? 'jest';
            showTypesWarningIfNeeded(root, fw, ctx.installAttempted ?? false);
          }

          const updatedMarker = buildUpdatedMarker(existingCovered, nowCovered, nowPending);
          // Append only when adding genuinely new functions to an existing spec.
          // If the worklist contains functions already covered, use replace to avoid duplicates.
          const isAddingOnlyNewFunctions = workList.every(fn => !existingCovered.includes(fn)) && existingCovered.length > 0;
          const writeMode = isAddingOnlyNewFunctions ? 'append' : 'replace';
          log(`Write mode: ${writeMode} (${workList.length}/${exportedFunctions.length} functions)`);
          await writeSpecFile(filePath, finalContent, log, updatedMarker, exportedFunctions, writeMode);
          telemetry.recordSuccess(providerName, nowCovered, nowPending);
          failureNotifiedFiles.delete(filePath); // clear so next failure re-notifies
          const specCompileReady = !healResult.missingTypes && !healResult.hasGlobalErrors;
          const specReason = healResult.missingTypes
            ? `missing ${ctx.framework} typings`
            : healResult.hasGlobalErrors
              ? 'global TypeScript errors'
              : 'ok';
          log(`[SilentSpec] Spec written: yes`);
          log(`[SilentSpec] Spec compile-ready: ${specCompileReady ? 'yes' : 'no'}`);
          log(`[SilentSpec] Reason: ${specReason}`);

          const firstSuccess = context.globalState.get<boolean>('silentspec.firstSuccessShown', false);
          if (!firstSuccess) {
            await context.globalState.update('silentspec.firstSuccessShown', true);
            void vscode.window.showInformationMessage(`SilentSpec generated tests for ${path.basename(filePath)}`, 'Open Test File').then(async action => {
              if (action === 'Open Test File') { const sp = await resolveSpecPath(filePath); void vscode.window.showTextDocument(vscode.Uri.file(sp), { viewColumn: vscode.ViewColumn.Beside }); }
            });
          }

          let pendingToResume = nowPending;
          while (pendingToResume.length > 0) {
            const retryable = filterRetryable(pendingToResume, previousPending, log);
            if (retryable.length === 0) { log('All pending functions hit retry cap — stopping auto-resume'); break; }
            log(`Pending functions — continuing loop: [${retryable.join(', ')}]`);
            updateStatusBar(`$(sync~spin) Generating... (${retryable.length} pending)...`);
            previousPending = pendingToResume;
            pendingToResume = await runOneGapBatch(filePath, exportedFunctions, exportTypes, pendingToResume, provider, providerName, context, telemetry, log, updateStatusBar, ctx.healerMode);
          }

          // ── Compute final status (displayed in finally when activeGenerations === 0) ──
          // CHECK A: healer removed all tests?
          const hasTests =
            finalContent.includes('it(') ||
            finalContent.includes("it('") ||
            finalContent.includes('test(');

          if (!hasTests) {
            log('Warning: spec file has no remaining tests after healing');
            generationStatus = ctx.healerMode === 'safe'
              ? '$(error) Failed: env not ready'
              : '$(error) Failed: healer removed all tests';
          } else {
            // CHECK B: any exported functions still not covered?
            try {
              const finalSpecBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath));
              const { marker: finalMarker } = readMarker(Buffer.from(finalSpecBytes).toString('utf8'));
              if (finalMarker) {
                const missing = exportedFunctions.filter(f => !finalMarker.covered.includes(f));
                if (missing.length > 0) {
                  log(`Coverage incomplete: [${missing.join(', ')}] not yet covered`);
                  generationStatus = `$(sync~spin) Generating... (${missing.length} pending)`;
                  // Only schedule functions the while loop never attempted.
                  // nowPending contains all functions the loop already retried —
                  // re-scheduling them would duplicate work the loop just exhausted.
                  const notYetAttempted = missing.filter(f => !nowPending.includes(f));
                  if (notYetAttempted.length > 0) {
                    gapFillScheduled = true;
                    log(`Auto-scheduling next batch for [${notYetAttempted.join(', ')}]...`);
                    setTimeout(() => {
                      processingQueue.enqueue(async () => {
                        log(`Auto-gap-fill: generating batch for [${notYetAttempted.join(', ')}]`);
                        updateStatusBar(`$(sync~spin) Generating... (${notYetAttempted.length} pending)...`);
                        await runOneGapBatch(filePath, exportedFunctions, exportTypes, notYetAttempted, provider, providerName, context, telemetry, log, updateStatusBar, ctx.healerMode);
                        log('[SilentSpec] Auto-gap-fill complete');
                        if (activeGenerations === 0) {
                          updateStatusBar('$(check) Done');
                          setTimeout(() => updateStatusBar(), 3000);
                        }
                      });
                    }, 2000);
                  }
                } else {
                  generationStatus = `$(check) Done — ${finalMarker.covered.length} covered`;
                }
              } else {
                generationStatus = '$(check) Done';
              }
            } catch { generationStatus = '$(check) Done'; }
          }
        } finally {
          activeControllers.delete(controller);
          activeGenerations--;
          // Only update the status bar when all concurrent generations are done.
          // If other files are still generating, leave the "Generating..." indicator.
          if (activeGenerations === 0) {
            updateStatusBar(generationStatus);
            // Skip the idle-reset timeout when a gap fill batch is scheduled —
            // it will set its own generating status when it starts.
            if (!gapFillScheduled) {
              setTimeout(() => updateStatusBar(), 3000);
            }
          }
        }
      } finally { processingLock.delete(filePath); }
    });
  });

  context.subscriptions.push(outputChannel);
}

export function deactivate() {
  for (const controller of activeControllers) { controller.abort(); }
  activeControllers.clear();
  pendingRetryCount.clear();
  processingLock.clear();
  failureNotifiedFiles.clear();
  lastProcessedHash.clear();
  lastProcessedTime.clear();
  activeGenerations = 0;
}