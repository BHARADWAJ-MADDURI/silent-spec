import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';
import { redactSecrets } from '../utils/validateResponse';
import { shouldShowNotification } from '../utils/notificationCooldown';
import { isAllowedOpenAICompatBaseUrl } from '../utils/providerUrlSecurity';

const FALLBACK_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_PROVIDER_LABEL = 'OpenAI-compatible';

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

export class OpenAICompatProvider implements AIProvider {
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

  private getProviderLabel(): string {
    return vscode.workspace
      .getConfiguration('silentspec')
      .get<string>('compat.providerLabel', DEFAULT_PROVIDER_LABEL);
  }

  private getModel(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    return this.modelOverride ||
      config.get<string>('compat.model', '') ||
      FALLBACK_MODEL;
  }

  private getBaseUrl(): string {
    return normalizeBaseUrl(
      vscode.workspace.getConfiguration('silentspec').get<string>('compat.baseUrl', DEFAULT_BASE_URL)
    );
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const apiKey = await this.secrets.get('silentspec.compatApiKey');
    const baseUrl = this.getBaseUrl();
    const providerLabel = this.getProviderLabel();

    if (!apiKey) {
      log(`Error: ${providerLabel} API key not set — showing setup guidance`);
      void vscode.window.showInformationMessage(
        `SilentSpec: ${providerLabel} API key not set.`,
        'Set API Key'
      ).then(action => {
        if (action === 'Set API Key') {
          void vscode.commands.executeCommand('silentspec.setApiKey');
        }
      });
      return null;
    }

    if (!isAllowedOpenAICompatBaseUrl(baseUrl)) {
      log(`Error: ${providerLabel} base URL is not an allowed HTTPS OpenAI-compatible provider`);
      void vscode.window.showWarningMessage(
        `SilentSpec: ${providerLabel} base URL must use HTTPS and one of the documented providers: Groq, Together AI, Fireworks AI, or DeepSeek.`
      );
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
    log(`Calling ${providerLabel} model: ${model}`);

    try {
      const response = await fetch(buildChatCompletionsUrl(baseUrl), {
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
        const redacted = redactSecrets(errorBody);

        if (response.status === 401) {
          log(`Error: ${providerLabel} API key rejected (401) — key may be expired or revoked`);
          await this.secrets.delete('silentspec.compatApiKey');
          if (shouldShowNotification('compat-auth-rejected')) {
            void vscode.window.showWarningMessage(
              `SilentSpec: Your ${providerLabel} API key was rejected. It may have expired or been revoked.`,
              'Set Up New Key'
            ).then(action => {
              if (action === 'Set Up New Key') {
                void vscode.commands.executeCommand('silentspec.setApiKey');
              }
            });
          }
          return null;
        }

        if (response.status === 429) {
          log(`Error: ${providerLabel} rate limit hit (429) — ${redacted}`);
          void vscode.window.showWarningMessage(
            `SilentSpec: ${providerLabel} rate limit reached. Try again in a moment or switch providers.`
          );
          return null;
        }

        log(`Error: ${providerLabel} API returned ${response.status} — ${redacted}`);
        return null;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      return data.choices[0]?.message?.content || null;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log(`Warning: ${providerLabel} request aborted — timeout or re-save cancellation`);
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`Error: ${providerLabel} API call failed — ${redactSecrets(msg)}`);
      return null;
    }
  }
}
