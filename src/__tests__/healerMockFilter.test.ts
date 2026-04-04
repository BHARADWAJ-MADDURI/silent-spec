import * as ts from 'typescript';
import { isJsxRelatedError, findMockFactoryRanges, ErrorRange } from '../utils/specHealer';

// ── isJsxRelatedError ────────────────────────────────────────────────────────

test('isJsxRelatedError: TS17004 is JSX-related', () => {
  const err: ErrorRange = { code: 17004, start: 0, end: 1, message: "Cannot use JSX unless the '--jsx' flag is provided." };
  expect(isJsxRelatedError(err)).toBe(true);
});

test('isJsxRelatedError: TS17001 is JSX-related', () => {
  const err: ErrorRange = { code: 17001, start: 0, end: 1, message: 'some message' };
  expect(isJsxRelatedError(err)).toBe(true);
});

test('isJsxRelatedError: TS2607 is JSX-related', () => {
  const err: ErrorRange = { code: 2607, start: 0, end: 1, message: 'JSX element type is not a constructor.' };
  expect(isJsxRelatedError(err)).toBe(true);
});

test('isJsxRelatedError: TS2786 is JSX-related', () => {
  const err: ErrorRange = { code: 2786, start: 0, end: 1, message: 'cannot be used as a JSX component.' };
  expect(isJsxRelatedError(err)).toBe(true);
});

test('isJsxRelatedError: message containing "jsx" (case-insensitive) is JSX-related', () => {
  const err: ErrorRange = { code: 9999, start: 0, end: 1, message: 'Invalid JSX usage detected.' };
  expect(isJsxRelatedError(err)).toBe(true);
});

test('isJsxRelatedError: non-JSX code with unrelated message is not JSX-related', () => {
  const err: ErrorRange = { code: 2304, start: 0, end: 5, message: "Cannot find name 'describe'" };
  expect(isJsxRelatedError(err)).toBe(false);
});

test('isJsxRelatedError: TS2345 type-mismatch is not JSX-related', () => {
  const err: ErrorRange = { code: 2345, start: 10, end: 20, message: 'Argument of type X is not assignable to parameter of type Y.' };
  expect(isJsxRelatedError(err)).toBe(false);
});

// ── findMockFactoryRanges ────────────────────────────────────────────────────

function makeSourceFile(code: string): ts.SourceFile {
  return ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
}

test('findMockFactoryRanges: detects jest.mock factory', () => {
  const code = `jest.mock('./mod', () => ({ value: 1 }));`;
  const sf = makeSourceFile(code);
  const ranges = findMockFactoryRanges(sf);
  expect(ranges).toHaveLength(1);
  // factory argument starts at the leading `(` of `() => ...`
  const factoryStart = code.indexOf('() => ({ value: 1 })');
  expect(ranges[0].start).toBe(factoryStart);
  expect(ranges[0].end).toBeGreaterThan(factoryStart);
});

test('findMockFactoryRanges: detects vi.mock factory', () => {
  const code = `vi.mock('./mod', () => ({ fn: () => {} }));`;
  const sf = makeSourceFile(code);
  const ranges = findMockFactoryRanges(sf);
  expect(ranges).toHaveLength(1);
});

test('findMockFactoryRanges: detects multiple mock calls', () => {
  const code = [
    `jest.mock('./a', () => ({ a: 1 }));`,
    `vi.mock('./b', () => ({ b: 2 }));`,
  ].join('\n');
  const sf = makeSourceFile(code);
  expect(findMockFactoryRanges(sf)).toHaveLength(2);
});

test('findMockFactoryRanges: returns empty array when no mocks present', () => {
  expect(findMockFactoryRanges(makeSourceFile('const x = 1;'))).toHaveLength(0);
});

test('findMockFactoryRanges: mock with no factory argument returns empty', () => {
  // jest.mock('./mod') — first arg only, no factory
  const sf = makeSourceFile(`jest.mock('./mod');`);
  expect(findMockFactoryRanges(sf)).toHaveLength(0);
});

// ── position-inside-factory checks ──────────────────────────────────────────

test('position inside jest.mock factory body falls within factory range', () => {
  const code = `jest.mock('./mod', () => ({ label: 'hello' }));`;
  const sf = makeSourceFile(code);
  const ranges = findMockFactoryRanges(sf);
  expect(ranges).toHaveLength(1);
  const insidePos = code.indexOf("'hello'");
  expect(ranges.some(r => insidePos >= r.start && insidePos <= r.end)).toBe(true);
});

test('position outside jest.mock factory body does not fall within factory range', () => {
  const code = `jest.mock('./mod', () => ({}));\nconst outside = 1;`;
  const sf = makeSourceFile(code);
  const ranges = findMockFactoryRanges(sf);
  const outsidePos = code.indexOf('outside');
  expect(ranges.some(r => outsidePos >= r.start && outsidePos <= r.end)).toBe(false);
});

test('non-JSX error inside mock factory is still non-JSX', () => {
  // isJsxRelatedError check is independent of position
  const err: ErrorRange = { code: 2304, start: 30, end: 40, message: "Cannot find name 'something'" };
  expect(isJsxRelatedError(err)).toBe(false);
});
