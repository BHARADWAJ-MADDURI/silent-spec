import * as vscode from 'vscode';
import { analyzeFile } from './astAnalyzer';
import { extractContext } from './contextExtractor';

// Output channel - visible in View -> Output -> SilentSpec
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

export function registerSaveHandler(
  context: vscode.ExtensionContext,
  isPausedFn: () => boolean
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

        // Phase 3 — Context extraction
        const silentSpecContext = extractContext(
          filePath,
          result.exportedFunctions,
          result.imports,
          log
        );
        log(`Context ready — framework=${silentSpecContext.framework}, pattern=${silentSpecContext.testPatternSample ? 'found' : 'none'}`);

        // Phase 4 — Prompt builder goes here

      }, 2000));
    }
  );

  // ✅ Fixed: push listener to subscriptions OUTSIDE the setTimeout
  context.subscriptions.push(saveListener);
}