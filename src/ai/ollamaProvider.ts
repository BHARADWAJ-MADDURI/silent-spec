import { AIProvider } from './aiProvider';

const OLLAMA_BASE_URL = 'http://localhost:11434';

// Model is intentionally empty — resolved at runtime via detectBestModel().
// Users can override via silentspec.model in VS Code settings.
// Fallback is used only when Ollama has no models installed at all.
const FALLBACK_MODEL = 'llama3.2';

// Preferred models in priority order — first available wins.
// deepseek-coder variants are best for code generation.
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

// Local models are significantly slower than cloud providers.
// 2 minutes gives headroom for large files on modest hardware.
const TIMEOUT_MS = 120_000;

async function detectBestModel(): Promise<string | null> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) { return FALLBACK_MODEL; }

    const data = await response.json() as { models?: { name: string }[] };
    const available = data.models?.map(m => m.name) ?? [];

    if (available.length === 0) { return null; }

    // Pick first preferred model that's available
    for (const preferred of PREFERRED_MODELS) {
      const rootName = preferred.split(':')[0];
      const match = available.find(m => m.startsWith(rootName));
      if (match) { return match; }
    }

    // Fall back to first available model if none of our preferred are present
    return available[0] ?? FALLBACK_MODEL;
  } catch {
    return FALLBACK_MODEL;
  }
}

export class OllamaProvider implements AIProvider {
  private readonly modelOverride: string;
  private resolvedModel: string | null = null;

  constructor(model?: string) {
    this.modelOverride = model || '';
  }

  getSystemInstructions(): string {
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  private async getModel(): Promise<string | null> {
    // User override takes highest priority
    if (this.modelOverride) { return this.modelOverride; }

    // Cached resolved model — only detect once per provider instance
    if (this.resolvedModel) { return this.resolvedModel; }

    this.resolvedModel = await detectBestModel();
    return this.resolvedModel;
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    abortSignal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      controller.abort();
    });

    const model = await this.getModel();
    if (!model) {
      clearTimeout(timeout);
      log("Ollama: no models installed — run 'ollama pull llama3.2' to get started");
      return null;
    }
    log(`Ollama: generating with model ${model}...`);

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
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
        // D2 fix: if Ollama says the model doesn't exist, clear the cached model so
        // the next request re-detects a currently-available model. Only clears the
        // auto-resolved model, not a user-configured override.
        if (!this.modelOverride && (response.status === 404 || /not found/i.test(text))) {
          log('Ollama: cached model is stale — will re-detect on next request');
          this.resolvedModel = null;
        }
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
        log('Ollama: request aborted — timeout or re-save cancellation');
        return null;
      }

      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        log('Ollama: connection refused — is Ollama running? Start with: ollama serve');
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`Ollama: unexpected error — ${msg}`);
      return null;
    }
  }
}