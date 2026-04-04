import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeFile, ASTAnalysisResult } from './astAnalyzer';
import { extractContext, SilentSpecContext } from './contextExtractor';
import { resolveSpecPath } from './fileWriter';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { createHash } from 'crypto';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { readMarker, updateMarkerOnly } from './utils/markerManager';
import { isUnmanagedSpec } from './utils/unmanagedSpec';

const execAsync = promisify(execCb);

export const outputChannel = vscode.window.createOutputChannel('SilentSpec');

// Content hash + timestamp per file.
// Used to detect formatter re-saves (Prettier, ESLint) which fire a second
// onDidSaveTextDocument event with identical content within seconds of the first.
// The time window prevents permanent lock-in — users can re-save the same
// content after the window expires to force re-generation (e.g. after a failed run).
export const lastProcessedHash = new Map<string, string>();
export const lastProcessedTime = new Map<string, number>();

// Formatter re-saves typically fire within 1–3 seconds.
// 10 seconds gives plenty of headroom without locking users out.
const FORMATTER_WINDOW_MS = 10_000;

function getConfig() {
  return vscode.workspace.getConfiguration('silentspec');
}

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

function shouldSkip(filePath: string): { skip: boolean; reason?: string } {
  const supported = getConfig().get<string[]>(
    'supportedExtensions', ['.ts', '.tsx', '.js', '.jsx']
  );

  if (/\.(test|spec)\.[tj]sx?$/.test(filePath)) {
    return { skip: true, reason: 'test file' };
  }

  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (!supported.includes(ext)) {
    return { skip: true, reason: `unsupported extension (${ext})` };
  }

  if (/node_modules|[/\\](dist|out)[/\\]/.test(filePath)) {
    return { skip: true, reason: 'build/dependency folder' };
  }

  return { skip: false };
}

const pendingRequests = new Map<string, AbortController>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

// ─── Pre-flight: test type definitions check ──────────────────────────────────
//
// Runs once per project root per session. Detects whether the test framework's
// @types package is installed and silently installs it if missing.
// Keyed by project root so monorepo sub-packages are each checked independently.

// ── Pre-flight: test environment check ────────────────────────────────────────
//
// Runs once per *successfully verified* project root per session.
// Failed installs are NOT cached — they retry on the next save.
// Monorepo-aware: walks up from the source file to find the nearest
// package.json that declares the detected test framework.

interface PreflightResult {
  mode: 'full' | 'safe';
  projectRoot: string | null;
  displayCmd: string | null;   // user-facing npm command (banner + logs)
  installCmd:  string | null;  // PM-specific command (terminal "Install now")
  typesWarning?: boolean;          // true when install failed — notify user to install manually
  installAttempted: boolean;       // true when auto-install was attempted (success or failure)
  tsconfigTypesWarning?: boolean;  // true when @types installed but absent from tsconfig types array
}

// Project roots whose environment has been verified this session.
// Exported so extension.ts can add a root after a successful tsconfig auto-fix
// (Bug 2: checkedRoots must not be populated until BOTH node_modules and tsconfig checks pass).
export const checkedRoots = new Set<string>();
// Project roots where we have already shown the "environment not ready" notification.
// Reset when the environment is fixed on a subsequent save.
const notifiedRoots  = new Set<string>();

// Packages to CHECK for (determines whether env is ready).
const FRAMEWORK_CHECK_PACKAGES: Record<string, string[]> = {
  jest:    ['jest', '@types/jest'],
  vitest:  ['vitest'],              // vitest bundles its own types
  mocha:   ['mocha', '@types/mocha'],
  jasmine: ['jasmine', '@types/jasmine'],
};

// Packages to INSTALL when env is missing (passed to the package manager).
const FRAMEWORK_INSTALL_PACKAGES: Record<string, string> = {
  jest:    'jest @types/jest ts-jest',
  vitest:  'vitest',
  mocha:   'mocha @types/mocha',
  jasmine: 'jasmine @types/jasmine',
};

// User-facing install commands shown in the banner and warning logs (always npm format).
export const FRAMEWORK_DISPLAY_CMDS: Record<string, string> = {
  jest:    'npm install -D jest @types/jest ts-jest',
  vitest:  'npm install -D vitest',
  mocha:   'npm install -D mocha @types/mocha',
  jasmine: 'npm install -D jasmine @types/jasmine',
};

