export interface AIProvider {
  /**
   * Call the AI provider with the assembled prompt
   * Returns the raw response string, or null on any failure from the provider
   * Never throws - all errors are caught and logged internally
   */

  generateTests(
    prompt: string,
    log: (msg: string) => void,
    abortSignal?: AbortSignal
  ): Promise<string | null>;

  /**
   * Provider-native system instructions.
   * Kept separate from buildPromt() to preserve model-agnostic core.
   * Claude uses the system parameter; OpenAI uses a system message role.
   */

  getSystemInstructions(): string;
}