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
      log('Error: OpenAI API key not set — run SilentSpec: Set API Key');
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
        log(`Error: OpenAI API returned ${response.status} ${response.statusText}`);
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