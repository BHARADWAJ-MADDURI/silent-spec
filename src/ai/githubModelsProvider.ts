import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';

// Model is intentionally empty — resolved at runtime from user settings.
// Fallback is the current recommended GitHub Models default.
// Users can override via silentspec.model in VS Code settings without
// needing an extension update when GitHub Models updates available models.
const FALLBACK_MODEL = 'gpt-4o';
const API_URL = 'https://models.inference.ai.azure.com/chat/completions';

export class GitHubModelsProvider implements AIProvider {
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
    const token = await this.secrets.get('silentspec.githubToken');

    if (!token) {
      log('Error: GitHub token not set — showing setup guidance');
      void vscode.window.showInformationMessage(
        'SilentSpec needs a free GitHub token to generate tests.',
        'Set Up Token',
        'Open GitHub Tokens Page'
      ).then(action => {
        if (action === 'Set Up Token') {
          void vscode.commands.executeCommand('silentspec.setApiKey');
        } else if (action === 'Open GitHub Tokens Page') {
          void vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/settings/tokens')
          );
          setTimeout(() => {
            void vscode.commands.executeCommand('silentspec.setApiKey');
          }, 3000);
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
      clearTimeout(timeout);
      controller.abort();
    });

    const model = this.getModel();
    log(`Calling GitHub Models: ${model}`);

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
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
          log('Error: GitHub token rejected (401) — token may be expired or revoked');
          await this.secrets.delete('silentspec.githubToken');
          void vscode.window.showWarningMessage(
            'SilentSpec: Your GitHub token was rejected. It may have expired or been revoked.',
            'Set Up New Token'
          ).then(action => {
            if (action === 'Set Up New Token') {
              void vscode.commands.executeCommand('silentspec.setApiKey');
            }
          });
          return null;
        }

        if (response.status === 429) {
          log(`Error: GitHub Models rate limit hit (429) — ${errorBody}`);
          void vscode.window.showWarningMessage(
            'SilentSpec: GitHub Models rate limit reached. Free tier is 50 requests/day. Try again tomorrow or switch to Claude/OpenAI.'
          );
          return null;
        }

        log(`Error: GitHub Models API returned ${response.status} — ${errorBody}`);
        return null;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      return data.choices[0]?.message?.content || null;

    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Warning: GitHub Models request aborted — timeout or re-save cancellation');
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`Error: GitHub Models API call failed — ${msg}`);
      return null;
    }
  }
}