// Expected entries in tsconfig compilerOptions.types for each framework.
// If types array is explicitly set but missing these, TS2582 fires despite @types being installed.
// vitest is omitted — it bundles its own globals and does not require a types entry.
const FRAMEWORK_TYPES_ENTRIES: Record<string, string[]> = {
  jest:    ['jest', '@types/jest'],
  mocha:   ['mocha', '@types/mocha'],
  jasmine: ['jasmine', '@types/jasmine'],
};

// Returns true when the framework needs a tsconfig types entry and it is absent.
// Decision table:
//   vitest            → always false (bundles its own types, no tsconfig entry needed)
//   jest/mocha/jasmine, types array absent          → true (tsc won't pick up globals)
//   jest/mocha/jasmine, types array present, missing → true
//   jest/mocha/jasmine, types array present, has entry → false (ok)
async function checkTsconfigTypes(
  projectRoot: string,
  framework: string,
  emit: (msg: string) => void
): Promise<boolean> {
  if (framework === 'vitest') { return false; }
  const expected = FRAMEWORK_TYPES_ENTRIES[framework] ?? [];
  if (expected.length === 0) { return false; }
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  try {
    const raw = await fs.readFile(tsconfigPath, 'utf8');
    // Strip // line comments and /* */ block comments so JSON.parse works on JSONC
    const stripped = raw
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const tsconfig = JSON.parse(stripped) as Record<string, unknown>;
    const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined;
    if (!compilerOptions) {
      emit(`Pre-flight: no compilerOptions in tsconfig — adding types entry for ${framework}`);
      return true;
    }
    const types = compilerOptions['types'];
    if (!Array.isArray(types)) {
      // types absent → tsc auto-includes all @types/*, but TS2582 still fires in
      // some project setups (e.g. composite/project-references). Always add entry.
      emit(`Pre-flight: tsconfig has no types array — adding entry for ${framework}`);
      return true;
    }
    if (expected.some(t => (types as string[]).includes(t))) { return false; }
    emit(`Pre-flight: @types/${framework} installed but not in tsconfig types array`);
    return true;
  } catch {
    return false; // tsconfig not found or unparseable — skip check
  }
}

// ── Banner helpers ─────────────────────────────────────────────────────────────
//
// The banner lives IMMEDIATELY ABOVE // <SS-GENERATED-START> — outside every
// managed zone so the marker system never touches it.

const BANNER_MARKER       = '// ⚠️ SilentSpec: generated tests (environment not ready)';
const BANNER_LINE_COUNT   = 3;  // marker + run-cmd + save-again
const SS_GENERATED_PREFIX = '// <SS-GENERATED-START';

function injectBanner(specContent: string, displayCmd: string): string {
  if (specContent.includes(BANNER_MARKER)) { return specContent; } // idempotent
  const idx = specContent.indexOf(SS_GENERATED_PREFIX);
  if (idx === -1) { return specContent; }
  const banner = [
    BANNER_MARKER,
    `// Run: ${displayCmd}`,
    '// Save this file again after installing to enable full healing.',
  ].join('\n');
  return specContent.slice(0, idx) + banner + '\n' + specContent.slice(idx);
}

function removeBanner(specContent: string): string {
  if (!specContent.includes(BANNER_MARKER)) { return specContent; } // idempotent
  const lines  = specContent.split('\n');
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith('// ⚠️ SilentSpec: generated tests (environment not ready)')) {
      i += BANNER_LINE_COUNT; // skip marker line + run-cmd line + save-again line
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join('\n');
}

// ── Monorepo-aware project root detection ─────────────────────────────────────
//
// Walks up from the source file's directory to find the nearest package.json
// that declares the given test framework in dependencies or devDependencies.
// Stops at the workspace root. Returns workspace root as fallback.

async function findProjectRoot(filePath: string, framework: string): Promise<string | null> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const frameworkPkgIds: Record<string, string[]> = {
    jest:    ['jest', 'ts-jest', 'babel-jest'],
    vitest:  ['vitest'],
    mocha:   ['mocha'],
    jasmine: ['jasmine'],
  };
  const pkgsToFind = frameworkPkgIds[framework] ?? [];

  let dir = path.dirname(filePath);
  while (true) {
    try {
      const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = { ...(pkg['dependencies'] as object ?? {}), ...(pkg['devDependencies'] as object ?? {}) } as Record<string, unknown>;
      if (pkgsToFind.some(p => p in deps)) { return dir; }
    } catch { /* no package.json or parse error — keep walking */ }

    if (workspaceRoot && dir === workspaceRoot) { return workspaceRoot; }
    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return workspaceRoot; // fallback — best effort
}

