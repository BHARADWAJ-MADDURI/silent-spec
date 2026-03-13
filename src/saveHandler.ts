import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeFile } from './astAnalyzer';
import { extractContext } from './contextExtractor';
import { buildPrompt } from './promptBuilder';
import { resolveSpecPath } from './fileWriter';

export const outputChannel = vscode.window.createOutputChannel('SilentSpec');

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

export function registerSaveHandler(
  context: vscode.ExtensionContext,
  isPausedFn: () => boolean,
  onPromptReady: (
    prompt: string,
    filePath: string,
    log: (msg: string) => void,
    abortSignal: AbortSignal
  ) => Promise<void>
): void {
  log('SilentSpec save handler registered');

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const saveListener = vscode.workspace.onDidSaveTextDocument(
    (document: vscode.TextDocument) => {
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

      const existingTimer = debounceTimers.get(filePath);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      log(`Save detected: ${filePath} — waiting 2s...`);

      debounceTimers.set(filePath, setTimeout(() => {
        debounceTimers.delete(filePath);

        void (async () => {
          // Phase 2 — AST gate
          const result = analyzeFile(filePath, log);
          if (!result.isTestable) {
            log(`Skipped: ${result.skipReason} — ${filePath}`);
            return;
          }
          log(`Testable: [${result.exportedFunctions.join(', ')}] — ${filePath}`);

          // Phase 3 — context extraction
          const ctx = extractContext(
            filePath,
            result.exportedFunctions,
            result.imports,
            log
          );
          log(`Context ready — framework=${ctx.framework}, pattern=${ctx.testPatternSample ? 'found' : 'none'}`);

          // Phase 7 — resolve specPath before buildPrompt
          // so import hints in prompt are relative to spec location
          ctx.specPath = await resolveSpecPath(filePath);
          log(`Spec path resolved: ${path.basename(ctx.specPath)}`);

          // Phase 4 — build prompt with full context including deps
          const prompt = buildPrompt(ctx);

          // Phase 5 — hand off to provider via callback
          const existingController = pendingRequests.get(filePath);
          if (existingController) {
            existingController.abort();
            pendingRequests.delete(filePath);
          }

          const controller = new AbortController();
          pendingRequests.set(filePath, controller);

          await onPromptReady(prompt, filePath, log, controller.signal);
        })();
      }, 2000));
    }
  );

  context.subscriptions.push(saveListener);
}