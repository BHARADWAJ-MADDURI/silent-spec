import * as vscode from 'vscode';
import { analyzeFile } from './astAnalyzer';

// Output channel - visibile in View -> Output -> SilentSpec

export const outputChannel = vscode.window.createOutputChannel('SilentSpec');

function getConfig() {
  return vscode.workspace.getConfiguration('silentspec');
}

function log(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);  
}

function shouldSkip(filePath: string): {skip: boolean, reason?: string} {
  const supported = getConfig().get<string[]>(
    'supportedExtensions', ['.ts', '.tsx', '.js', '.jsx']
  );

  if (/\.(test|spec)\.[tj]sx?$/.test(filePath)) {
    return { skip: true, reason: 'Test file' };
  }

  const ext = filePath.slice(filePath.lastIndexOf('.'));
  if (!supported.includes(ext)) {
    return { skip: true, reason: `Unsupported extension (${ext})` };
  }

  if (/node_modules|[/\\](dist|out)[/\\]/.test(filePath)) {
    return { skip: true, reason: 'build/dependency folder' };
  }
  return { skip: false };

}
export function registerSaveHandler(
  context: vscode.ExtensionContext,
  isPausedFn: () => boolean
) : void { 
  log('SilentSpec save handler registered');

  const debounceTimers = new Map<string, NodeJS.Timeout>();

  const saveListner = vscode.workspace.onDidSaveTextDocument(
    (document: vscode.TextDocument) => {
      const filePath = document.uri.fsPath;

      if (isPausedFn()) {
        log(`Skipped: Save ignored (extension paused) - ${filePath}`);
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
      log(`Save detected: ${filePath} - waiting 2s...`);
      debounceTimers.set(filePath, setTimeout(() => {
        debounceTimers.delete(filePath);

        const result = analyzeFile(filePath);
        if (!result.isTestable) {
          log(`Skipped: ${result.skipReason} - ${filePath}`);
          return;
        }
        log(`Testable: found [${result.exportedFunctions.join(', ')}] in ${filePath}`);
      }, 2000));
    
  context.subscriptions.push(saveListner);
  });
}