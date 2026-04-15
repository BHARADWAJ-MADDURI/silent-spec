import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';
import { redactSecrets } from '../utils/validateResponse';
import { isLocalProviderBaseUrl } from '../utils/providerUrlSecurity';

const DEFAULT_BASE_URL = 'http://localhost:8000/v1';

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

export class VllmProvider implements AIProvider {
  private readonly modelOverride: string;

  constructor(model?: string) {
    this.modelOverride = model || '';
  }

  getSystemInstructions(): string {
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  private getBaseUrl(): string {
    return normalizeBaseUrl(
      vscode.workspace.getConfiguration('silentspec').get<string>('vllm.baseUrl', DEFAULT_BASE_URL)
    );
  }

  private getModel(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    return this.modelOverride ||
      config.get<string>('vllm.model', '');
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const model = this.getModel();
    const baseUrl = this.getBaseUrl();
    if (!model) {
      log('vLLM: no model configured — set silentspec.vllm.model');
      void vscode.window.showInformationMessage(
        'SilentSpec: vLLM needs a model name. Set silentspec.vllm.model to match your running server.'
      );
      return null;
    }

    if (!isLocalProviderBaseUrl(baseUrl)) {
      log('vLLM: remote base URL blocked — vLLM provider only supports localhost URLs');
      void vscode.window.showWarningMessage(
        'SilentSpec: vLLM base URL must point to localhost or 127.0.0.1. Use OpenAI-compatible provider only for documented HTTPS hosted APIs.'
      );
      return null;
    }

    const timeoutMs = vscode.workspace
      .getConfiguration('silentspec')
      .get<number>('aiTimeoutSeconds', 120) * 1000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    abortSignal?.addEventListener('abort', () => {
      clearTimeout(timeout);
      controller.abort();
    });

    log(`vLLM: generating with model ${model}...`);

    try {
      const response = await fetch(buildChatCompletionsUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
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
        const text = await response.text();
        log(`vLLM error ${response.status}: ${redactSecrets(text)}`);
        return null;
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        log('vLLM: empty response');
        return null;
      }

      return content;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('vLLM: request aborted — timeout or re-save cancellation');
        return null;
      }

      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        log('vLLM: connection refused — is the server running?');
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`vLLM: unexpected error — ${redactSecrets(msg)}`);
      return null;
    }
  }
}
