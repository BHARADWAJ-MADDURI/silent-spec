import * as vscode from 'vscode';
import { AIProvider } from './aiProvider';
import { redactSecrets } from '../utils/validateResponse';
import { shouldShowNotification } from '../utils/notificationCooldown';
import { isAllowedAzureOpenAIEndpoint } from '../utils/providerUrlSecurity';

const DEFAULT_API_VERSION = '2024-02-01';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export class AzureOpenAIProvider implements AIProvider {
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

  private getDeploymentName(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    return this.modelOverride ||
      config.get<string>('azure.deploymentName', '');
  }

  private getApiVersion(): string {
    return vscode.workspace
      .getConfiguration('silentspec')
      .get<string>('azure.apiVersion', DEFAULT_API_VERSION);
  }

  private getEndpoint(): string {
    return trimTrailingSlash(
      vscode.workspace.getConfiguration('silentspec').get<string>('azure.endpoint', '')
    );
  }

  private buildApiUrl(): string | null {
    const endpoint = this.getEndpoint();
    const deployment = this.getDeploymentName();
    if (!endpoint || !deployment) { return null; }
    const apiVersion = encodeURIComponent(this.getApiVersion());
    return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`;
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const apiKey = await this.secrets.get('silentspec.azureApiKey');
    const endpoint = this.getEndpoint();
    const deployment = this.getDeploymentName();

    if (!apiKey || !endpoint || !deployment) {
      log('Error: Azure OpenAI is not fully configured — showing setup guidance');
      void vscode.window.showInformationMessage(
        'SilentSpec: Azure OpenAI needs an endpoint, deployment name, and API key.',
        'Open Settings',
        'Set API Key'
      ).then(action => {
        if (action === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bharadwajmadduri.silent-spec azure');
        } else if (action === 'Set API Key') {
          void vscode.commands.executeCommand('silentspec.setApiKey');
        }
      });
      return null;
    }

    if (!isAllowedAzureOpenAIEndpoint(endpoint)) {
      log('Error: Azure OpenAI endpoint must be an HTTPS Azure OpenAI resource URL');
      void vscode.window.showWarningMessage(
        'SilentSpec: Azure OpenAI endpoint must be an HTTPS Azure resource URL ending in openai.azure.com or cognitiveservices.azure.com.'
      );
      return null;
    }

    const apiUrl = this.buildApiUrl();
    if (!apiUrl) {
      log('Error: Azure OpenAI API URL could not be constructed from current settings');
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

    log(`Calling Azure OpenAI deployment: ${deployment}`);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: this.getSystemInstructions() },
            { role: 'user', content: prompt },
          ],
          max_tokens: 4096,
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        const redacted = redactSecrets(errorBody);

        if (response.status === 401) {
          log('Error: Azure OpenAI API key rejected (401) — key may be expired or revoked');
          await this.secrets.delete('silentspec.azureApiKey');
          if (shouldShowNotification('azure-auth-rejected')) {
            void vscode.window.showWarningMessage(
              'SilentSpec: Your Azure OpenAI API key was rejected. It may have expired or been revoked.',
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
          log(`Error: Azure OpenAI rate limit hit (429) — ${redacted}`);
          void vscode.window.showWarningMessage(
            'SilentSpec: Azure OpenAI rate limit reached. Try again in a moment or switch providers.'
          );
          return null;
        }

        if (/DeploymentNotFound/i.test(errorBody)) {
          log(`Error: Azure deployment not found — ${redacted}`);
          void vscode.window.showWarningMessage(
            'SilentSpec: Azure OpenAI deployment not found. Check silentspec.azure.deploymentName and endpoint.'
          );
          return null;
        }

        if (/ContentFilter/i.test(errorBody)) {
          log(`Error: Azure OpenAI response blocked by content filter — ${redacted}`);
          return null;
        }

        log(`Error: Azure OpenAI API returned ${response.status} — ${redacted}`);
        return null;
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };

      return data.choices[0]?.message?.content || null;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Warning: Azure OpenAI request aborted — timeout or re-save cancellation');
        return null;
      }

      const msg = error instanceof Error ? error.message : String(error);
      log(`Error: Azure OpenAI API call failed — ${redactSecrets(msg)}`);
      return null;
    }
  }
}
