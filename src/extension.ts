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
import { writeSpecFile, appendGapTests, resolveSpecPath, updateMarker, isUnmanagedSpec } from './fileWriter';
import { withSpecPathLock } from './utils/specPathLock';
import { runGapFinder } from './gapFinder';
import { buildPrompt } from './promptBuilder';
import { extractContext, SilentSpecContext } from './contextExtractor';
import { TelemetryService } from './telemetry';
import { healSpec, verifyCompilation } from './utils/specHealer';
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
const activeTimers = new Set<ReturnType<typeof setTimeout>>();
let costCheckInProgress = false;
let cachedOllamaRunning: boolean | null = null;
// V1 limitation: SilentSpec uses Node fs/child_process which may not work
// correctly in Remote SSH, Dev Containers, or WSL. Warn once per session.
let remoteWarningShown = false;
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
  // B4 fix: costCheckInProgress ALWAYS cleared via finally, even if modal is ignored or
  // globalState.update throws. 30 s timeout so a dismissed/ignored notification never
  // blocks the queue for the session — long enough for a user to read and respond.
  try {
    const COST_MODAL_TIMEOUT_MS = 30_000;
    const modalPromise = vscode.window.showWarningMessage(
      `SilentSpec will use your ${providerName === 'claude' ? 'Claude (Anthropic)' : 'OpenAI'} API key. Typical cost is ~$0.003 per generation.`,
      'I understand — continue', 'Cancel'
    );
    const timeoutPromise = new Promise<undefined>(resolve =>
      setTimeout(() => resolve(undefined), COST_MODAL_TIMEOUT_MS)
    );
    const action = await Promise.race([modalPromise, timeoutPromise]);
    if (action !== 'I understand — continue') { return false; }
    await context.globalState.update(key, true);
    return true;
  } finally {
    costCheckInProgress = false;
  }
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
  let relativePath = path.relative(specDir, path.join(sourceDir, sourceBaseName)).split(path.sep).join('/');
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
    // D1: warn when GitHub Models appears to have truncated output mid-work-list.
    // Only fires when some functions were covered (not a total failure) but fewer than
    // requested — the most common truncation pattern on the free-tier output token cap.
    if (providerName === 'github' && nowCovered.length > 0 && nowCovered.length < workList.length) {
      log(`Warning: GitHub Models may have truncated output — covered ${nowCovered.length}/${workList.length} requested functions. Consider reducing maxFunctionsPerRun or switching to a paid provider.`);
    }
    nowCovered.forEach(fn => resetRetry(fn));
    const healResult = healSpec(fixedValidated, path.basename(specPath), filePath, log, ctx.healerMode, ctx.framework);
    const finalContent = healResult.wasHealed ? healResult.healed : fixedValidated;
    if (healResult.wasHealed) { log(`Healer: removed ${healResult.healedCount} test(s) — reasons: ${JSON.stringify(healResult.removedTestReasons)}`); telemetry.recordHealing(healResult.healedCount, 0); }
    const updatedMarker = buildUpdatedMarker(reconciled.covered, nowCovered, nowPending);
    await appendGapTests(filePath, finalContent, updatedMarker, log);
    telemetry.recordSuccess(providerName, nowCovered, nowPending);
    const diskVerify = verifyCompilation(specPath, log);
    const gapSpecCompileReady = diskVerify.clean;
    const gapSpecReason = diskVerify.clean
      ? 'ok'
      : diskVerify.diagnosticCount < 0
        ? 'verification failed'
        : `${diskVerify.diagnosticCount} diagnostic(s) in assembled spec`;
    log(`[SilentSpec] Spec written: yes`);
    log(`[SilentSpec] Spec compile-ready: ${gapSpecCompileReady ? 'yes' : 'no'}`);
    log(`[SilentSpec] Reason: ${gapSpecReason}`);
    return nowPending;
  } finally { activeControllers.delete(controller); }
}

