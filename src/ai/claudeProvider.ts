import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const API_URL = 'https://api.anthropic.com/v1/messages';

export class ClaudeProvider implements AIProvider {
  private readonly model: string;
  private secrets!: vscode.SecretStorage;

  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }

  withSecrets(secrets: vscode.SecretStorage): this {
    this.secrets = secrets;
    return this;
  }

  getSystemInstructions(): string {
    return 'Be concise. Output only valid TypeScript test code.';
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const apiKey = await this.secrets.get('silentspec.claudeApiKey');

    if (!apiKey) {
      log('Error: Claude API key not set — run SilentSpec: Set API Key');
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    // If external signal aborts (re-save cancellation), abort this controller too
    abortSignal?.addEventListener('abort', () => controller.abort());

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
          model: this.model,
          max_tokens: 4096,
          system: this.getSystemInstructions(),
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        log(`Error: Claude API returned ${response.status} ${response.statusText}— ${errorBody}`);
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