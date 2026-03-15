import * as vscode from 'vscode';
import { registerSaveHandler, outputChannel } from './saveHandler';
import { AIProvider } from './ai/aiProvider';
import { OpenAIProvider } from './ai/openaiProvider';
import { ClaudeProvider } from './ai/claudeProvider';
import { OllamaProvider } from './ai/ollamaProvider';
import { GitHubModelsProvider } from './ai/githubModelsProvider';
import { validateResponse } from './utils/validateResponse';
import { processingQueue } from './utils/processingQueue';
import { writeSpecFile, mergeSpecFile } from './fileWriter';
import { runGapFinder } from './gapFinder';

// Ollama auto-detect — live check on every generation
// Prevents stale cached state when user kills Ollama mid-session
async function isOllamaRunning(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Provider factory
function getProvider(
  context: vscode.ExtensionContext,
  providerOverride?: string
): AIProvider {
  const config = vscode.workspace.getConfiguration('silentspec');
  const providerName = providerOverride ?? config.get<string>('provider', 'github');
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

  // ollama — free, local, no API key needed
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

  // Live Ollama check — called on every generation to handle mid-session kills
  async function getActiveProvider(): Promise<AIProvider> {
    const config = vscode.workspace.getConfiguration('silentspec');
    const configuredProvider = config.get<string>('provider', 'github');
    if (configuredProvider === 'github') {
      const ollamaUp = await isOllamaRunning();
      if (ollamaUp) {
        return getProvider(context, 'ollama');
      }
    }
    return getProvider(context);
  }

  // Returns provider name string — single await, reused for logging
  async function getActiveProviderName(): Promise<string> {
    const config = vscode.workspace.getConfiguration('silentspec');
    const configuredProvider = config.get<string>('provider', 'github');
    if (configuredProvider === 'github') {
      const ollamaUp = await isOllamaRunning();
      if (ollamaUp) { return 'ollama'; }
    }
    return configuredProvider;
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

  // Set API key command — handles all providers
  const setKeyCmd = vscode.commands.registerCommand(
    'silentspec.setApiKey',
    async () => {
      const provider = await vscode.window.showQuickPick(
        ['claude', 'openai', 'github'],
        { placeHolder: 'Select provider to set API key for' }
      );
      if (!provider) { return; }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider === 'claude' ? 'Anthropic' : provider === 'github' ? 'GitHub' : 'OpenAI'} API key`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: provider === 'claude' ? 'sk-ant-...' : provider === 'github' ? 'ghp_...' : 'sk-...',
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

  // Gap Finder command
  const gapFinderCmd = vscode.commands.registerCommand(
    'silentspec.findGaps',
    async () => {
      await runGapFinder(
        (msg: string) => outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`),
        async (prompt, filePath, log, abortSignal, isMerge) => {
          processingQueue.enqueue(async () => {
            // Resolve provider once — reuse for both logging and generation
            const providerName = await getActiveProviderName();
            const provider = await getActiveProvider();

            log(`Gap Finder: calling ${providerName}...`);
            updateStatusBar('$(sync~spin) SS: Generating...');

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

            if (isMerge) {
              await mergeSpecFile(filePath, validated, log);
            } else {
              await writeSpecFile(filePath, validated, log);
            }

            updateStatusBar('$(check) SS: Done');
            setTimeout(() => updateStatusBar(), 3000);
          });
        }
      );
    }
  );
  context.subscriptions.push(gapFinderCmd);

  function updateStatus(text: string): void {
    if (!text) { updateStatusBar(); return; }
    statusBar.text = text;
    statusBar.backgroundColor = undefined;
  }

  // Register save handler
  registerSaveHandler(context, () => isPaused, updateStatus, async (prompt, filePath, log, abortSignal) => {
    processingQueue.enqueue(async () => {
      // Resolve provider once — reuse for both logging and generation
      // Live check ensures Ollama state is current even if killed mid-session
      const providerName = await getActiveProviderName();
      const provider = await getActiveProvider();

      log(`Calling ${providerName} for ${filePath}...`);
      updateStatusBar('$(sync~spin) SS: Generating...');

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