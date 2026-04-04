import { computeWorkList } from '../utils/markerManager';

const base = { covered: [], pending: [], gaps: ['a', 'b', 'c'], dropped: [] };

test('maxPerRun=0 still returns at least 1 function', () => {
  expect(computeWorkList(base, 0).length).toBeGreaterThanOrEqual(1);
});

test('maxPerRun=0 clamps to exactly 1', () => {
  expect(computeWorkList(base, 0)).toEqual(['a']);
});

test('maxPerRun=2 returns at most 2', () => {
  expect(computeWorkList(base, 2)).toEqual(['a', 'b']);
});

test('negative maxPerRun also clamps to 1', () => {
  expect(computeWorkList(base, -5)).toEqual(['a']);
});
