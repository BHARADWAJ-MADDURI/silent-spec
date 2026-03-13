import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';

const DEFAULT_MODEL = 'gpt-4o';
const API_URL       = 'https://models.inference.ai.azure.com/chat/completions';

export class GitHubModelsProvider implements AIProvider {
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
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const token = await this.secrets.get('silentspec.githubToken');

    if (!token) {
      log('Error: GitHub token not set — run SilentSpec: Set API Key and select github');
      return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeout);
        controller.abort();
      });
    }

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
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
        log(`Error: GitHub Models returned ${response.status} — ${errorBody}`);
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