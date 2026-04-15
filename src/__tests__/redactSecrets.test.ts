import { redactSecrets } from '../utils/validateResponse';

// ── Bearer tokens ────────────────────────────────────────────────────────────

test('redacts a Bearer token in an Authorization header', () => {
  const input = '{"error": "invalid_token", "header": "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456"}';
  expect(redactSecrets(input)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456');
  expect(redactSecrets(input)).toContain('Bearer [REDACTED]');
});

test('redacts a bare Bearer token value', () => {
  const result = redactSecrets('Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ab');
  expect(result).toBe('Bearer [REDACTED]');
});

// ── sk-... API keys ──────────────────────────────────────────────────────────

test('redacts an OpenAI/Anthropic sk- key', () => {
  const result = redactSecrets('invalid key: sk-proj-abcdefghijklmnopqrstuvwxyz12345');
  expect(result).toContain('sk-[REDACTED]');
  expect(result).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz12345');
});

test('preserves the prefix word "sk-" but only when the key is long enough', () => {
  // Short string "sk-abc" (< 20 trailing chars) — should NOT be redacted
  expect(redactSecrets('sk-abc')).toBe('sk-abc');
});

// ── ghp_... GitHub tokens ────────────────────────────────────────────────────

test('redacts a GitHub PAT with ghp_ prefix', () => {
  const token = 'ghp_' + 'A'.repeat(36);
  const result = redactSecrets(`auth failed for token ${token}`);
  expect(result).toContain('ghp_[REDACTED]');
  expect(result).not.toContain(token);
});

test('redacts a GitHub fine-grained PAT with github_pat_ prefix', () => {
  const token = 'github_pat_' + 'A'.repeat(48);
  const result = redactSecrets(`auth failed for token ${token}`);
  expect(result).toContain('github_pat_[REDACTED]');
  expect(result).not.toContain(token);
});

test('does not redact a short ghp_ string below the threshold', () => {
  // ghp_ + 35 chars — just under the 36-char threshold
  const short = 'ghp_' + 'A'.repeat(35);
  expect(redactSecrets(short)).toBe(short);
});

// ── key-... tokens ───────────────────────────────────────────────────────────

test('redacts a key- prefixed token', () => {
  const result = redactSecrets('key-abcdefghijklmnopqrstuvwxyz1234567890');
  expect(result).toContain('key-[REDACTED]');
});

test('redacts provider-specific cloud tokens', () => {
  const azureKey = '0123456789abcdef0123456789abcdef';
  const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE';
  const awsSecretKey = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
  const googleToken = `ya29.${'A'.repeat(40)}`;
  const result = redactSecrets(`azure=${azureKey} aws=${awsAccessKey} secretAccessKey=${awsSecretKey} google=${googleToken}`);
  expect(result).toContain('[AZURE_KEY_REDACTED]');
  expect(result).toContain('[AWS_ACCESS_KEY_ID_REDACTED]');
  expect(result).toContain('secretAccessKey=[AWS_SECRET_ACCESS_KEY_REDACTED]');
  expect(result).toContain('ya29.[REDACTED]');
  expect(result).not.toContain(azureKey);
  expect(result).not.toContain(awsAccessKey);
  expect(result).not.toContain(awsSecretKey);
  expect(result).not.toContain(googleToken);
});

// ── Non-secret content passes through unchanged ──────────────────────────────

test('passes through a plain error message with no secrets', () => {
  const plain = '{"error": {"message": "You exceeded your quota.", "type": "insufficient_quota"}}';
  expect(redactSecrets(plain)).toBe(plain);
});

test('passes through an HTTP status and endpoint URL unchanged', () => {
  const msg = 'Error: Claude API returned 429 — Too Many Requests';
  expect(redactSecrets(msg)).toBe(msg);
});

test('does not redact short identifiers or common words', () => {
  expect(redactSecrets('hello world')).toBe('hello world');
  expect(redactSecrets('error: invalid_request')).toBe('error: invalid_request');
  expect(redactSecrets('status: ok')).toBe('status: ok');
});

test('message with no secrets passes through identical', () => {
  const msg = 'rate limit reached, retry after 60s';
  expect(redactSecrets(msg)).toBe(msg);
});
