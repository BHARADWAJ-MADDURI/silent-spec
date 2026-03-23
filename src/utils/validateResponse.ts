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