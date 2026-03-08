import * as vscode from 'vscode';
import { registerSaveHandler, outputChannel } from './saveHandler';
import { OpenAIProvider } from './ai/openaiProvider';
import { ClaudeProvider } from './ai/claudeProvider';
import { AIProvider } from './ai/aiProvider';
import { validateResponse } from './utils/validateResponse';
import { processingQueue } from './utils/processingQueue';

// ── Provider factory —─────────────────────────────────────────────────────────
function getProvider(context: vscode.ExtensionContext): AIProvider {
  const config = vscode.workspace.getConfiguration('silentspec');
  const providerName = config.get<string>('provider', 'claude');
  const modelOverride = config.get<string>('model', '') || undefined;

  if (providerName === 'openai') {
    return new OpenAIProvider(modelOverride).withSecrets(context.secrets);
  }
  return new ClaudeProvider(modelOverride).withSecrets(context.secrets);
}

export function activate(context: vscode.ExtensionContext) {

  // ── Status bar ──────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBar.command = 'silentspec.togglePause';

  let isPaused = context.workspaceState.get<boolean>('silentspec.paused', false);

  function updateStatusBar(text?: string) {
    if (text) {
      statusBar.text = text;
      statusBar.backgroundColor = undefined;
      return;
    }
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

  // ── Toggle pause command ────────────────────────────────────────────────────
  const toggleCmd = vscode.commands.registerCommand(
    'silentspec.togglePause',
    async () => {
      isPaused = !isPaused;
      await context.workspaceState.update('silentspec.paused', isPaused);
      updateStatusBar();
    }
  );
  context.subscriptions.push(toggleCmd);

  // ── Set API key command — handles both providers ────────────────────────────
  const setKeyCmd = vscode.commands.registerCommand(
    'silentspec.setApiKey',
    async () => {
      const provider = await vscode.window.showQuickPick(
        ['claude', 'openai'],
        { placeHolder: 'Select provider to set API key for' }
      );
      if (!provider) { return; }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider === 'claude' ? 'Anthropic' : 'OpenAI'} API key`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: provider === 'claude' ? 'sk-ant-...' : 'sk-...',
      });

      if (!key || key.trim().length === 0) { return; }

      const secretKey = provider === 'claude'
        ? 'silentspec.claudeApiKey'
        : 'silentspec.openaiApiKey';

      await context.secrets.store(secretKey, key.trim());
      vscode.window.showInformationMessage(
        `SilentSpec: ${provider === 'claude' ? 'Claude' : 'OpenAI'} API key saved ✓`
      );
    }
  );
  context.subscriptions.push(setKeyCmd);

  // ── Register save handler — debounce lives in saveHandler.ts ───────────────
  registerSaveHandler(context, () => isPaused, async (prompt, filePath, log) => {
    const config = vscode.workspace.getConfiguration('silentspec');
    const providerName = config.get<string>('provider', 'claude');

    processingQueue.enqueue(async () => {
      log(`Calling ${providerName} for ${filePath}...`);
      updateStatusBar('$(loading~spin) SS: Generating...');

      const provider = getProvider(context);
      const raw = await provider.generateTests(prompt, log);

      if (!raw) {
        updateStatusBar('$(warning) SS: Failed');
        return;
      }

      const validated = validateResponse(raw, log);

      if (!validated) {
        updateStatusBar('$(warning) SS: Failed');
        return;
      }

      if (validated.includes('// [SS-PARTIAL]')) {
        log(`Warning: partial generation — token limit reached for ${filePath}`);
        updateStatusBar('$(warning) SS: Partial');
      }

      // Phase 6 receives validated here
      log(`Response validated — passing to file writer for ${filePath}`);
      updateStatusBar('$(check) SS: Done');
    });
  });

  context.subscriptions.push(outputChannel);
}

export function deactivate() {}