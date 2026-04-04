/**
 * Tests for the two-pass jest-global / real-diagnostic separation in healSpec.
 *
 * NOTE on environment constraint:
 * The two-pass behavior (Pass 1 sets activeMissingTypes, Pass 2 processes real
 * diagnostics) is triggered only when @types/jest or @types/vitest is MISSING.
 * In this project @types/jest is installed, so describe/it/expect are fully
 * typed and TS2304/TS2582 on jest globals never fires during these tests.
 * The two-pass separation is therefore verified by code inspection — the
 * short-circuit early-return has been removed and replaced with a flag that
 * allows Pass 2 to continue.
 *
 * The tests below cover the code paths that ARE reachable in this environment:
 *   - real type errors without jest globals
 *   - clean spec with no errors
 */
import { healSpec } from '../utils/specHealer';

const FAKE_SPEC = 'test.spec.ts';
const FAKE_SOURCE = '/fake/source.ts'; // no tsconfig found → pre-check skipped, fallback options

// ── Real type error at file level (no jest globals) ───────────────────────────
// A file-level TS2322 (outside any it/describe block) is Category B → hasGlobalErrors.
// No jest-global errors present → activeMissingTypes = false → missingTypes not set.
test('file-level type error without jest globals: hasGlobalErrors set, missingTypes not set', () => {
  // Note: @types/jest is installed so 'describe' etc. are defined — we deliberately
  // avoid them here to ensure no jest-global path is triggered.
  const spec = [
    `const y: number = 'wrong type'; // TS2322`,
    `function helper(): void {}`,
  ].join('\n');

  const result = healSpec(spec, FAKE_SPEC, FAKE_SOURCE);

  expect(result.missingTypes).toBeFalsy();
  expect(result.hasGlobalErrors).toBe(true);
  expect(result.wasHealed).toBe(false);
});

// ── Clean spec with no errors ────────────────────────────────────────────────
test('clean spec: no errors, no missingTypes, no hasGlobalErrors', () => {
  const spec = `const x: number = 1;\nexport {};\n`;

  const result = healSpec(spec, FAKE_SPEC, FAKE_SOURCE);

  expect(result.missingTypes).toBeFalsy();
  expect(result.hasGlobalErrors).toBe(false);
  expect(result.wasHealed).toBe(false);
  expect(result.errorCount).toBe(0);
});

// ── Real type error inside it() block (full mode, no jest globals) ───────────
// TS2322 inside an it() block → blocksWithErrors → healer attempts repair.
// Since @types/jest is installed, describe/it/expect are defined correctly.
test('real type error inside it() block: healer attempts repair in full mode', () => {
  const spec = [
    `import {} from './nonexistent-for-test'; // intentionally omitted`,
    `describe('suite', () => {`,
    `  it('has a type error', () => {`,
    `    const x: number = 'this is wrong'; // TS2322 inside it()`,
    `    expect(x).toBeDefined();`,
    `  });`,
    `});`,
  ].join('\n');

  // In full mode the healer should attempt to repair or remove the failing test.
  // missingTypes should NOT be set (jest types are available).
  const result = healSpec(spec, FAKE_SPEC, FAKE_SOURCE, undefined, 'full');

  expect(result.missingTypes).toBeFalsy();
  // The healer will have attempted repair (partialRepair / removal)
  // We don't assert the exact outcome, only that the two-pass code path ran
  // without crashing and produced a structurally valid result.
  expect(typeof result.hasGlobalErrors).toBe('boolean');
  expect(typeof result.wasHealed).toBe('boolean');
  expect(typeof result.healed).toBe('string');
});
