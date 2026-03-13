import * as vscode from 'vscode';
import { registerSaveHandler, outputChannel } from './saveHandler';
import { AIProvider } from './ai/aiProvider';
import { OpenAIProvider } from './ai/openaiProvider';
import { ClaudeProvider } from './ai/claudeProvider';
import { OllamaProvider } from './ai/ollamaProvider';
import { GitHubModelsProvider } from './ai/githubModelsProvider';
import { validateResponse } from './utils/validateResponse';
import { processingQueue } from './utils/processingQueue';
import { writeSpecFile } from './fileWriter';

// Provider factory
function getProvider(context: vscode.ExtensionContext): AIProvider {
  const config = vscode.workspace.getConfiguration('silentspec');
  const providerName = config.get<string>('provider', 'ollama');
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
  // Default — Ollama, free, no API key needed
  return new OllamaProvider(modelOverride);
}

export function activate(context: vscode.ExtensionContext) {

  // Status bar
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

  // Toggle pause command
  const toggleCmd = vscode.commands.registerCommand(
    'silentspec.togglePause',
    async () => {
      isPaused = !isPaused;
      await context.workspaceState.update('silentspec.paused', isPaused);
      updateStatusBar();
    }
  );
  context.subscriptions.push(toggleCmd);

  // Set API key command — handles both providers
  const setKeyCmd = vscode.commands.registerCommand(
    'silentspec.setApiKey',
    async () => {
      const provider = await vscode.window.showQuickPick(
        ['claude', 'openai', 'github'],
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
        : provider === 'github'
        ? 'silentspec.githubToken'
        : 'silentspec.openaiApiKey';
      
      const displayName = provider === 'claude'
        ? 'Claude'
        : provider === 'github'
        ? 'GitHub'
        : 'OpenAI';

      await context.secrets.store(secretKey, key.trim());
      vscode.window.showInformationMessage(
        `SilentSpec: ${displayName} API key saved ✓`
      );
    }
  );
  context.subscriptions.push(setKeyCmd);

  // Register save handler
  registerSaveHandler(context, () => isPaused, async (prompt, filePath, log, abortSignal) => {
    const config = vscode.workspace.getConfiguration('silentspec');
    const providerName = config.get<string>('provider', 'ollama');

    processingQueue.enqueue(async () => {
      log(`Calling ${providerName} for ${filePath}...`);
      updateStatusBar('$(loading~spin) SS: Generating...');

      const provider = getProvider(context);
      const raw = await provider.generateTests(prompt, log, abortSignal);

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

      log(`Response validated — writing spec file for ${filePath}`);
      await writeSpecFile(filePath, validated, log);

      setTimeout(() => updateStatusBar(), 3000);
      updateStatusBar('$(check) SS: Done');
    });
  });

  context.subscriptions.push(outputChannel);
}

export function deactivate() {}