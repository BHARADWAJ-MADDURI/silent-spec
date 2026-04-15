export interface SSMarker {
  version: number;
  covered: string[];  // functions with verified describe() blocks written
  pending: string[];  // functions AI didn't reach due to token limit
}

export interface MarkerReadResult {
  marker: SSMarker | null;  // null = no marker found (first run)
  startIdx: number;         // char position of SS-GENERATED-START line start
  endIdx: number;           // char position of SS-GENERATED-END line end (inclusive)
  innerContent: string;     // content between start and end markers
}

export interface ReconcileResult {
  covered: string[];  // still-valid covered functions
  pending: string[];  // still-valid pending functions (will be retried this run)
  gaps: string[];     // exports not yet covered (new since last run)
  dropped: string[];  // stale entries removed because they no longer exist in source
}

// AI output split into three buckets — each goes to a different zone.
export interface SplitAIOutput {
  importsBlock: string;  // → SS-IMPORTS (import statements + vi/jest mocks)
  helpersBlock: string;  // → SS-HELPERS (const/function declarations)
  testsBlock: string;    // → SS-GENERATED (describe/test/it ONLY)
}

export const SS_START_PREFIX = '// <SS-GENERATED-START';
export const SS_END = '// <SS-GENERATED-END>';

// Hard cap per run — prevents token limit loops.
export const DEFAULT_MAX_FUNCTIONS_PER_RUN = 5;

// Max retry attempts per function per session before it is dropped from pending.
export const MAX_RETRIES_PER_FUNCTION = 3;

function parseList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function parseAttr(line: string, name: string): string {
  const start = line.indexOf(`${name}="`);
  if (start === -1) { return ''; }
  const valueStart = start + name.length + 2;
  const valueEnd = line.indexOf('"', valueStart);
  if (valueEnd === -1) { return ''; }
  return line.slice(valueStart, valueEnd);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function parseMarkerLine(line: string): SSMarker | null {
  if (!line.trimStart().startsWith(SS_START_PREFIX)) { return null; }
  const vStr = parseAttr(line, 'v');
  const v = parseInt(vStr || '1', 10);
  return {
    version: isNaN(v) ? 1 : v,
    covered: parseList(parseAttr(line, 'covered')),
    pending: parseList(parseAttr(line, 'pending')),
  };
}

export function buildMarkerLine(marker: SSMarker): string {
  const pendingAttr = marker.pending.length > 0
    ? ` pending="${marker.pending.join(',')}"`
    : '';
  return `${SS_START_PREFIX} v="${marker.version}" covered="${marker.covered.join(',')}"${pendingAttr}>`;
}

export function readMarker(specContent: string): MarkerReadResult {
  const lines = specContent.split('\n');
  let startLineIdx = -1;
  let endLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(SS_START_PREFIX)) { startLineIdx = i; }
    if (lines[i].trim() === SS_END) { endLineIdx = i; }
  }

  if (startLineIdx === -1 || endLineIdx === -1) {
    return { marker: null, startIdx: -1, endIdx: -1, innerContent: '' };
  }

  const marker = parseMarkerLine(lines[startLineIdx]);

  let charPos = 0;
  let startCharIdx = -1;
  let endCharIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (i === startLineIdx) { startCharIdx = charPos; }
    if (i === endLineIdx) { endCharIdx = charPos + lines[i].length; }
    charPos += lines[i].length + 1;
  }

  const innerContent = lines
    .slice(startLineIdx + 1, endLineIdx)
    .join('\n')
    .trim();

  return { marker, startIdx: startCharIdx, endIdx: endCharIdx, innerContent };
}

export function reconcile(
  marker: SSMarker | null,
  currentExports: string[]
): ReconcileResult {
  if (!marker) {
    return { covered: [], pending: [], gaps: currentExports, dropped: [] };
  }

  const exportSet = new Set(currentExports);
  const validCovered = marker.covered.filter(fn => exportSet.has(fn));
  const validPending = marker.pending.filter(fn => exportSet.has(fn));
  const dropped = [
    ...marker.covered.filter(fn => !exportSet.has(fn)),
    ...marker.pending.filter(fn => !exportSet.has(fn)),
  ];
  const coveredSet = new Set(validCovered);
  const gaps = currentExports.filter(fn => !coveredSet.has(fn));

  return { covered: validCovered, pending: validPending, gaps, dropped };
}

