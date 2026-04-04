import { validateResponse } from '../utils/validateResponse';

const noop = () => {};

describe('validateResponse', () => {
  it('returns null when SS-GENERATED-START marker is missing', () => {
    const logs: string[] = [];
    const raw = '// <SS-GENERATED-END>\nsome content\n// <SS-GENERATED-END>';
    const result = validateResponse(raw, (msg) => logs.push(msg));
    expect(result).toBeNull();
    expect(logs[0]).toMatch(/no SS-GENERATED-START marker/);
  });

  it('returns null when SS-GENERATED-END marker is missing', () => {
    const logs: string[] = [];
    const raw = '// <SS-GENERATED-START>\nsome content';
    const result = validateResponse(raw, (msg) => logs.push(msg));
    expect(result).toBeNull();
    expect(logs[0]).toMatch(/SS-GENERATED-END/);
  });

  it('returns null when content between markers is empty', () => {
    const logs: string[] = [];
    const raw = '// <SS-GENERATED-START>\n\n// <SS-GENERATED-END>';
    const result = validateResponse(raw, (msg) => logs.push(msg));
    expect(result).toBeNull();
    expect(logs[0]).toMatch(/empty content/);
  });

  it('returns null when braces are unbalanced', () => {
    const logs: string[] = [];
    const raw = [
      '// <SS-GENERATED-START>',
      'describe("foo", () => {',
      '  it("bar", () => {',
      '// <SS-GENERATED-END>',
    ].join('\n');
    const result = validateResponse(raw, (msg) => logs.push(msg));
    expect(result).toBeNull();
    expect(logs[0]).toMatch(/unbalanced braces/);
  });

  it('returns sanitized content for valid well-formed input', () => {
    const raw = [
      '// <SS-GENERATED-START>',
      'describe("foo", () => {',
      '  it("works", () => { expect(1).toBe(1); });',
      '});',
      '// <SS-GENERATED-END>',
    ].join('\n');
    const result = validateResponse(raw, noop);
    expect(result).not.toBeNull();
    expect(result).toContain('// <SS-GENERATED-START>');
    expect(result).toContain('// <SS-GENERATED-END>');
    expect(result).toContain('describe("foo"');
  });

  it('strips markdown code fences before validation', () => {
    const raw = [
      '```typescript',
      '// <SS-GENERATED-START>',
      'describe("bar", () => { it("x", () => {}); });',
      '// <SS-GENERATED-END>',
      '```',
    ].join('\n');
    const result = validateResponse(raw, noop);
    expect(result).not.toBeNull();
    expect(result).not.toContain('```');
  });
});
