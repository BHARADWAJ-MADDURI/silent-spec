import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifyCompilation } from '../utils/specHealer';

// Helper: write a temp .ts file, run the test, always clean up.
function withTempFile(content: string, fn: (filePath: string) => void): void {
  const tmpFile = path.join(os.tmpdir(), `ss_verify_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(tmpFile, content);
  try { fn(tmpFile); } finally { fs.unlinkSync(tmpFile); }
}

test('verifyCompilation returns clean for a valid TypeScript file', () => {
  withTempFile('const x: number = 1;\n', (f) => {
    const result = verifyCompilation(f);
    expect(result.clean).toBe(true);
    expect(result.diagnosticCount).toBe(0);
  });
});

test('verifyCompilation returns not clean for a type-error TypeScript file', () => {
  withTempFile('const x: number = "a string";\n', (f) => {
    const result = verifyCompilation(f);
    expect(result.clean).toBe(false);
    expect(result.diagnosticCount).toBeGreaterThan(0);
  });
});

test('verifyCompilation filters TS2304 false positives for jest/vitest globals', () => {
  // describe/it produce TS2304 ("Cannot find name") when @types/jest is not
  // on the type-root path for this temp file. verifyCompilation must filter them.
  withTempFile(
    [
      'describe("suite", () => {',
      '  it("test", () => {',
      '    // no expect chain — avoids cascading errors from chained property access',
      '  });',
      '});',
    ].join('\n'),
    (f) => {
      const result = verifyCompilation(f);
      expect(result.clean).toBe(true);
    }
  );
});

test('verifyCompilation returns clean:false and diagnosticCount:-1 for a missing file', () => {
  const result = verifyCompilation('/tmp/does_not_exist_ss_verify_999.ts');
  expect(result.clean).toBe(false);
  expect(result.diagnosticCount).toBe(-1);
});
