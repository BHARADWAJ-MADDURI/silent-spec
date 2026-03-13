import { AIProvider } from './aiProvider';

const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL   = 'deepseek-coder:6.7b';
const TIMEOUT_MS      = 120_000; // 2 minutes — local models are slower

export class OllamaProvider implements AIProvider {
  private readonly model: string;

  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }
  
  getSystemInstructions(): string {
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Forward external abort signal into our controller
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearTimeout(timeout);
        controller.abort();
      });
    }

    log(`Ollama: generating with model ${this.model}...`);

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: {
            num_predict: 4096,
            temperature: 0.2,
          },
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        log(`Ollama error ${response.status}: ${text}`);
        return null;
      }

      const data = await response.json() as { response?: string };

      if (!data.response) {
        log('Ollama: empty response');
        return null;
      }

      return data.response;

    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Ollama: request aborted');
        return null;
      }

      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        log('Ollama: connection refused — is Ollama running? Run: ollama serve');
        return null;
      }

      log(`Ollama: unexpected error — ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}