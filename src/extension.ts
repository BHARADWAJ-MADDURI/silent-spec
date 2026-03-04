import * as vscode from 'vscode';
import { registerSaveHandler, outputChannel } from './saveHandler';

// Config reader
function getConfig() {
  return vscode.workspace.getConfiguration('silentspec');
}

export function activate(context: vscode.ExtensionContext) {

  // API Key helpers — stored in OS keychain via SecretStorage
  async function getApiKey(): Promise<string | undefined> {
    return context.secrets.get('silentspec.apiKey');
  }

  async function storeApiKey(key: string): Promise<void> {
    await context.secrets.store('silentspec.apiKey', key);
  }

  // Set API Key command
  const setKeyCmd = vscode.commands.registerCommand(
    'silentspec.setApiKey',
    async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Claude API key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-...',
      });
      if (key && key.trim().length > 0) {
        await storeApiKey(key.trim());
        vscode.window.showInformationMessage('SilentSpec: API key saved securely ✓');
      }
    }
  );
  context.subscriptions.push(setKeyCmd);

  // Status bar toggle
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBar.command = 'silentspec.togglePause';

  let isPaused = context.workspaceState.get<boolean>('silentspec.paused', false);

  function updateStatusBar() {
    statusBar.text = isPaused ? '$(debug-pause) SS: Paused' : '$(zap) SS: On';
    statusBar.tooltip = isPaused
      ? 'SilentSpec paused — click to resume'
      : 'SilentSpec active — click to pause';
    statusBar.backgroundColor = isPaused
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  const toggleCmd = vscode.commands.registerCommand(
    'silentspec.togglePause',
    async () => {
      isPaused = !isPaused;
      await context.workspaceState.update('silentspec.paused', isPaused);
      updateStatusBar();
    }
  );
  context.subscriptions.push(toggleCmd);

	// Register save handler
	registerSaveHandler(context, () => isPaused);
	context.subscriptions.push(outputChannel);
}

export function deactivate() {}