async function detectPackageManager(projectRoot: string): Promise<'npm' | 'yarn' | 'pnpm'> {
  try { await fs.access(path.join(projectRoot, 'pnpm-lock.yaml')); return 'pnpm'; } catch {}
  try { await fs.access(path.join(projectRoot, 'yarn.lock'));      return 'yarn'; } catch {}
  return 'npm';
}

// packages is a space-separated list (e.g. "jest @types/jest ts-jest")
function buildInstallCommand(pm: 'npm' | 'yarn' | 'pnpm', packages: string, projectRoot: string): string {
  if (pm === 'yarn') { return `yarn add --dev ${packages} --cwd "${projectRoot}"`; }
  if (pm === 'pnpm') { return `pnpm add --save-dev ${packages} --dir "${projectRoot}"`; }
  return `npm install --save-dev ${packages} --prefix "${projectRoot}"`;
}

async function runPreflightCheck(ctx: SilentSpecContext, filePath: string): Promise<PreflightResult> {
  const full: PreflightResult = { mode: 'full', projectRoot: null, displayCmd: null, installCmd: null, installAttempted: false };

  // Part 5 — unknown framework: skip check, generate best effort in full mode
  const checkPkgs = FRAMEWORK_CHECK_PACKAGES[ctx.framework];
  if (!checkPkgs) { return full; }

  // Part 6 — monorepo: walk up to find the right project root
  const projectRoot = await findProjectRoot(filePath, ctx.framework);
  if (!projectRoot) { return full; }

  // Already verified this session — skip
  if (checkedRoots.has(projectRoot)) { return { ...full, projectRoot }; }

  // Check whether all required packages are present in node_modules
  const missingPkgs: string[] = [];
  for (const pkg of checkPkgs) {
    try { await fs.access(path.join(projectRoot, 'node_modules', pkg)); }
    catch { missingPkgs.push(pkg); }
  }

  // Improvement 5 — monorepo node_modules hoisting.
  // A package missing from projectRoot/node_modules may be hoisted to a parent
  // directory's node_modules (e.g. workspaceRoot/node_modules in a monorepo).
  // Walk up from projectRoot to workspaceRoot; if any parent has the package,
  // treat it as present and remove it from missingPkgs.
  if (missingPkgs.length > 0) {
    const hoistRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    if (hoistRoot && projectRoot !== hoistRoot) {
      for (let i = missingPkgs.length - 1; i >= 0; i--) {
        const pkg = missingPkgs[i];
        let found = false;
        let dir = path.dirname(projectRoot);
        while (true) {
          try { await fs.access(path.join(dir, 'node_modules', pkg)); found = true; break; } catch {}
          if (dir === hoistRoot) { break; }
          const parent = path.dirname(dir);
          if (parent === dir) { break; }
          dir = parent;
        }
        if (found) {
          log(`Pre-flight: ${pkg} found in hoisted node_modules at ${path.join(path.dirname(projectRoot), 'node_modules', pkg)}`);
          missingPkgs.splice(i, 1);
        }
      }
    }
  }

  if (missingPkgs.length === 0) {
    // Environment is ready — clear any previous degraded state.
    if (notifiedRoots.has(projectRoot)) {
      notifiedRoots.delete(projectRoot);
      log(`SilentSpec: environment ready — ${projectRoot}`);
    }
    // Secondary check: packages present but may be absent from tsconfig types array.
    // Only runs when all node_modules packages are confirmed present.
    // Bug 2 fix — do NOT add to checkedRoots until the tsconfig check also passes.
    // If we cache before the tsconfig check, the next save skips pre-flight entirely
    // and the tsconfig warning never fires again.
    const tsconfigTypesWarning = await checkTsconfigTypes(projectRoot, ctx.framework, log);
    if (tsconfigTypesWarning) {
      return { ...full, projectRoot, tsconfigTypesWarning: true };
    }
    // Both checks passed — safe to cache this root.
    checkedRoots.add(projectRoot);
    return { ...full, projectRoot };
  }

  // Missing packages — attempt silent auto-install using the detected package manager
  log(`Pre-flight: ${missingPkgs.join(', ')} missing in ${projectRoot} — attempting install`);
  const pm          = await detectPackageManager(projectRoot);
  const installPkgs = FRAMEWORK_INSTALL_PACKAGES[ctx.framework];
  const installCmd  = buildInstallCommand(pm, installPkgs, projectRoot);
  const displayCmd  = FRAMEWORK_DISPLAY_CMDS[ctx.framework] ?? FRAMEWORK_DISPLAY_CMDS['jest'];

  try {
    await execAsync(installCmd, { cwd: projectRoot, timeout: 30_000 });
    log(`SilentSpec: set up test environment (${ctx.framework}) in ${projectRoot}`);
    if (notifiedRoots.has(projectRoot)) { notifiedRoots.delete(projectRoot); }
    checkedRoots.add(projectRoot);
    void vscode.window.showInformationMessage(`SilentSpec set up test environment (${ctx.framework})`);
    return { ...full, projectRoot, installAttempted: true };
  } catch {
    // Install failed — enter degraded mode. Do NOT cache so we retry on next save.
    // The notification is shown in extension.ts via showTypesWarningIfNeeded,
    // which coordinates with "Don't show again" dismissal state. Showing it here
    // would fire before the actionable types warning popup, causing it to be dismissed.
    log(`Pre-flight: ${missingPkgs.join(', ')} missing in ${projectRoot} — entering safe mode`);
    return { mode: 'safe', projectRoot, displayCmd, installCmd, typesWarning: true, installAttempted: true };
  }
}

