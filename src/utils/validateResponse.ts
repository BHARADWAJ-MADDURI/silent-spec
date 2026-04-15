/**
 * Redacts high-confidence secret patterns from a string before it is logged.
 * Targets: common provider API keys and OAuth tokens that can appear in error bodies.
 * Non-secret content (error messages, status codes, endpoint URLs) passes through unchanged.
 */
export function redactSecrets(message: string): string {
  return message
    // Bearer tokens in Authorization headers or response bodies
    .replace(/Bearer\s+\S{20,}/g, 'Bearer [REDACTED]')
    // OpenAI / Anthropic API keys: sk-<20+ alphanumeric/dash/underscore chars>
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]')
    // GitHub personal access tokens: ghp_<36+ alphanumeric chars>
    .replace(/\bghp_[A-Za-z0-9]{36,}/g, 'ghp_[REDACTED]')
    // GitHub fine-grained personal access tokens
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]')
    // Generic key- prefixed tokens: key-<20+ alphanumeric/dash/underscore chars>
    .replace(/\bkey-[A-Za-z0-9_-]{20,}/g, 'key-[REDACTED]')
    // AWS access key IDs
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[AWS_ACCESS_KEY_ID_REDACTED]')
    // AWS secret access keys when an SDK/error body labels the field. A bare
    // 40-character secret has too many false positives to redact safely.
    .replace(
      /\b(aws_secret_access_key|secretAccessKey|SecretAccessKey|secret access key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
      '$1=[AWS_SECRET_ACCESS_KEY_REDACTED]'
    )
    // Google OAuth access tokens
    .replace(/\bya29\.[A-Za-z0-9._-]{20,}/g, 'ya29.[REDACTED]')
    // Azure OpenAI keys are commonly 32-character hex strings. Keep this narrow
    // to avoid redacting arbitrary words or request IDs.
    .replace(/\b[a-fA-F0-9]{32}\b/g, '[AZURE_KEY_REDACTED]');
}

export function validateResponse(
  raw: string,
  log: (msg: string) => void
): string | null {

  const sanitized = raw
    .replace(/^```[a-z]*\n?/gim, '')
    .replace(/^```$/gim, '')
    .trim();

  const hasStart = sanitized.includes('// <SS-GENERATED-START>');
  const hasEnd   = sanitized.includes('// <SS-GENERATED-END>');

  if (!hasStart) {
    log('Warning: model returned response with no SS-GENERATED-START marker — discarding');
    return null;
  }

  // If end marker is missing, the AI was truncated mid-output — discard entirely.
  // Previously this appended the marker, but that produces syntactically broken
  // content (unterminated strings, unbalanced braces) that corrupts the spec file.
  if (!hasEnd) {
    log('Warning: model response missing SS-GENERATED-END — output was truncated — discarding');
    return null;
  }

  const content = sanitized
    .split('// <SS-GENERATED-START>')[1]
    ?.split('// <SS-GENERATED-END>')[0]
    ?.trim();

  if (!content) {
    log('Warning: model returned empty content between markers — discarding');
    return null;
  }

  // Brace balance check — unmatched braces mean the output was cut off mid-block.
  // We scan only the generated content between the markers.
  // String literal tracking avoids false positives from braces inside strings.
  let depth = 0;
  let inSingle   = false;
  let inDouble   = false;
  let inTemplate = false;

  for (let i = 0; i < content.length; i++) {
    const ch   = content[i];
    const prev = i > 0 ? content[i - 1] : '';

    // Skip escaped characters
    if (prev === '\\') { continue; }

    if (ch === "'" && !inDouble && !inTemplate) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle && !inTemplate) { inDouble = !inDouble; continue; }
    if (ch === '`' && !inSingle && !inDouble)   { inTemplate = !inTemplate; continue; }

    if (inSingle || inDouble || inTemplate) { continue; }

    if (ch === '{') { depth++; }
    if (ch === '}') { depth--; }
  }

  if (depth !== 0) {
    log(`Warning: model output has unbalanced braces (depth=${depth}) — output truncated — discarding`);
    return null;
  }

  return sanitized;
}
