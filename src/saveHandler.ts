import * as vscode from 'vscode';
import { analyzeFile } from './astAnalyzer';
import { extractContext } from './contextExtractor';
import { buildPrompt } from './promptBuilder';

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
  onPromptReady: (prompt: string, filePath: string, log: (msg: string) => void, abortSignal: AbortSignal) => Promise<void>
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

      const existing = debounceTimers.get(filePath);
      if (existing) {
        clearTimeout(existing);
      }

      log(`Save detected: ${filePath} — waiting 2s...`);

      debounceTimers.set(filePath, setTimeout(() => {
        debounceTimers.delete(filePath);

        // Phase 2 — AST gate
        const result = analyzeFile(filePath, log);
        if (!result.isTestable) {
          log(`Skipped: ${result.skipReason} — ${filePath}`);
          return;
        }
        log(`Testable: [${result.exportedFunctions.join(', ')}] — ${filePath}`);

        // Context extraction and prompt build
        const ctx = extractContext(
          filePath,
          result.exportedFunctions,
          result.imports,
          log
        );
        log(`Context ready — framework=${ctx.framework}, pattern=${ctx.testPatternSample ? 'found' : 'none'}`);

        const prompt = buildPrompt(ctx);

        // Phase 5 — hand off to provider via callback
        const existing = pendingRequests.get(filePath);
        if (existing) {
          existing.abort();
          pendingRequests.delete(filePath);
        }

        const controller = new AbortController();
        pendingRequests.set(filePath, controller);

        void onPromptReady(prompt, filePath, log, controller.signal);
      }, 2000));
    }
  );

  context.subscriptions.push(saveListener);
}