// Read file content asynchronously.
// Returns null if the file no longer exists (renamed/deleted during debounce).
// Throws for all other access errors so they surface in the error log.
async function readFileContent(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath);
    return await fs.readFile(filePath, 'utf8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null; // file deleted or renamed — not an error
    }
    throw err; // unexpected access error — let handleFileSave log it
  }
}

// Phase 2 — AST analysis gate.
// Returns null if file is not testable (no exports, too complex, etc.).
async function phaseAST(
  filePath: string,
  updateStatus: (text: string) => void
): Promise<ASTAnalysisResult | null> {
  const result = analyzeFile(filePath, log);
  if (!result.isTestable) {
    log(`Skipped: ${result.skipReason} — ${filePath}`);
    updateStatus(`$(circle-slash) Skipped: ${result.skipReason}`);
    setTimeout(() => updateStatus(''), 3000);
    return null;
  }
  log(`Testable: [${result.exportedFunctions.join(', ')}] — ${filePath}`);
  return result;
}

// Phase 3 — context extraction.
// Builds the full SilentSpecContext from AST result + dependency analysis.
// extractContext logs framework, project type, test pattern, and mock hints internally.
function phaseContext(result: ASTAnalysisResult, filePath: string): SilentSpecContext {
  const ctx = extractContext(
    filePath,
    result.exportedFunctions,
    result.imports,
    log,
    result.exportTypes
  );
  ctx.internalTypes = result.internalTypes;
  return ctx;
}

// Phase 4 — spec path resolution.
// Determines where the spec file lives or will be created.
async function phaseSpecPath(ctx: SilentSpecContext, filePath: string): Promise<void> {
  ctx.specPath = await resolveSpecPath(filePath, log);
}

