import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';

const DEFAULT_MODEL = 'gpt-4o';
const API_URL = 'https://api.openai.com/v1/chat/completions';
 
export class OpenAIProvider implements AIProvider {
  private readonly model: string;
  private secrets!: vscode.SecretStorage;
 
  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }
 
  getSystemInstructions(): string {
    return 'Output only valid TypeScript. No explanations outside code comments.';
  }
 
  withSecrets(secrets: vscode.SecretStorage): this {
    this.secrets = secrets;
    return this;
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    // If external signal aborts (re-save cancellation), abort this controller too
    abortSignal?.addEventListener('abort', () => {
      controller.abort();
      clearTimeout(timeout);
    });

 
    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
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

        // Handle expired or revoked token — clear key and prompt re-setup
        if (response.status === 401) {
          log('Error: API key rejected (401) — key may be expired or revoked');
          await this.secrets.delete('silentspec.openaiApiKey'); // use correct key per provider
          void vscode.window.showWarningMessage(
            'SilentSpec: Your API key was rejected. It may have expired or been revoked.',
            'Set Up New Key'
          ).then(action => {
            if (action === 'Set Up New Key') {
              void vscode.commands.executeCommand('silentspec.setApiKey');
            }
          });
          return null;
        }

        log(`Error: API returned ${response.status} — ${errorBody}`);
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