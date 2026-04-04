import { isShellJestGlobalError, isSpecFileLine } from '../utils/specHealer';

// ── isShellJestGlobalError ────────────────────────────────────────────────────

const TS2304_DESCRIBE  = `src/foo.spec.ts(3,1): error TS2304: Cannot find name 'describe'.`;
const TS2304_IT        = `src/foo.spec.ts(4,3): error TS2304: Cannot find name 'it'.`;
const TS2304_EXPECT    = `src/foo.spec.ts(5,5): error TS2304: Cannot find name 'expect'.`;
const TS2304_TEST      = `src/foo.spec.ts(6,3): error TS2304: Cannot find name 'test'.`;
const TS2304_BEFOREALL = `src/foo.spec.ts(2,1): error TS2304: Cannot find name 'beforeAll'.`;
const TS2582_DESCRIBE  = `src/foo.spec.ts(3,1): error TS2582: Cannot find name 'describe'. Do you need to install type definitions for a test runner? Try \`npm i --save-dev @types/jest\`.`;
const TS2304_REAL_TYPE = `src/foo.spec.ts(10,5): error TS2304: Cannot find name 'SomeCustomType'.`;
const TS2345_REAL      = `src/foo.spec.ts(12,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
const TS2322_REAL      = `src/foo.spec.ts(14,9): error TS2322: Type 'string' is not assignable to type 'number'.`;
const NO_CODE          = `src/foo.spec.ts(1,1): some message without error code`;

test('isShellJestGlobalError: TS2304 on describe → true', () => {
  expect(isShellJestGlobalError(TS2304_DESCRIBE)).toBe(true);
});

test('isShellJestGlobalError: TS2304 on it → true', () => {
  expect(isShellJestGlobalError(TS2304_IT)).toBe(true);
});

test('isShellJestGlobalError: TS2304 on expect → true', () => {
  expect(isShellJestGlobalError(TS2304_EXPECT)).toBe(true);
});

test('isShellJestGlobalError: TS2304 on test → true', () => {
  expect(isShellJestGlobalError(TS2304_TEST)).toBe(true);
});

test('isShellJestGlobalError: TS2304 on beforeAll → true', () => {
  expect(isShellJestGlobalError(TS2304_BEFOREALL)).toBe(true);
});

test('isShellJestGlobalError: TS2582 on describe → true', () => {
  expect(isShellJestGlobalError(TS2582_DESCRIBE)).toBe(true);
});

test('isShellJestGlobalError: TS2304 on a real custom type → false', () => {
  expect(isShellJestGlobalError(TS2304_REAL_TYPE)).toBe(false);
});

test('isShellJestGlobalError: TS2345 type error → false', () => {
  expect(isShellJestGlobalError(TS2345_REAL)).toBe(false);
});

test('isShellJestGlobalError: TS2322 type error → false', () => {
  expect(isShellJestGlobalError(TS2322_REAL)).toBe(false);
});

test('isShellJestGlobalError: line with no error code → false', () => {
  expect(isShellJestGlobalError(NO_CODE)).toBe(false);
});

test('isShellJestGlobalError: empty string → false', () => {
  expect(isShellJestGlobalError('')).toBe(false);
});

// ── isSpecFileLine ────────────────────────────────────────────────────────────

const REL  = 'src/utils/myModule.spec.ts';
const BASE = 'myModule.spec.ts';

test('isSpecFileLine: exact relative path match → true', () => {
  const line = `${REL}(10,5): error TS2345: Arg type mismatch.`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(true);
});

test('isSpecFileLine: basename-only match (tsc shortened output) → true', () => {
  const line = `${BASE}(3,1): error TS2304: Cannot find name 'x'.`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(true);
});

test('isSpecFileLine: absolute path that ends with relative path → true', () => {
  const line = `/Users/dev/project/${REL}(7,3): error TS2322: Type mismatch.`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(true);
});

test('isSpecFileLine: absolute path that ends with basename → true', () => {
  const line = `/Users/dev/project/src/utils/${BASE}(7,3): error TS2322: Type mismatch.`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(true);
});

test('isSpecFileLine: different file with same extension → false', () => {
  const line = `src/utils/otherModule.spec.ts(5,2): error TS2304: Cannot find name 'y'.`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(false);
});

test('isSpecFileLine: line without paren format → false', () => {
  const line = `${REL}: error TS2304: Cannot find name 'z'.`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(false);
});

test('isSpecFileLine: line without "error TS" marker → false', () => {
  const line = `${REL}(10,5): warning: something`;
  expect(isSpecFileLine(line, REL, BASE)).toBe(false);
});

test('isSpecFileLine: Windows-style backslashes in file part → true', () => {
  const winLine = `src\\utils\\myModule.spec.ts(10,5): error TS2345: Arg type mismatch.`;
  expect(isSpecFileLine(winLine, REL, BASE)).toBe(true);
});

test('isSpecFileLine: empty line → false', () => {
  expect(isSpecFileLine('', REL, BASE)).toBe(false);
});