// Core save handler — runs after debounce delay.
// Phases: read → hash check → size gate → AST → context → spec path → AI call
// Note: prompt is NOT built here — the caller (extension.ts) builds it after
// computing the work list (which functions need tests this batch). This ensures
// the AI is asked to generate tests for only ≤ maxFunctionsPerRun functions,
// not the full export list of the file.
async function handleFileSave(
  filePath: string,
  updateStatus: (text: string) => void,
  onPromptReady: (
    ctx: SilentSpecContext,
    filePath: string,
    log: (msg: string) => void,
    abortSignal: AbortSignal,
    exportedFunctions: string[],
    exportTypes: Record<string, 'default' | 'named'>
  ) => Promise<void>,
  isAutoGapFill: boolean = false,
  earlyGuard?: (filePath: string) => string | null
): Promise<void> {
  try {
    // Phase 1 — read file content asynchronously
    const content = await readFileContent(filePath);
    if (content === null) {
      log(`Skipped: file no longer exists — ${filePath}`);
      return;
    }

    // Formatter re-save guard — skip if content is identical AND within the formatter window.
    // Prettier/ESLint fire a second save event within ~1-3 seconds of the user's save.
    // We skip that re-save but allow the user to manually re-save the same content
    // after the window expires (e.g. to retry after a failed generation).
    //
    // Auto gap fills skip this check entirely — the file hasn't changed but pending
    // functions still need to be generated. The hash state is left unchanged so that
    // a subsequent user-triggered save is still correctly guarded.
    if (!isAutoGapFill) {
      const hash = createHash('sha256').update(content).digest('hex');
      const lastHash = lastProcessedHash.get(filePath);
      const lastTime = lastProcessedTime.get(filePath) ?? 0;
      const timeSinceLast = Date.now() - lastTime;

      if (lastHash === hash && timeSinceLast < FORMATTER_WINDOW_MS) {
        log(`Skipped: formatter re-save detected (same content within ${FORMATTER_WINDOW_MS / 1000}s, hash=${hash.slice(0, 8)}) — ${path.basename(filePath)}`);
        return;
      }

      // Update hash and timestamp — before the AI call so formatter re-saves
      // during generation are correctly suppressed.
      lastProcessedHash.set(filePath, hash);
      lastProcessedTime.set(filePath, Date.now());
    }

    // File size gate — skip files over 1500 lines or 200k characters
    const lines = content.split('\n');
    if (lines.length > 1500 || content.length > 200_000) {
      const reason = lines.length > 1500
        ? `file too large (${lines.length} lines)`
        : `file too large (${content.length} chars)`;
      log(`Skipped: ${reason} — ${filePath}`);
      updateStatus(`$(circle-slash) Skipped: file too large`);
      setTimeout(() => updateStatus(''), 3000);
      return;
    }

    // FIX B — early processing-lock / queue-depth check (before AST to avoid wasted work)
    if (earlyGuard) {
      const earlySkipReason = earlyGuard(filePath);
      if (earlySkipReason !== null) { log(earlySkipReason); return; }
    }

    // Phase 2 — AST gate
    const astResult = await phaseAST(filePath, updateStatus);
    if (!astResult) { return; }

    // Phase 4 — spec path resolution (moved before Phase 3 to enable early unmanaged-spec guard)
    const resolvedSpecPath = await resolveSpecPath(filePath, log);

    // FIX C — early unmanaged-spec guard: skip before context extraction and preflight
    if (await isUnmanagedSpec(resolvedSpecPath)) {
      log('Spec file: not managed by SilentSpec — skipping');
      return;
    }

    // Phase 3 — context extraction (with full export list — work list stamped later)
    const ctx = phaseContext(astResult, filePath);
    ctx.specPath = resolvedSpecPath;

    // Phase 4.5 — preflight: check test environment, enable degraded mode if needed.
    // Runs once per successfully verified project root per session.
    // Never blocks generation — failures trigger safe mode, not abort.
    const preflightResult = await runPreflightCheck(ctx, filePath);
    ctx.healerMode = preflightResult.mode;
    ctx.typesWarning = preflightResult.typesWarning;
    ctx.preflightProjectRoot = preflightResult.projectRoot;
    ctx.installAttempted = preflightResult.installAttempted;
    ctx.tsconfigTypesWarning = preflightResult.tsconfigTypesWarning;

    // Phase 4.75 — pre-flight corruption check.
    // Read the existing spec (if any) and validate SS markers before calling the AI.
    // A partially-written or externally-corrupted spec could cause the writer to
    // produce invalid output — bail early so the user can fix the file first.
    if (ctx.specPath && fsSync.existsSync(ctx.specPath)) {
      const existing = fsSync.readFileSync(ctx.specPath, 'utf8');
      const hasStart    = existing.includes('// <SS-GENERATED-START');
      const hasEnd      = existing.includes('// <SS-GENERATED-END>');
      const hasUserBlock = existing.includes('// <SS-USER-TESTS>');

      if (hasStart || hasEnd || hasUserBlock) {
        const startCount = (existing.match(/\/\/ <SS-GENERATED-START/g) || []).length;
        const startIdx   = existing.indexOf('// <SS-GENERATED-START');
        const endIdx     = existing.indexOf('// <SS-GENERATED-END>');

        if (startCount > 1) {
          log('Spec file: duplicate SS-GENERATED-START marker');
          log(`Context: ${ctx.specPath}`);
          return;
        }
        if (hasStart && !hasEnd) {
          log('Spec file: missing SS-GENERATED-END marker');
          log(`Context: ${ctx.specPath}`);
          return;
        }
        if (!hasStart && hasEnd) {
          log('Spec file: missing SS-GENERATED-END marker');
          log(`Context: ${ctx.specPath}`);
          return;
        }
        if (hasStart && hasEnd && endIdx < startIdx) {
          log('Spec file: markers out of order');
          log(`Context: ${ctx.specPath}`);
          return;
        }
      }

      // Guard: SS-GENERATED markers intact but full zone structure broken
      // Inline the zone marker strings since hasFullStructure is not exported
      if (hasStart && hasEnd) {
        const ssStartIdx = existing.indexOf('// <SS-GENERATED-START');
        const ssEndIdx   = existing.indexOf('// <SS-GENERATED-END>');
        if (ssStartIdx < ssEndIdx) {
          const hasFullZones =
            existing.includes('// <SS-IMPORTS-START>') &&
            existing.includes('// <SS-IMPORTS-END>') &&
            existing.includes('// <SS-HELPERS-START>') &&
            existing.includes('// <SS-HELPERS-END>') &&
            existing.includes('// <SS-USER-TESTS>') &&
            existing.includes('// </SS-USER-TESTS>');
          if (!hasFullZones) {
            log('Spec file: incomplete zone structure — skipping write');
            log(`Context: ${ctx.specPath}`);
            return;
          }

          // Guard: verify ALL zone markers appear in correct order
          // Required order: SS-IMPORTS-START → SS-IMPORTS-END → SS-HELPERS-START → SS-HELPERS-END
          //                 → SS-USER-TESTS → /SS-USER-TESTS → SS-GENERATED-START → SS-GENERATED-END
          const posImportsStart  = existing.indexOf('// <SS-IMPORTS-START>');
          const posImportsEnd    = existing.indexOf('// <SS-IMPORTS-END>');
          const posHelpersStart  = existing.indexOf('// <SS-HELPERS-START>');
          const posHelpersEnd    = existing.indexOf('// <SS-HELPERS-END>');
          const posUserStart     = existing.indexOf('// <SS-USER-TESTS>');
          const posUserEnd       = existing.indexOf('// </SS-USER-TESTS>');
          const posGenStart      = existing.indexOf('// <SS-GENERATED-START');
          const posGenEnd        = existing.indexOf('// <SS-GENERATED-END>');

          const zoneOrderValid =
            posImportsStart  < posImportsEnd   &&
            posImportsEnd    < posHelpersStart &&
            posHelpersStart  < posHelpersEnd   &&
            posHelpersEnd    < posUserStart    &&
            posUserStart     < posUserEnd      &&
            posUserEnd       < posGenStart     &&
            posGenStart      < posGenEnd;

          if (!zoneOrderValid) {
            const zoneOrderReason =
              posImportsStart  >= posImportsEnd   ? 'SS-IMPORTS-START must precede SS-IMPORTS-END' :
              posImportsEnd    >= posHelpersStart ? 'SS-IMPORTS-END must precede SS-HELPERS-START' :
              posHelpersStart  >= posHelpersEnd   ? 'SS-HELPERS-START must precede SS-HELPERS-END' :
              posHelpersEnd    >= posUserStart    ? 'SS-HELPERS-END must precede SS-USER-TESTS' :
              posUserStart     >= posUserEnd      ? 'SS-USER-TESTS must precede /SS-USER-TESTS' :
              posUserEnd       >= posGenStart     ? '/SS-USER-TESTS must precede SS-GENERATED-START' :
              'SS-GENERATED-START must precede SS-GENERATED-END';
            log('Spec file: zone order invalid — skipping write');
            log(`Context: ${ctx.specPath} — ${zoneOrderReason}`);
            return;
          }
        }
      }
    }

    // Phase 5 — abort any in-flight request for this file, start new one
    const existingController = pendingRequests.get(filePath);
    if (existingController) {
      existingController.abort();
    }

    const controller = new AbortController();
    pendingRequests.set(filePath, controller);

    // Pass ctx to the caller — it will stamp ctx.workList and call buildPrompt(ctx)
    await onPromptReady(
      ctx,
      filePath,
      log,
      controller.signal,
      astResult.exportedFunctions,
      astResult.exportTypes
    );

    // Post-batch: banner management + coverage gap check — single read-modify-write.
    // Banner is injected (safe mode) or removed (full mode) then the spec is written once.
    if (ctx.specPath && fsSync.existsSync(ctx.specPath)) {
      try {
        let specContent = await fs.readFile(ctx.specPath, 'utf8');
        const originalContent = specContent;

        // Inject or remove the degraded-mode banner based on preflight outcome.
        if (preflightResult.mode === 'safe' && preflightResult.displayCmd) {
          specContent = injectBanner(specContent, preflightResult.displayCmd);
        } else {
          specContent = removeBanner(specContent);
        }

        // Authoritative coverage gap check: AST exports vs marker.covered.
        const { marker } = readMarker(specContent);
        if (marker) {
          const trulyMissing = astResult.exportedFunctions.filter(
            f => !marker.covered.includes(f)
          );
          log(`Gap check: exported=${astResult.exportedFunctions.length} covered=${marker.covered.length} missing=${trulyMissing.length}`);
          if (trulyMissing.length > 0) {
            log(`Coverage gap detected: [${trulyMissing.join(', ')}] not in spec — queuing for Gap Finder`);
            const newPending = [...new Set([...marker.pending, ...trulyMissing])];
            specContent = updateMarkerOnly(specContent, { ...marker, pending: newPending });

          }
        }

        if (specContent !== originalContent) {
          await fs.writeFile(ctx.specPath, specContent, 'utf8');
        }
      } catch (err: unknown) {
        // Spec may not exist if onPromptReady failed — not an error
        const msg = err instanceof Error ? err.message : String(err);
        log(`Post-batch: could not update spec marker — ${msg}`);
      }
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Error handling file save for ${path.basename(filePath)} — ${msg}`);
  } finally {
    // Always clean up — even if onPromptReady threw or was aborted
    pendingRequests.delete(filePath);
    debounceTimers.delete(filePath);
  }
}

export function registerSaveHandler(
  context: vscode.ExtensionContext,
  isPausedFn: () => boolean,
  updateStatus: (text: string) => void,
  onPromptReady: (
    ctx: SilentSpecContext,
    filePath: string,
    log: (msg: string) => void,
    abortSignal: AbortSignal,
    exportedFunctions: string[],
    exportTypes: Record<string, 'default' | 'named'>
  ) => Promise<void>,
  earlyGuard?: (filePath: string) => string | null
): void {
  log('SilentSpec save handler registered');

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    (document: vscode.TextDocument) => {
      if (document.isUntitled) { log('Skipped: untitled document'); return; }
      if (document.uri.scheme !== 'file') { log(`Skipped: non-file scheme (${document.uri.scheme})`); return; }
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        log('Skipped: no workspace folder open');
        return;
      }

      const filePath = document.uri.fsPath;

      if (isPausedFn()) {
        log(`Skipped: extension paused — ${filePath}`);
        return;
      }

      const { skip, reason } = shouldSkip(filePath);
      if (skip) {
        log(`Skipped: ${reason} — ${filePath}`);
        return;
      }

      // Debounce — clear existing timer for this file if present
      const existingTimer = debounceTimers.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      log(`Save detected: ${filePath} — waiting 2s...`);

      const timer = setTimeout(() => {
        debounceTimers.delete(filePath);
        void handleFileSave(filePath, updateStatus, onPromptReady, false, earlyGuard);
      }, 2000);

      debounceTimers.set(filePath, timer);
    }
  );

  // Bug 1 fix — invalidate checkedRoots when tsconfig.json changes.
  // Without this, a verified root stays cached even if tsconfig later loses
  // its types entry, causing the tsconfig check to never re-run.
  const tsconfigWatcher = vscode.workspace.onDidChangeTextDocument(e => {
    if (path.basename(e.document.fileName) === 'tsconfig.json') {
      for (const root of checkedRoots) {
        if (e.document.fileName.startsWith(root)) {
          checkedRoots.delete(root);
          log(`Pre-flight cache cleared — tsconfig.json changed in ${root}`);
          break;
        }
      }
    }
  });

  context.subscriptions.push(saveListener, tsconfigWatcher);
}