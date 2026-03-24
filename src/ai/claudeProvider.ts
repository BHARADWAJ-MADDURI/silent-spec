import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';

// Model is intentionally empty — resolved at runtime from user settings.
// Fallback is the current recommended Claude model.
// Users can override via silentspec.model in VS Code settings without
// needing an extension update when Anthropic releases new models.
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

export class ClaudeProvider implements AIProvider {
  private readonly modelOverride: string;
  private secrets!: vscode.SecretStorage;

  constructor(model?: string) {
    this.modelOverride = model || '';
  }

  withSecrets(secrets: vscode.SecretStorage): this {
    this.secrets = secrets;
    return this;
  }

  getSystemInstructions(): string {
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  private getModel(): string {
    const configModel = vscode.workspace
      .getConfiguration('silentspec')
      .get<string>('model', '');
    return this.modelOverride || configModel || FALLBACK_MODEL;
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const apiKey = await this.secrets.get('silentspec.claudeApiKey');

    if (!apiKey) {
      log('Error: Claude API key not set — showing setup guidance');
      void vscode.window.showInformationMessage(
        'SilentSpec: Claude API key not set.',
        'Set Up Key',
        'Open Anthropic Console'
      ).then(action => {
        if (action === 'Set Up Key') {
          void vscode.commands.executeCommand('silentspec.setApiKey');
        } else if (action === 'Open Anthropic Console') {
          void vscode.env.openExternal(
            vscode.Uri.parse('https://console.anthropic.com/settings/keys')
          );
        }
      });
      return null;
    }

    const timeoutMs = vscode.workspace
      .getConfiguration('silentspec')
      .get<number>('aiTimeoutSeconds', 60) * 1000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    abortSignal?.addEventListener('abort', () => {
      controller.abort();
      clearTimeout(timeout);
    });

    const model = this.getModel();
    log(`Calling Claude model: ${model}`);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: this.getSystemInstructions(),
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();

        if (response.status === 401) {
          log('Error: Claude API key rejected (401) — key may be expired or revoked');
          await this.secrets.delete('silentspec.claudeApiKey');
          void vscode.window.showWarningMessage(
            'SilentSpec: Your Claude API key was rejected. It may have expired or been revoked.',
            'Set Up New Key'
          ).then(action => {
            if (action === 'Set Up New Key') {
              void vscode.commands.executeCommand('silentspec.setApiKey');
            }
          });
          return null;
        }

        if (response.status === 429) {
          log(`Error: Claude rate limit hit (429) — ${errorBody}`);
          void vscode.window.showWarningMessage(
            'SilentSpec: Claude rate limit reached. Try again in a moment or switch providers.'
          );
          return null;
        }

        log(`Error: Claude API returned ${response.status} — ${errorBody}`);
        return null;
      }

      const data = await response.json() as {
        content: Array<{ type: string; text: string }>;
      };

      const text = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      return text || null;

    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Warning: Claude API request aborted — timeout or re-save cancellation');
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`Error: Claude API call failed — ${msg}`);
      return null;
    }
  }
}