import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';

// Model is intentionally empty — resolved at runtime from user settings.
// Fallback is the current recommended OpenAI model.
// Users can override via silentspec.model in VS Code settings without
// needing an extension update when OpenAI releases new models.
const FALLBACK_MODEL = 'gpt-4o';
const API_URL = 'https://api.openai.com/v1/chat/completions';

export class OpenAIProvider implements AIProvider {
  private readonly modelOverride: string;
  private secrets!: vscode.SecretStorage;

  constructor(model?: string) {
    this.modelOverride = model || '';
  }

  getSystemInstructions(): string {
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  withSecrets(secrets: vscode.SecretStorage): this {
    this.secrets = secrets;
    return this;
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
    const apiKey = await this.secrets.get('silentspec.openaiApiKey');

    if (!apiKey) {
      log('Error: OpenAI API key not set — showing setup guidance');
      void vscode.window.showInformationMessage(
        'SilentSpec: OpenAI API key not set.',
        'Set Up Key',
        'Open OpenAI Dashboard'
      ).then(action => {
        if (action === 'Set Up Key') {
          void vscode.commands.executeCommand('silentspec.setApiKey');
        } else if (action === 'Open OpenAI Dashboard') {
          void vscode.env.openExternal(
            vscode.Uri.parse('https://platform.openai.com/api-keys')
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
    log(`Calling OpenAI model: ${model}`);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [
            { role: 'system', content: this.getSystemInstructions() },
            { role: 'user', content: prompt },
          ],
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();

        if (response.status === 401) {
          log('Error: OpenAI API key rejected (401) — key may be expired or revoked');
          await this.secrets.delete('silentspec.openaiApiKey');
          void vscode.window.showWarningMessage(
            'SilentSpec: Your OpenAI API key was rejected. It may have expired or been revoked.',
            'Set Up New Key'
          ).then(action => {
            if (action === 'Set Up New Key') {
              void vscode.commands.executeCommand('silentspec.setApiKey');
            }
          });
          return null;
        }

        if (response.status === 429) {
          log(`Error: OpenAI rate limit hit (429) — ${errorBody}`);
          void vscode.window.showWarningMessage(
            'SilentSpec: OpenAI rate limit reached. Try again in a moment or switch providers.'
          );
          return null;
        }

        log(`Error: OpenAI API returned ${response.status} — ${errorBody}`);
        return null;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      return data.choices[0]?.message?.content || null;

    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Warning: OpenAI API request aborted — timeout or re-save cancellation');
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`Error: OpenAI API call failed — ${msg}`);
      return null;
    }
  }
}