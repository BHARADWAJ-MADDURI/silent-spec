import {
  isAllowedAzureOpenAIEndpoint,
  isAllowedOpenAICompatBaseUrl,
  isLocalProviderBaseUrl,
  isValidVertexLocation,
} from '../utils/providerUrlSecurity';

test('allows only HTTPS Azure OpenAI resource endpoints', () => {
  expect(isAllowedAzureOpenAIEndpoint('https://team.openai.azure.com')).toBe(true);
  expect(isAllowedAzureOpenAIEndpoint('https://team.cognitiveservices.azure.com')).toBe(true);
  expect(isAllowedAzureOpenAIEndpoint('http://team.openai.azure.com')).toBe(false);
  expect(isAllowedAzureOpenAIEndpoint('https://evil.example.com')).toBe(false);
  expect(isAllowedAzureOpenAIEndpoint('https://team.openai.azure.com.evil.example')).toBe(false);
});

test('allows only documented HTTPS OpenAI-compatible hosts', () => {
  expect(isAllowedOpenAICompatBaseUrl('https://api.groq.com/openai/v1')).toBe(true);
  expect(isAllowedOpenAICompatBaseUrl('https://api.together.xyz/v1')).toBe(true);
  expect(isAllowedOpenAICompatBaseUrl('https://api.fireworks.ai/inference/v1')).toBe(true);
  expect(isAllowedOpenAICompatBaseUrl('https://api.deepseek.com/v1')).toBe(true);
  expect(isAllowedOpenAICompatBaseUrl('http://api.groq.com/openai/v1')).toBe(false);
  expect(isAllowedOpenAICompatBaseUrl('https://api.groq.com.evil.example/v1')).toBe(false);
});

test('allows vLLM localhost URLs only', () => {
  expect(isLocalProviderBaseUrl('http://localhost:8000/v1')).toBe(true);
  expect(isLocalProviderBaseUrl('http://127.0.0.1:8000/v1')).toBe(true);
  expect(isLocalProviderBaseUrl('http://[::1]:8000/v1')).toBe(true);
  expect(isLocalProviderBaseUrl('https://api.example.com/v1')).toBe(false);
  expect(isLocalProviderBaseUrl('http://192.168.1.10:8000/v1')).toBe(false);
});

test('validates Vertex region before it is used in a hostname', () => {
  expect(isValidVertexLocation('us-central1')).toBe(true);
  expect(isValidVertexLocation('europe-west4')).toBe(true);
  expect(isValidVertexLocation('x.evil.com/ignored')).toBe(false);
  expect(isValidVertexLocation('us-central1.evil.com')).toBe(false);
});
