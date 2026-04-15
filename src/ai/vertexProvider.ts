import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { GoogleAuth, type GoogleAuthOptions } from 'google-auth-library';
import { AIProvider } from './aiProvider';
import { redactSecrets } from '../utils/validateResponse';
import { shouldShowNotification } from '../utils/notificationCooldown';
import { isValidVertexLocation } from '../utils/providerUrlSecurity';

const DEFAULT_LOCATION = 'us-central1';
const FALLBACK_GEMINI_MODEL = 'gemini-2.0-flash';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export class VertexProvider implements AIProvider {
  private readonly modelOverride: string;

  constructor(model?: string) {
    this.modelOverride = model || '';
  }

  getSystemInstructions(): string {
    return 'Output only valid TypeScript test code. No explanations outside code comments.';
  }

  private getProjectId(): string {
    return vscode.workspace.getConfiguration('silentspec').get<string>('vertex.projectId', '');
  }

  private getLocation(): string {
    return vscode.workspace.getConfiguration('silentspec').get<string>('vertex.location', DEFAULT_LOCATION);
  }

  private getModel(): string {
    const config = vscode.workspace.getConfiguration('silentspec');
    return this.modelOverride ||
      config.get<string>('vertex.model', '') ||
      FALLBACK_GEMINI_MODEL;
  }

  private getServiceAccountKeyPath(): string {
    return vscode.workspace
      .getConfiguration('silentspec')
      .get<string>('vertex.serviceAccountKeyPath', '');
  }

  private useAdc(): boolean {
    return vscode.workspace
      .getConfiguration('silentspec')
      .get<boolean>('vertex.useADC', false);
  }

  private async createGoogleAuth(log: (msg: string) => void): Promise<GoogleAuth | null> {
    if (this.useAdc()) {
      return new GoogleAuth({
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
    }

    const keyFile = this.getServiceAccountKeyPath();
    if (!keyFile) {
      log('Error: Vertex service account key path missing and ADC disabled');
      void vscode.window.showInformationMessage(
        'SilentSpec: Vertex AI needs a service account key path or silentspec.vertex.useADC enabled.',
        'Open Settings'
      ).then(action => {
        if (action === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bharadwajmadduri.silent-spec vertex');
        }
      });
      return null;
    }

    try {
      await fs.access(keyFile);
    } catch {
      log('Error: Vertex service account key file not found');
      void vscode.window.showWarningMessage(
        'SilentSpec: Vertex service account key file was not found. Check silentspec.vertex.serviceAccountKeyPath.'
      );
      return null;
    }

    const options: GoogleAuthOptions = {
      keyFile,
      scopes: [CLOUD_PLATFORM_SCOPE],
    };
    return new GoogleAuth(options);
  }

  private async generateWithGemini(
    prompt: string,
    projectId: string,
    location: string,
    model: string,
    auth: GoogleAuth,
    signal?: AbortSignal
  ): Promise<string | null> {
    const accessToken = await auth.getAccessToken();
    const apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: this.getSystemInstructions() }],
        },
        contents: [{
          role: 'user',
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.2,
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Vertex Gemini HTTP ${response.status}: ${text}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    const data = await response.json() as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };

    const text = data.candidates
      ?.flatMap(candidate => candidate.content?.parts ?? [])
      .map(part => part.text ?? '')
      .join('');

    return text || null;
  }

  private async generateWithClaudeOnVertex(
    prompt: string,
    projectId: string,
    location: string,
    model: string,
    auth: GoogleAuth,
    signal?: AbortSignal
  ): Promise<string | null> {
    const accessToken = await auth.getAccessToken();
    const apiUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/anthropic/models/${encodeURIComponent(model)}:rawPredict`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 4096,
        system: this.getSystemInstructions(),
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      const error = new Error(`Vertex Claude HTTP ${response.status}: ${text}`);
      (error as Error & { status?: number }).status = response.status;
      throw error;
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
    };

    const text = data.content
      ?.filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('');

    return text || null;
  }

  async generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null> {
    const projectId = this.getProjectId();
    const location = this.getLocation();
    const model = this.getModel();

    if (!projectId) {
      log('Error: Vertex project ID not set — showing setup guidance');
      void vscode.window.showInformationMessage(
        'SilentSpec: Vertex AI needs silentspec.vertex.projectId configured.',
        'Open Settings'
      ).then(action => {
        if (action === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:bharadwajmadduri.silent-spec vertex');
        }
      });
      return null;
    }

    if (!isValidVertexLocation(location)) {
      log('Error: Vertex location is invalid — refusing to build API hostname');
      void vscode.window.showWarningMessage(
        'SilentSpec: Vertex location must be a valid GCP region such as us-central1 or europe-west4.'
      );
      return null;
    }

    const auth = await this.createGoogleAuth(log);
    if (!auth) { return null; }

    const timeoutMs = vscode.workspace
      .getConfiguration('silentspec')
      .get<number>('aiTimeoutSeconds', 60) * 1000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    abortSignal?.addEventListener('abort', () => {
      controller.abort();
      clearTimeout(timeout);
    });

    log(`Calling Vertex model: ${model}`);

    try {
      let text: string | null;

      if (model.startsWith('claude')) {
        text = await this.generateWithClaudeOnVertex(prompt, projectId, location, model, auth, controller.signal);
      } else {
        text = await this.generateWithGemini(prompt, projectId, location, model, auth, controller.signal);
      }

      clearTimeout(timeout);
      return text;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        log('Warning: Vertex request aborted — timeout or re-save cancellation');
        return null;
      }

      const err = error as Error & { status?: number };
      const status = err.status;
      const msg = err.message ?? String(error);

      if (status === 403) {
        log(`Error: Vertex permission failure — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Vertex AI permission error. Check IAM permissions and that Vertex AI is enabled for this project.'
        );
        return null;
      }

      if (status === 429) {
        log(`Error: Vertex quota exceeded — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Vertex AI quota exceeded. Try again in a moment or switch providers.'
        );
        return null;
      }

      if (status === 401) {
        log(`Error: Vertex authentication failed — ${redactSecrets(msg)}`);
        if (shouldShowNotification('vertex-auth-rejected')) {
          void vscode.window.showWarningMessage(
            'SilentSpec: Vertex AI authentication failed. Check your service account key or re-run gcloud auth application-default login.'
          );
        }
        return null;
      }

      if (status === 404) {
        log(`Error: Vertex model not found — ${redactSecrets(msg)}`);
        void vscode.window.showWarningMessage(
          'SilentSpec: Vertex model not found. Check silentspec.vertex.model and location.'
        );
        return null;
      }

      log(`Error: Vertex API call failed — ${redactSecrets(msg)}`);
      return null;
    }
  }
}
