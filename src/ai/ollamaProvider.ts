import { AIProvider } from './aiProvider';

const OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL   = 'llama3.2'; 
const PREFERRED_MODELS = [
  'deepseek-coder:6.7b',
  'deepseek-coder',
  'codellama',
  'codellama:7b',
  'llama3.2',
  'llama3',
  'llama2',
  'mistral',
  'phi3',
];
const TIMEOUT_MS      = 120_000; // 2 minutes — local models are slower

async function detectBestModel(): Promise<string> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) { return DEFAULT_MODEL; }
    const data = await response.json() as { models?: { name: string }[] };
    const available = data.models?.map(m => m.name) ?? [];
    // Pick first preferred model that's available
    for (const preferred of PREFERRED_MODELS) {
      if (available.some(m => m.startsWith(preferred.split(':')[0]))) {
        return available.find(m => m.startsWith(preferred.split(':')[0])) ?? preferred;
      }
    }
    // Fall back to first available model
    return available[0] ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export class OllamaProvider implements AIProvider {
  private readonly model: string;

  private resolvedModel: string | null = null;

  constructor(model?: string) {
    this.model = model || DEFAULT_MODEL;
  }

  private async getModel(): Promise<string> {
    if (this.resolvedModel) { return this.resolvedModel; }
    if (this.model !== DEFAULT_MODEL) { return this.model; }
    this.resolvedModel = await detectBestModel();
    return this.resolvedModel;
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

    const model = await this.getModel();
    log(`Ollama: generating with model ${model}...`);

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: model,
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