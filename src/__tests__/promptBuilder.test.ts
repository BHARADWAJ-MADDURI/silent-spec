import { buildPrompt } from '../promptBuilder';
 
const base = {
  fileContent: 'export function add(a: number, b: number) { return a + b; }',
  filePath: '/workspace/src/utils/math.ts',
  exportedFunctions: ['add'],
  framework: 'jest' as const,
  testPatternSample: null,
  mockHints: [],
  isFrontend: false,
  isNestJS: false,
  isNextJS: false,
  isGraphQL: false,
  isPrisma: false,
  dependencyContext: [],
};
 
describe('buildPrompt', () => {
 
  it('should start with role instructions', () => {
    const prompt = buildPrompt(base);
    expect(prompt.startsWith('You are a senior QA engineer')).toBe(true);
  });
 
  it('should wrap file content in source-code XML tags', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('<source-code>');
    expect(prompt).toContain('</source-code>');
  });
 
  it('should list all exported functions', () => {
    const ctx = {
      ...base,
      fileContent: 'export function funcA() {} export function funcB() {}',
      exportedFunctions: ['funcA', 'funcB'],
    };
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('- funcA');
    expect(prompt).toContain('- funcB');
  });
 
  it('should use vi.mock in framework section for vitest', () => {
    const ctx = { ...base, framework: 'vitest' as const };
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('vi.mock');
    expect(prompt).toContain("import { describe, it, expect, vi } from 'vitest'");
  });
 
  it('should add frontend testing guidance for frontend files', () => {
    const ctx = { ...base, isFrontend: true };
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('Frontend file');
    expect(prompt).toContain('appropriate testing library');
    // Framework section still mentions @testing-library/react for jest+frontend
    expect(prompt).toContain('@testing-library/react');
  });
 
  it('should add NestJS createTestingModule guidance', () => {
    const ctx = { ...base, isNestJS: true };
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('Test.createTestingModule()');
  });
 
  it('should read mockStrategy from MockHint objects — not source', () => {
    const ctx = {
      ...base,
      mockHints: [{
        source: '@prisma/client',
        mockStrategy: "jest.mock('@prisma/client') // mock Prisma at DB boundary"
      }]
    };
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain("jest.mock('@prisma/client')");
    expect(prompt).toContain('mock Prisma at DB boundary');
  });
 
  it('should include SS-GENERATED-START and SS-GENERATED-END in output instruction', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('// <SS-GENERATED-START>');
    expect(prompt).toContain('// <SS-GENERATED-END>');
  });
 
  it('should include SS-PARTIAL fallback instruction in output section', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('[SS-PARTIAL]');
    expect(prompt).toContain('Remaining functions:');
    // Verify the priority instruction is present
    expect(prompt).toContain('Prioritize: functions with the most complexity');
  });
 
  it('should include max_tokens context in output instruction', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('4096 tokens');
  });
 
  it('should truncate file content over 32000 chars and add note', () => {
    const ctx = { ...base, fileContent: 'x'.repeat(32001) };
    const prompt = buildPrompt(ctx);
    expect(prompt).toContain('truncated at 32000 chars');
  });
 
  it('should include self-review block at the end', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('Self-Review');
    // Must be last — self-review should come after output instruction
    const selfReviewIdx = prompt.indexOf('Self-Review');
    const outputIdx = prompt.indexOf('Output Format');
    expect(selfReviewIdx).toBeGreaterThan(outputIdx);
  });
 
});