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

  if (!hasEnd) {
    log('Warning: model response missing SS-GENERATED-END — appending closing marker');
    return sanitized.trimEnd() + '\n// <SS-GENERATED-END>';
  }

  const content = sanitized
    .split('// <SS-GENERATED-START>')[1]
    ?.split('// <SS-GENERATED-END>')[0]
    ?.trim();

  if (!content) {
    log('Warning: model returned empty content between markers — discarding');
    return null;
  }

  return sanitized;
}