export function computeWorkList(
  reconciled: ReconcileResult,
  maxPerRun: number = DEFAULT_MAX_FUNCTIONS_PER_RUN
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const fn of [...reconciled.pending, ...reconciled.gaps]) {
    if (!seen.has(fn)) {
      seen.add(fn);
      ordered.push(fn);
    }
  }

  return ordered.slice(0, Math.max(1, maxPerRun));
}

export function verifyGenerated(
  generatedContent: string,
  workList: string[]
): { nowCovered: string[]; nowPending: string[] } {
  const nowCovered: string[] = [];
  const nowPending: string[] = [];

  for (const fn of workList) {
    const pattern = new RegExp(
      `describe\\s*\\(\\s*['"\`][^'"\`]*\\b${escapeRegex(fn)}\\b[^'"\`]*['"\`]`,
      'i'
    );
    if (pattern.test(generatedContent)) {
      nowCovered.push(fn);
    } else {
      nowPending.push(fn);
    }
  }

  return { nowCovered, nowPending };
}

export function buildUpdatedMarker(
  existingCovered: string[],
  nowCovered: string[],
  nowPending: string[]
): SSMarker {
  return {
    version: 1,
    covered: dedupe([...existingCovered, ...nowCovered]),
    pending: nowPending,
  };
}

export function rebuildMarkerFromContent(
  specContent: string,
  currentExports: string[]
): SSMarker | null {
  const { marker, innerContent } = readMarker(specContent);
  if (!marker && !innerContent) { return null; }

  const { nowCovered } = verifyGenerated(innerContent, currentExports);
  const coveredSet = new Set(nowCovered);
  const stillPending = (marker?.pending ?? []).filter(
    fn => !coveredSet.has(fn) && currentExports.includes(fn)
  );

  return {
    version: marker?.version ?? 1,
    covered: nowCovered,
    pending: stillPending,
  };
}

export function spliceTests(
  specContent: string,
  newTests: string,
  updatedMarker: SSMarker
): string {
  const { startIdx, endIdx, innerContent } = readMarker(specContent);

  if (startIdx === -1 || endIdx === -1) { return specContent; }

  const combined = innerContent.trim()
    ? `${innerContent.trim()}\n\n${newTests.trim()}`
    : newTests.trim();

  const newBlock = [buildMarkerLine(updatedMarker), combined, SS_END].join('\n');

  return specContent.slice(0, startIdx) + newBlock + specContent.slice(endIdx);
}

export function updateMarkerOnly(
  specContent: string,
  updatedMarker: SSMarker
): string {
  const lines = specContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(SS_START_PREFIX)) {
      lines[i] = buildMarkerLine(updatedMarker);
      return lines.join('\n');
    }
  }
  return specContent;
}


// ─── Local model/enum mock filter ─────────────────────────────────────────────
// Shared with splitAIOutput — prevents model/type/enum mocks from reaching SS-IMPORTS.
const LOCAL_MODEL_SEGMENT_RE_MM = /^(models?|types?|enums?|constants?|dtos?|entities|entity|interfaces?|schemas?)$/i;
const LOCAL_MODEL_SUFFIX_RE_MM  = /\.(model|type|enum|constant|dto|entity|interface|schema)$/i;

function isLocalModelMockPath(mockPath: string): boolean {
  if (!mockPath.startsWith('.')) { return false; }
  const lastSegment = (mockPath.split('/').pop() ?? '').replace(/\.[tj]sx?$/, '');
  return LOCAL_MODEL_SEGMENT_RE_MM.test(lastSegment) || LOCAL_MODEL_SUFFIX_RE_MM.test(lastSegment);
}

// Core AI output splitter — enforces the 6-block structure.
//
// Takes raw AI output and splits it into three buckets:
//
//   importsBlock → SS-IMPORTS
//     - import statements
//     - vi.mock() / jest.mock() calls (including multi-line factories)
//
//   helpersBlock → SS-HELPERS
//     - const / let / function declarations before the first describe block
//     - fakeTransaction, fakeUser, etc.
//
//   testsBlock → SS-GENERATED
//     - describe() / test() / it() blocks ONLY
//     - decorative comments (// ─) treated as test block start
//     - NO imports, NO helpers allowed here
//
// This is the single source of truth for what goes where.
// fileWriter.ts reads these buckets and writes to the correct zones.

