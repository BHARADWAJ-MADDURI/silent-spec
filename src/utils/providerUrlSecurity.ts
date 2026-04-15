const OPENAI_COMPAT_ALLOWED_HOSTS = new Set([
  'api.groq.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.deepseek.com',
]);

export function isAllowedAzureOpenAIEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') { return false; }
    const host = url.hostname.toLowerCase();
    return host.endsWith('.openai.azure.com') ||
      host.endsWith('.cognitiveservices.azure.com');
  } catch {
    return false;
  }
}

export function isAllowedOpenAICompatBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' &&
      OPENAI_COMPAT_ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isLocalProviderBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]');
  } catch {
    return false;
  }
}

export function isValidVertexLocation(location: string): boolean {
  return /^[a-z]+(?:-[a-z]+)*[0-9]$/.test(location);
}
