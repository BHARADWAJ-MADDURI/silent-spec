import * as vscode from 'vscode';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { AIProvider } from './aiProvider';
import { redactSecrets } from '../utils/validateResponse';

const FALLBACK_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

type BedrockAuthMode = 'static' | 'profile' | 'iam';

export class BedrockProvider implements AIProvider {
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

  private getRegion(): string {
    return vscode.workspace.getConfiguration('silentspec').get<string>('bedrock.region', 'us-east-1');
  }

  private getModelId(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    return this.modelOverride ||
      config.get<string>('bedrock.modelId', '') ||
      FALLBACK_MODEL;
  }

  private getAuthMode(): BedrockAuthMode {
    return vscode.workspace
      .getConfiguration('silentspec')
      .get<BedrockAuthMode>('bedrock.authMode', 'iam');
  }

  private getProfile(): string {
    return vscode.workspace
      .getConfiguration('silentspec')
      .get<string>('bedrock.profile', '');
  }

  private async createClient(log: (msg: string) => void): Promise<BedrockRuntimeClient | null> {
    const region = this.getRegion();
    const authMode = this.getAuthMode();

    if (authMode === 'profile') {
      const profile = this.getProfile();
      if (!profile) {
        log('Error: Bedrock profile auth selected but silentspec.bedrock.profile is empty');
        void vscode.window.showInformationMessage(
          'SilentSpec: Set silentspec.bedrock.profile or switch Bedrock auth mode.'
        );
        return null;
      }

      return new BedrockRuntimeClient({
        region,
        credentials: fromIni({ profile }),
      });
    }

    if (authMode === 'static') {
      const accessKeyId = await this.secrets.get('silentspec.bedrockAccessKeyId');
      const secretAccessKey = await this.secrets.get('silentspec.bedrockSecretAccessKey');

      if (!accessKeyId || !secretAccessKey) {
        log('Error: Bedrock static credentials missing — showing setup guidance');
        void vscode.window.showInformationMessage(
          'SilentSpec: Bedrock static auth needs an access key ID and secret access key.',
          'Set Credentials',
          'Open Settings'
        ).then(action => {
          if (action === 'Set Credentials') {
            void vscode.commands.executeCommand('silentspec.setApiKey');
          } else if (action === 'Open Settings') {
            void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bharadwajmadduri.silent-spec bedrock');
          }
        });
        return null;
      }

      return new BedrockRuntimeClient({
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
    }

    return new BedrockRuntimeClient({
      region,
      credentials: fromNodeProviderChain(),
    });
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const client = await this.createClient(log);
    if (!client) { return null; }

    const timeoutMs = vscode.workspace
      .getConfiguration('silentspec')
      .get<number>('aiTimeoutSeconds', 60) * 1000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    abortSignal?.addEventListener('abort', () => {
      controller.abort();
      clearTimeout(timeout);
    });

    const modelId = this.getModelId();
    log(`Calling Bedrock model: ${modelId}`);

    try {
      const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          system: this.getSystemInstructions(),
          max_tokens: 4096,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
      });

      const response = await client.send(command, {
        abortSignal: controller.signal,
      });

      clearTimeout(timeout);

      const rawBody = Buffer.from(response.body).toString('utf8');
      const data = JSON.parse(rawBody) as {
        content?: Array<{ type?: string; text?: string }>;
      };

      const text = data.content
        ?.filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('');

      return text || null;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Warning: Bedrock request aborted — timeout or re-save cancellation');
        return null;
      }

      const err = error as { name?: string; message?: string };
      const name = err.name ?? 'UnknownError';
      const msg = err.message ?? String(error);

      if (name === 'ThrottlingException') {
        log(`Error: Bedrock throttled request — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Bedrock rate limit reached. Try again in a moment or switch providers.'
        );
        return null;
      }

      if (name === 'ModelNotReadyException') {
        log(`Error: Bedrock model not ready — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Bedrock model not ready. Check model access in the AWS console.'
        );
        return null;
      }

      if (name === 'ValidationException') {
        log(`Error: Bedrock validation failed — ${redactSecrets(msg)}`);
        return null;
      }

      if (name === 'AccessDeniedException') {
        log(`Error: Bedrock access denied — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Bedrock access denied. Check IAM permissions or selected auth mode.'
        );
        return null;
      }

      if (name === 'ResourceNotFoundException') {
        log(`Error: Bedrock model not found — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Bedrock model ID not found. Check silentspec.bedrock.modelId in settings.'
        );
        return null;
      }

      log(`Error: Bedrock API call failed (${name}) — ${redactSecrets(msg)}`);
      return null;
    } finally {
      client.destroy();
    }
  }
}