export function splitAIOutput(
  aiOutput: string,
  marker: SSMarker
): SplitAIOutput {
  // Strip any SS marker lines the AI may have echoed back
  const inner = aiOutput
    .replace(/^\/\/ <SS-GENERATED-START[^\n]*\n/m, '')
    .replace(/\/\/ <SS-GENERATED-END>\s*$/m, '')
    .trim();

  const lines = inner.split('\n');
  const importLines: string[] = [];
  const helperLines: string[] = [];
  const testLines: string[] = [];

  let foundTests = false;
  let mockParenDepth = 0;   // tracks open parens inside vi.mock/jest.mock factories
  let skipMockDepth = 0;    // tracks paren depth of a filtered local-model mock being skipped
  let importBraceDepth = 0; // tracks open braces inside multiline import { ... } blocks

  for (const line of lines) {
    const t = line.trim();

    // ── Already in test territory ─────────────────────────────────────────
    if (foundTests) {
      testLines.push(line);
      continue;
    }

    // ── Skipping continuation lines of a filtered local-model mock factory ─
    if (skipMockDepth > 0) {
      for (const ch of line) {
        if (ch === '(') { skipMockDepth++; }
        if (ch === ')') { skipMockDepth--; }
      }
      continue;
    }

    // ── Continuation of a multi-line mock factory ─────────────────────────
    if (mockParenDepth > 0) {
      importLines.push(line);
      for (const ch of line) {
        if (ch === '(') { mockParenDepth++; }
        if (ch === ')') { mockParenDepth--; }
      }
      continue;
    }

    // ── Continuation of a multi-line import { ... } block ─────────────────
    // e.g. the AI writes:
    //   import {
    //     formatFullName,   ← this line starts with no 'import', falls here
    //     receiverIsCurrentUser,
    //   } from '../transactionUtils';
    if (importBraceDepth > 0) {
      importLines.push(line);
      for (const ch of line) {
        if (ch === '{') { importBraceDepth++; }
        if (ch === '}') { importBraceDepth--; }
      }
      continue;
    }

    // ── Import statements ─────────────────────────────────────────────────
    if (t.startsWith('import ')) {
      importLines.push(line);
      // Track brace depth for multiline imports: import { ... }
      // If the opening brace is not closed on the same line, enter multiline mode
      for (const ch of line) {
        if (ch === '{') { importBraceDepth++; }
        if (ch === '}') { importBraceDepth--; }
      }
      continue;
    }

    // ── Top-level spy registrations → imports bucket ─────────────────────
    // vi.spyOn()/jest.spyOn() at the top level (outside any factory) are module-
    // level setup — they belong in SS-IMPORTS alongside vi.mock()/jest.mock().
    if (t.startsWith('vi.spyOn(') || t.startsWith('jest.spyOn(')) {
      importLines.push(line);
      continue;
    }

    // ── Module-level mock calls → imports bucket ──────────────────────────
    if (t.startsWith('vi.mock(') || t.startsWith('jest.mock(')) {
      // Filter mocks for local model/type/enum/constants files.
      // TS erases these at compile time — mocking them removes enum values.
      const mockPathMatch = t.match(/^(?:vi|jest)\.mock\s*\(\s*['"]([^'"]+)['"]/);
      if (mockPathMatch && isLocalModelMockPath(mockPathMatch[1])) {
        // Track paren depth to skip any multi-line factory continuation lines
        for (const ch of line) {
          if (ch === '(') { skipMockDepth++; }
          if (ch === ')') { skipMockDepth--; }
        }
        continue;
      }
      importLines.push(line);
      for (const ch of line) {
        if (ch === '(') { mockParenDepth++; }
        if (ch === ')') { mockParenDepth--; }
      }
      continue;
    }

    // Test block starters — switch to test mode.
    // Decorative comment separators that precede describe blocks (// ─) also trigger test mode.
    // Note: '// --' removed intentionally — Claude uses '// ---' style separators before
    // helper sections too (e.g. '// --- helpers ---'), which must NOT trigger test mode early.
    if (
      t.startsWith('describe(') || t.startsWith('describe.') ||
      t.startsWith('test(')     || t.startsWith('it(') ||
      t.startsWith('beforeEach(') || t.startsWith('beforeAll(') ||
      t.startsWith('afterEach(')  || t.startsWith('afterAll(') ||
      t.startsWith('// ─')  || t.startsWith('// ==')
    ) {
      foundTests = true;
      testLines.push(line);
      continue;
    }

    // ── Everything else before tests → helpers ────────────────────────────
    // Blank lines, const, let, function, class declarations, comments
    helperLines.push(line);
  }

  // Wrap tests in the marker
  const testsBlock = [
    buildMarkerLine(marker),
    testLines.join('\n').trim(),
    SS_END,
  ].join('\n');

  return {
    importsBlock: importLines.join('\n').trim(),
    helpersBlock: helperLines.join('\n').trim(),
    testsBlock,
  };
}

function describeLineMatchesFunction(line: string, functionNames: string[]): boolean {
  const t = line.trim();
  if (!t.startsWith('describe(') && !t.startsWith('describe.')) { return false; }

  return functionNames.some(fn => {
    const pattern = new RegExp(
      `^describe(?:\\.\\w+)?\\s*\\(\\s*['"\`][^'"\`]*\\b${escapeRegex(fn)}\\b[^'"\`]*['"\`]`,
      'i'
    );
    return pattern.test(t);
  });
}

function filterGeneratedTestBodyToFunctions(testBody: string, functionNames: string[]): string {
  if (functionNames.length === 0) { return testBody; }

  const lines = testBody.split('\n');
  const keptBlocks: string[] = [];
  let currentBlock: string[] = [];
  let capturing = false;
  let keepCurrent = false;
  let braceDepth = 0;

  for (const line of lines) {
    const t = line.trim();

    if (!capturing) {
      if (describeLineMatchesFunction(line, functionNames)) {
        capturing = true;
        keepCurrent = true;
        currentBlock = [line];
        braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;

        if (braceDepth === 0) {
          keptBlocks.push(currentBlock.join('\n').trim());
          capturing = false;
          keepCurrent = false;
          currentBlock = [];
        }
        continue;
      }

      // Drop top-level blocks for functions outside the current work list.
      if (t.startsWith('describe(') || t.startsWith('describe.')) {
        capturing = true;
        keepCurrent = false;
        currentBlock = [];
        braceDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
        if (braceDepth === 0) {
          capturing = false;
        }
      }
      continue;
    }

    if (keepCurrent) { currentBlock.push(line); }
    braceDepth += (line.match(/\{/g) ?? []).length;
    braceDepth -= (line.match(/\}/g) ?? []).length;

    if (braceDepth === 0) {
      if (keepCurrent) {
        keptBlocks.push(currentBlock.join('\n').trim());
      }
      capturing = false;
      keepCurrent = false;
      currentBlock = [];
    }
  }

  return keptBlocks.join('\n\n').trim();
}

export function filterGeneratedOutputToFunctions(
  aiOutput: string,
  functionNames: string[]
): string {
  if (functionNames.length === 0) { return aiOutput; }

  const marker: SSMarker = { version: 1, covered: functionNames, pending: [] };
  const { importsBlock, helpersBlock, testsBlock } = splitAIOutput(aiOutput, marker);
  const { innerContent } = readMarker(testsBlock);
  const filteredTests = filterGeneratedTestBodyToFunctions(innerContent, functionNames);

  return [
    importsBlock,
    helpersBlock,
    buildMarkerLine(marker),
    filteredTests,
    SS_END,
  ].filter(section => section.trim().length > 0).join('\n\n');
}

// Backward-compatible alias — callers that use buildGeneratedBlock still work.
// Returns all three buckets; generatedBlock = testsBlock.
export function buildGeneratedBlock(
  aiOutput: string,
  marker: SSMarker
): { importsBlock: string; helpersBlock: string; generatedBlock: string } {
  const { importsBlock, helpersBlock, testsBlock } = splitAIOutput(aiOutput, marker);
  return { importsBlock, helpersBlock, generatedBlock: testsBlock };
}