export function activate(context: vscode.ExtensionContext) {
  if (vscode.env.remoteName && !remoteWarningShown) {
    remoteWarningShown = true;
    void vscode.window.showInformationMessage(
      'SilentSpec V1 is designed for local development. Some features may not work correctly in remote environments (SSH, Containers, WSL).'
    );
  }

  let installDate = context.globalState.get<string>('silentspec.installDate');
  if (!installDate) {
    installDate = new Date().toISOString();
    context.globalState.update('silentspec.installDate', installDate);
    void (async () => {
      const action = await vscode.window.showInformationMessage('Welcome to SilentSpec! Save any TypeScript file to auto-generate tests.', 'View README', 'Set API Key');
      if (action === 'View README') {
        void vscode.env.openExternal(
          vscode.Uri.parse('https://github.com/bharadwajmadduri/silent-spec#readme')
        );
      }
      else if (action === 'Set API Key') { void vscode.commands.executeCommand('silentspec.setApiKey'); }
    })();
  }

  // One-time data disclosure — fires once ever, non-blocking, flag stored immediately
  // so a VS Code restart before clicking never causes it to appear again.
  // Placed before save listeners and AI calls are registered.
  const disclosureKey = 'silentspec.dataDisclosureShown';
  if (!context.globalState.get<boolean>(disclosureKey, false)) {
    void context.globalState.update(disclosureKey, true);
    const providerLabels: Record<string, string> = {
      github: 'GitHub Models',
      claude: 'Claude (Anthropic)',
      openai: 'OpenAI',
      ollama: 'Ollama (local)',
    };
    const configuredProvider = vscode.workspace.getConfiguration('silentspec').get<string>('provider', 'github');
    const providerLabel = providerLabels[configuredProvider] ?? 'your configured AI provider';
    void vscode.window.showInformationMessage(
      `SilentSpec sends source code from saved files to ${providerLabel} to generate tests. See the README for full privacy details.`,
      'Got it',
      'Learn more'
    ).then(action => {
      if (action === 'Learn more') {
        void vscode.env.openExternal(
          vscode.Uri.parse('https://github.com/bharadwajmadduri/silent-spec#privacy-data--security')
        );
      }
    });
  }

  const telemetry = new TelemetryService(context, installDate);
  // H1 fix: route unexpected queue-task exceptions to the SilentSpec output channel
  // so users can see them. Falls back to console.error until this wiring runs.
  processingQueue.setErrorLogger(msg => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`));
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
    const providerInspect = config.inspect<string>('provider');
    const isExplicitlySet = (providerInspect?.workspaceFolderValue ?? providerInspect?.workspaceValue ?? providerInspect?.globalValue) !== undefined;
    const configuredProvider = config.get<string>('provider', 'github');
    if (!isExplicitlySet && cachedOllamaRunning === true) { return getProvider(context, 'ollama'); }
    return getProvider(context);
  }

  function getActiveProviderName(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    const providerInspect = config.inspect<string>('provider');
    const isExplicitlySet = (providerInspect?.workspaceFolderValue ?? providerInspect?.workspaceValue ?? providerInspect?.globalValue) !== undefined;
    const configuredProvider = config.get<string>('provider', 'github');
    if (!isExplicitlySet && cachedOllamaRunning === true) { return 'ollama'; }
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
        if (processingQueue.size >= MAX_QUEUE_DEPTH) {
          log(`Gap Finder: queue full (${processingQueue.size}/${MAX_QUEUE_DEPTH}) — skipping`);
          try { updateStatusBar('$(circle-slash) Skipped: queue full'); } catch { /* status bar may be disposed */ }
          { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
          return;
        }
        processingQueue.enqueue(async () => {
          if (abortSignal.aborted) { log('Gap Finder: aborted before execution — skipping'); return; }
          const providerName = await getActiveProviderName();
          lastUsedProvider = providerName;
          updateStatusBar();
          const provider = await getActiveProvider();
          const canProceed = await checkCostAcknowledgement(context, providerName);
          if (!canProceed) {
            try { updateStatusBar('$(circle-slash) Skipped: cancelled'); } catch { /* status bar may be disposed */ }
            { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
            return;
          }
          updateStatusBar('$(sync~spin) Generating...');
          const specPath = await resolveSpecPath(filePath);
          await withSpecPathLock(specPath, async () => {
            let pendingToResume = await runOneGapBatch(filePath, exportedFunctions, exportTypes, [], provider, providerName, context, telemetry, log, updateStatusBar, 'full');
            while (pendingToResume.length > 0) {
              const retryable = filterRetryable(pendingToResume, pendingToResume, log);
              if (retryable.length === 0) { log('Gap Finder: all pending functions hit retry cap — stopping'); break; }
              log(`Gap Finder: ${retryable.length} function(s) pending — continuing loop...`);
              updateStatusBar(`$(sync~spin) Generating... (${retryable.length} pending)...`);
              pendingToResume = await runOneGapBatch(filePath, exportedFunctions, exportTypes, pendingToResume, provider, providerName, context, telemetry, log, updateStatusBar, 'full');
            }
          });
          log('Gap Finder: done');
          try { updateStatusBar('$(check) Done'); } catch { /* status bar may be disposed */ }
          { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
        });
      }
    );
  }));

  // ── Configuration change listener — refresh idle status bar on provider/model change ──
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('silentspec.provider') || e.affectsConfiguration('silentspec.model')) {
      lastUsedProvider = getActiveProviderName();
      updateStatusBar();
    }
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

        await withSpecPathLock(specPath, async () => {

        // ── Early unmanaged-spec guard ────────────────────────────────────────
        // Skip before any generation work if the resolved spec file already
        // exists and is not managed by SilentSpec. writeSpecFile() keeps its own
        // identical check as a final safety net — this one avoids a wasted API call.
        if (await isUnmanagedSpec(specPath)) {
          log('Spec file: not managed by SilentSpec — skipping');
          try { updateStatusBar('$(circle-slash) Skipped: unmanaged spec'); } catch { /* status bar may be disposed */ }
          { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
          return;
        }

        let existingCovered: string[] = [];
        let previousPending: string[] = [];
        try { const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath)); const { marker } = readMarker(Buffer.from(bytes).toString('utf8')); existingCovered = marker?.covered ?? []; previousPending = marker?.pending ?? []; } catch { /* first run */ }

        const reconciled = reconcile(
          existingCovered.length > 0 || previousPending.length > 0 ? { version: 1, covered: existingCovered, pending: previousPending } : null,
          exportedFunctions
        );
        if (reconciled.gaps.length === 0 && reconciled.pending.length === 0) {
          log(`Skipped: all ${exportedFunctions.length} functions covered — no generation needed`);
          try { updateStatusBar('$(circle-slash) Skipped: all covered'); } catch { /* status bar may be disposed */ }
          { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
          return;
        }

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
        if (workList.length === 0) {
          log('Skipped: work list is empty after reconcile');
          try { updateStatusBar('$(circle-slash) Skipped: all covered'); } catch { /* status bar may be disposed */ }
          { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
          return;
        }
        ctx.workList = workList;
        log(`Batch size: ${batchSize} (file: ${ctx.fileContent.length} chars, user max: ${maxPerRun})`);
        log(`Work list: [${workList.join(', ')}] (${workList.length}/${exportedFunctions.length} functions)`);
        const provider = await getActiveProvider();
        const canProceed = await checkCostAcknowledgement(context, providerName);
        if (!canProceed) {
          try { updateStatusBar('$(circle-slash) Skipped: cancelled'); } catch { /* status bar may be disposed */ }
          { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
          return;
        }

        const prompt = buildPrompt(ctx);

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
                'Fix tsconfig automatically'
              ).then(async choice => {
                if (choice === 'Fix tsconfig automatically') {
                  const retry = await fixTsconfigTypes(root, fw);
                  if (retry) {
                    void vscode.window.showInformationMessage(`SilentSpec added "${fw}" to tsconfig.json types array.`);
                  }
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
          // D1: warn when GitHub Models appears to have truncated output mid-work-list.
          // Only fires when some functions were covered (not a total failure) but fewer than
          // requested — the most common truncation pattern on the free-tier output token cap.
          if (providerName === 'github' && nowCovered.length > 0 && nowCovered.length < workList.length) {
            log(`Warning: GitHub Models may have truncated output — covered ${nowCovered.length}/${workList.length} requested functions. Consider reducing maxFunctionsPerRun or switching to a paid provider.`);
          }
          nowCovered.forEach(fn => resetRetry(fn));

          const healResult = healSpec(fixedValidated, path.basename(specPath), filePath, log, ctx.healerMode ?? 'full', ctx.framework);
          const finalContent = healResult.wasHealed ? healResult.healed : fixedValidated;
          if (healResult.wasHealed) { log(`Healer: removed ${healResult.healedCount} test(s) — reasons: ${JSON.stringify(healResult.removedTestReasons)}`); telemetry.recordHealing(healResult.healedCount, 0); }

          // Fix 2 — healer detected missing @types via TS2582/TS2304 on test globals
          // (Improvement 1/3). Uses the same helper and dedupe Set as Fix 3.
          if (healResult.missingTypes) {
            // BUG G: preflight just installed types this run — the in-process compiler
            // hasn't seen them yet. Skip the "types missing" warning (install succeeded)
            // and log a refresh prompt instead. BUG H toast already notified the user.
            const isSameRunInstall = ctx.installAttempted === true && !ctx.typesWarning;
            if (isSameRunInstall) {
              log('Types installed but compiler needs refresh — save again');
            } else {
              const root = ctx.preflightProjectRoot ?? ctx.specPath ?? filePath;
              const fw   = healResult.framework ?? ctx.framework ?? 'jest';
              showTypesWarningIfNeeded(root, fw, ctx.installAttempted ?? false);
            }
          }

          const updatedMarker = buildUpdatedMarker(existingCovered, nowCovered, nowPending);
          // Append only when adding genuinely new functions to an existing spec.
          // If the worklist contains functions already covered, use replace to avoid duplicates.
          const isAddingOnlyNewFunctions = workList.every(fn => !existingCovered.includes(fn)) && existingCovered.length > 0;
          const writeMode = isAddingOnlyNewFunctions ? 'append' : 'replace';
          log(`Write mode: ${writeMode} (${workList.length}/${exportedFunctions.length} functions)`);
          const specWritten = await writeSpecFile(filePath, finalContent, log, updatedMarker, exportedFunctions, writeMode);
          if (!specWritten) { return; }
          // Open spec in split panel on first creation (controlled by silentspec.openSpecOnCreate)
          if (existingCovered.length === 0 && vscode.workspace.getConfiguration('silentspec').get<boolean>('openSpecOnCreate', true)) {
            void vscode.window.showTextDocument(vscode.Uri.file(specPath), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
          }
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

                    // Iterative gap-fill loop — runs one batch, re-reads the live marker,
                    // and schedules another batch until all functions are covered or every
                    // remaining function has hit the per-function retry cap (MAX_RETRIES_PER_FUNCTION).
                    const scheduleGapBatch = (toGenerate: string[], prevBatch: string[]) => {
                      const retryable = filterRetryable(toGenerate, prevBatch, log);
                      if (retryable.length === 0) {
                        log('Auto-gap-fill: all remaining functions hit retry cap — stopping');
                        gapFillScheduled = false;
                        if (activeGenerations === 0) {
                          try { updateStatusBar('$(check) Done'); } catch { /* status bar may be disposed */ }
                          { const _t2 = setTimeout(() => { activeTimers.delete(_t2); updateStatusBar(); }, 3000); activeTimers.add(_t2); }
                        }
                        return;
                      }
                      // B1 fix: guard against scheduling on an already-aborted signal.
                      if (abortSignal.aborted) {
                        log('Auto-gap-fill: aborted — not scheduling next batch');
                        gapFillScheduled = false;
                        return;
                      }
                      log(`Auto-scheduling next batch for [${retryable.join(', ')}]...`);

                      // ── B1 fix: abort-aware timer with idempotent cleanup ─────────────
                      let cleanedUp = false;
                      const _t = setTimeout(() => {
                        cleanupTimer();  // removes abort listener and activeTimers entry
                        processingQueue.enqueue(async () => {
                          let willRecurse = false;
                          try {
                            // Guard: abort may have fired between timer creation and queue execution.
                            if (abortSignal.aborted) { log('Auto-gap-fill: aborted before batch execution — skipping'); return; }
                            log(`Auto-gap-fill: generating batch for [${retryable.join(', ')}]`);
                            updateStatusBar(`$(sync~spin) Generating... (${retryable.length} pending)...`);
                            await withSpecPathLock(specPath, async () => {
                              await runOneGapBatch(filePath, exportedFunctions, exportTypes, retryable, provider, providerName, context, telemetry, log, updateStatusBar, ctx.healerMode);
                            });
                            log('[SilentSpec] Auto-gap-fill complete');
                            // Re-read coverage from the live marker to decide whether to continue.
                            try {
                              const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(specPath));
                              const { marker: latestMarker } = readMarker(Buffer.from(bytes).toString('utf8'));
                              const stillMissing = latestMarker
                                ? exportedFunctions.filter(f => !latestMarker.covered.includes(f))
                                : [];
                              if (stillMissing.length === 0) {
                                log('Auto-gap-fill: all functions covered');
                              } else {
                                log(`Auto-gap-fill: ${stillMissing.length} function(s) still uncovered — scheduling next batch`);
                                willRecurse = true;
                                scheduleGapBatch(stillMissing, retryable);
                              }
                            } catch {
                              // Marker read failed — fall through to finally, which clears gapFillScheduled.
                            }
                          } finally {
                            // B3 fix: clear gapFillScheduled exactly once — only when the chain ends.
                            // If willRecurse is true, scheduleGapBatch owns the flag going forward.
                            if (!willRecurse) {
                              gapFillScheduled = false;
                              if (activeGenerations === 0) {
                                try { updateStatusBar('$(check) Done'); } catch { /* status bar may be disposed */ }
                                { const _t2 = setTimeout(() => { activeTimers.delete(_t2); updateStatusBar(); }, 3000); activeTimers.add(_t2); }
                              }
                            }
                          }
                        });
                      }, 2000);
                      activeTimers.add(_t);

                      // Idempotent cleanup: safe to call from abort handler or timer callback.
                      function cleanupTimer(): void {
                        if (cleanedUp) { return; }
                        cleanedUp = true;
                        clearTimeout(_t);
                        activeTimers.delete(_t);
                        abortSignal.removeEventListener('abort', onAbort);
                      }

                      // Abort handler: cancel the pending timer and end the gap-fill chain.
                      function onAbort(): void {
                        cleanupTimer();
                        gapFillScheduled = false;
                      }

                      abortSignal.addEventListener('abort', onAbort);
                    };

                    scheduleGapBatch(notYetAttempted, []); // [] = first attempt, count starts at 1
                  }
                } else {
                  generationStatus = `$(check) Done — ${finalMarker.covered.length} covered`;
                }
              } else {
                generationStatus = '$(check) Done';
              }
            } catch { generationStatus = '$(check) Done'; }
          }
          // Override: healer detected missing @types — status must reflect env-not-ready
          // regardless of what CHECK A/B computed (tests may still be present in safe mode).
          // Exception (BUG G): types were just installed this run — compiler needs refresh,
          // not a hard failure. Let CHECK A/B "Done" stand; BUG H toast covers the user.
          if (healResult.missingTypes && !(ctx.installAttempted === true && !ctx.typesWarning)) { generationStatus = '$(error) Failed: env not ready'; }
        } finally {
          activeControllers.delete(controller);
          activeGenerations--;
          // Only update the status bar when all concurrent generations are done.
          // If other files are still generating, leave the "Generating..." indicator.
          if (activeGenerations === 0) {
            // F2 fix: wrap so a thrown status update never prevents idle-reset registration.
            try { updateStatusBar(generationStatus); } catch { /* status bar may be disposed */ }
            // Skip the idle-reset timeout when a gap fill batch is scheduled —
            // it will set its own generating status when it starts.
            if (!gapFillScheduled) {
              { const _t = setTimeout(() => { activeTimers.delete(_t); updateStatusBar(); }, 3000); activeTimers.add(_t); }
            }
          }
        }

        }); // withSpecPathLock
      } finally { processingLock.delete(filePath); }
    });
  }, (fp: string): string | null => {
    if (processingLock.has(fp)) { return `Skipped: already processing ${path.basename(fp)}`; }
    if (processingQueue.size >= MAX_QUEUE_DEPTH) { return `Skipped: queue full (${processingQueue.size}/${MAX_QUEUE_DEPTH}) — ${path.basename(fp)}`; }
    return null;
  });

  context.subscriptions.push(outputChannel);
}

export function deactivate() {
  for (const t of activeTimers) { clearTimeout(t); }
  activeTimers.clear();
  for (const controller of activeControllers) { controller.abort(); }
  activeControllers.clear();
  pendingRetryCount.clear();
  processingLock.clear();
  failureNotifiedFiles.clear();
  lastProcessedHash.clear();
  lastProcessedTime.clear();
  activeGenerations = 0;
}