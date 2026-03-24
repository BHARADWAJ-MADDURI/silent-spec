import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

export interface HealResult {
  healed: string;
  removedTests: string[];
  removedTestReasons: Record<string, string>;
  errorCount: number;
  wasHealed: boolean;
  healedCount: number;
  hasGlobalErrors: boolean;
  missingTypes?: boolean;  // true when TS2582/TS2304 on test globals — @types missing
  framework?: string;      // framework name from healSpec caller, forwarded for notification
}

interface ItBlock {
  name: string;
  start: number;
  end: number;
}

interface ErrorRange {
  start: number;
  end: number;
  message: string;
  code: number;
}

function isItOrTestCall(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) {
    return expr.text === 'it' || expr.text === 'test';
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = expr.expression;
    return ts.isIdentifier(base) && (base.text === 'it' || base.text === 'test');
  }
  if (ts.isCallExpression(expr)) {
    return isItOrTestCall(expr.expression);
  }
  return false;
}

function extractTestName(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const firstArg = node.arguments[0];
  if (!firstArg) { return 'unknown test'; }
  if (ts.isStringLiteral(firstArg)) { return firstArg.text; }
  if (ts.isNoSubstitutionTemplateLiteral(firstArg)) { return firstArg.text; }
  if (ts.isTemplateExpression(firstArg)) { return firstArg.head.text + '...'; }
  return firstArg.getText(sourceFile);
}

function findItBlocks(sourceFile: ts.SourceFile): ItBlock[] {
  const blocks: ItBlock[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && isItOrTestCall(node.expression)) {
      blocks.push({
        name: extractTestName(node, sourceFile),
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return blocks;
}

function findDescribeBlocks(sourceFile: ts.SourceFile): Array<{start: number; end: number}> {
  const blocks: Array<{start: number; end: number}> = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isDescribe =
        (ts.isIdentifier(expr) && expr.text === 'describe') ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === 'describe');
      if (isDescribe) {
        blocks.push({ start: node.getStart(sourceFile), end: node.getEnd() });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return blocks;
}

function buildErrorRanges(
  diagnostics: readonly ts.Diagnostic[],
  sourceFile: ts.SourceFile
): ErrorRange[] {
  return diagnostics
    .filter(d => d.file === sourceFile && d.start !== undefined)
    .map(d => ({
      start: d.start!,
      end: d.start! + (d.length ?? 1),
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      code: d.code,
    }));
}

function errorOverlapsBlock(error: ErrorRange, block: ItBlock): boolean {
  return error.start <= block.end && error.end >= block.start;
}

function classifyTsError(code: number): string {
  if (code === 2345 || code === 2322) { return 'type_mismatch'; }
  if (code === 2304 || code === 2339) { return 'missing_symbol'; }
  if (code === 2305 || code === 2307) { return 'import_error'; }
  if (code === 2554) { return 'wrong_signature'; }
  return `ts_error_${code}`;
}

function dominantErrorCategory(errors: ErrorRange[]): string {
  if (errors.length === 0) { return 'unknown'; }
  const counts = new Map<string, number>();
  for (const e of errors) {
    const cat = classifyTsError(e.code);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function resolveCompilerOptions(
  sourceFilePath: string,
  emit: (msg: string) => void
): ts.CompilerOptions {
  const configPath = ts.findConfigFile(
    path.dirname(sourceFilePath),
    ts.sys.fileExists,
    'tsconfig.json'
  );

  if (!configPath) {
    emit('Healer: no tsconfig.json found — using permissive defaults');
    return {
      noEmit: true, skipLibCheck: true, strict: false,
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, allowJs: true,
      allowSyntheticDefaultImports: true, resolveJsonModule: true,
    };
  }

  emit(`Healer: using tsconfig at ${configPath}`);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    emit('Healer: tsconfig parse error — falling back to defaults');
    return {
      noEmit: true, skipLibCheck: true, strict: false,
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, allowJs: true,
      allowSyntheticDefaultImports: true, resolveJsonModule: true,
    };
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config, ts.sys, path.dirname(configPath)
  );
  return { ...parsed.options, noEmit: true, skipLibCheck: true };
}

function partialRepair(
  specContent: string,
  block: ItBlock,
  errors: ErrorRange[]
): string {
  const lineStartPositions: number[] = [0];
  for (let i = 0; i < specContent.length; i++) {
    if (specContent[i] === '\n') { lineStartPositions.push(i + 1); }
  }

  const getLineNumber = (pos: number): number => {
    let line = 0;
    for (let i = 0; i < lineStartPositions.length; i++) {
      if (lineStartPositions[i] <= pos) { line = i; }
      else { break; }
    }
    return line;
  };

  const blockStartLine = getLineNumber(block.start);
  const blockEndLine   = getLineNumber(block.end);
  const errorLineNumbers = new Set<number>();

  for (const error of errors) {
    if (errorOverlapsBlock(error, block)) {
      errorLineNumbers.add(getLineNumber(error.start));
    }
  }

  const lines = specContent.split('\n');
  const repairedLines = [...lines];

  for (const lineNum of errorLineNumbers) {
    if (lineNum >= blockStartLine && lineNum <= blockEndLine) {
      const original = repairedLines[lineNum];
      if (original.includes('{') || original.includes('}')) {
        return specContent;
      }
      repairedLines[lineNum] =
        `${original.match(/^(\s*)/)?.[1] ?? ''}// [SS-HEALED] type error: ${original.trim()}`;
    }
  }

  return repairedLines.join('\n');
}

function buildProgram(
  specContent: string,
  specFileName: string,
  sourceFilePath: string,
  compilerOptions: ts.CompilerOptions
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile(
    specFileName, specContent, ts.ScriptTarget.Latest, true
  );

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName: string, languageVersion: ts.ScriptTarget) => {
    if (fileName === specFileName) { return sourceFile; }
    return originalGetSourceFile(fileName, languageVersion);
  };

  const program = ts.createProgram([specFileName, sourceFilePath], compilerOptions, host);
  return { program, sourceFile };
}

function diagnose(
  specContent: string,
  specFileName: string,
  sourceFilePath: string,
  compilerOptions: ts.CompilerOptions
): { errorRanges: ErrorRange[]; itBlocks: ItBlock[]; describeBlocks: Array<{start: number; end: number}> } {
  const { program, sourceFile } = buildProgram(
    specContent, specFileName, sourceFilePath, compilerOptions
  );
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];
  return {
    errorRanges: buildErrorRanges(diagnostics, sourceFile),
    itBlocks: findItBlocks(sourceFile),
    describeBlocks: findDescribeBlocks(sourceFile),
  };
}

// Test framework globals used by vitest/jest that TypeScript doesn't know about
// unless @types/vitest or @types/jest are properly configured.
// Errors referencing these names are false positives — the test runner handles
// them at runtime via its own transform, not through the TS type system.
const TEST_FRAMEWORK_GLOBALS = new Set([
  'vi', 'jest',           // mock utilities
  'describe', 'it', 'test', 'expect', // core test functions
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', // lifecycle hooks
]);

// Returns true if an error is a false positive caused by missing type
// definitions for test framework globals (vi, jest, describe, expect etc.)
// These are injected by the test runner at runtime and don't need TS types.
function isTestFrameworkGlobalError(error: ErrorRange, specContent: string): boolean {
  // TS2304: Cannot find name 'X' — check if X is a known test global
  // TS2582: Cannot find name 'X'. Do you need to install type definitions for a test runner?
  //         This fires when @types/jest / @types/vitest are missing — always a false positive here.
  if (error.code !== 2304 && error.code !== 2582) { return false; }
  const snippet = specContent.slice(error.start, error.end);
  return TEST_FRAMEWORK_GLOBALS.has(snippet.trim());
}

// Returns true if an error position falls inside a vi.mock() or jest.mock() factory.
// These produce TS errors (JSX without transform, complex type inference) that
// vitest/jest handle themselves at runtime.
function isInsideMockFactory(pos: number, specContent: string): boolean {
  const before = specContent.slice(0, pos);
  const viPos = before.lastIndexOf('vi.mock(');
  const jestPos = before.lastIndexOf('jest.mock(');
  const mockStart = Math.max(viPos, jestPos);
  if (mockStart === -1) { return false; }
  let depth = 0;
  for (let i = mockStart; i < before.length; i++) {
    if (before[i] === '(') { depth++; }
    if (before[i] === ')') {
      depth--;
      if (depth === 0) { return false; }
    }
  }
  return depth > 0;
}

function getLineNumber1Based(pos: number, content: string): number {
  return content.slice(0, pos).split('\n').length;
}

// Wraps the offending expression [error.start, error.end) with a double-cast
// to silence TS2345 argument-type errors inside describe() blocks.
// e.g. fn({ id: 1 }) → fn(({ id: 1 } as unknown as any))
function applyTypeCast(content: string, error: ErrorRange): string {
  const before = content.slice(0, error.start);
  const expr   = content.slice(error.start, error.end);
  const after  = content.slice(error.end);
  return `${before}(${expr} as unknown as any)${after}`;
}

export function healSpec(
  specContent: string,
  specFileName: string,
  sourceFilePath: string,
  log?: (msg: string) => void,
  mode: 'full' | 'safe' = 'full',
  framework?: string
): HealResult {
  const emit = log ?? (() => {});
  if (mode === 'safe') {
    emit('Healer: running in safe mode — test removal disabled');
  }

  // Pre-check: if tsc --noEmit passes cleanly, the spec has no real errors.
  // Skip all diagnostic analysis — the healer's in-process TS program can report
  // false positives (e.g. TS2582) that the real tsc does not.
  const tsconfigPath = ts.findConfigFile(
    path.dirname(sourceFilePath),
    ts.sys.fileExists,
    'tsconfig.json'
  );
  if (tsconfigPath) {
    try {
      let tscBin = '';
      let searchDir = path.dirname(tsconfigPath);
      while (searchDir !== path.dirname(searchDir)) {
        const candidate = path.join(searchDir, 'node_modules', '.bin', 'tsc');
        if (fs.existsSync(candidate)) { tscBin = candidate; break; }
        searchDir = path.dirname(searchDir);
      }
      const tscCmd = tscBin || 'tsc';
      execSync(`"${tscCmd}" --noEmit --project "${tsconfigPath}"`, { stdio: 'pipe' });
      emit('Healer: tsc clean — skipping diagnostic analysis');
      return {
        healed: specContent, removedTests: [], removedTestReasons: {},
        errorCount: 0, wasHealed: false, healedCount: 0,
        hasGlobalErrors: false, missingTypes: false, framework,
      };
    } catch (err: unknown) {
      // tsc exited non-zero or was not found — fall through to normal analysis
      const msg = err instanceof Error ? err.message : String(err);
      const firstLine = msg.split('\n')[0].trim();
      emit(`Healer: tsc reported errors — running diagnostic analysis (${firstLine})`);
    }
  }

  const compilerOptions = resolveCompilerOptions(sourceFilePath, emit);

  try {
    const { program, sourceFile } = buildProgram(
      specContent, specFileName, sourceFilePath, compilerOptions
    );

    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];

    if (diagnostics.length === 0) {
      return {
        healed: specContent, removedTests: [], removedTestReasons: {},
        errorCount: 0, wasHealed: false, healedCount: 0, hasGlobalErrors: false,
      };
    }

    const errorRanges    = buildErrorRanges(diagnostics, sourceFile);

    // Improvement 4 — categorised diagnostic breakdown.
    // Three mutually exclusive categories, checked in priority order so every
    // diagnostic appears in exactly one bucket and the three counts sum to total.
    const testGlobalsCount = errorRanges.filter(err => {
      if (err.code !== 2582 && err.code !== 2304) { return false; }
      const lineStart = specContent.lastIndexOf('\n', err.start - 1) + 1;
      const lineEnd   = specContent.indexOf('\n', err.start);
      const line      = specContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      return line.includes('it(') || line.includes('describe(') ||
             line.includes('expect(') || line.includes('test(');
    }).length;
    const frameworkFPCount = errorRanges.filter(err => {
      if (err.code !== 2582 && err.code !== 2304) { return false; }
      const lineStart = specContent.lastIndexOf('\n', err.start - 1) + 1;
      const lineEnd   = specContent.indexOf('\n', err.start);
      const line      = specContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      const isTestLine = line.includes('it(') || line.includes('describe(') ||
                         line.includes('expect(') || line.includes('test(');
      return !isTestLine && isTestFrameworkGlobalError(err, specContent);
    }).length;
    const otherCount = diagnostics.length - testGlobalsCount - frameworkFPCount;
    emit(`Healer: ${diagnostics.length} diagnostic(s) found (${testGlobalsCount} test globals, ${frameworkFPCount} framework false positives, ${otherCount} other)`);

    const itBlocks       = findItBlocks(sourceFile);
    const describeBlocks = findDescribeBlocks(sourceFile);

    // ── Early bail — missing @types package ───────────────────────────────
    // TS2582/TS2304 on test globals (describe, it, expect, etc.) means the
    // @types/<framework> package is not installed. The healer cannot fix this —
    // preserve all generated tests untouched and signal the caller to notify.
    const missingTypeDiags = errorRanges.filter(err =>
      isTestFrameworkGlobalError(err, specContent)
    );
    if (missingTypeDiags.length > 0) {
      const fw = framework ?? 'jest';
      emit(`Healer: TS2582/TS2304 on test globals — @types/${fw} may be missing. Preserving generated tests untouched.`);
      return {
        healed: specContent, removedTests: [], removedTestReasons: {},
        errorCount: diagnostics.length, wasHealed: false, healedCount: 0,
        hasGlobalErrors: false, missingTypes: true, framework: fw,
      };
    }

    // ── Log test-framework global false positives ──────────────────────────
    const falsePositiveCount = errorRanges.filter(err =>
      !itBlocks.some(b => errorOverlapsBlock(err, b)) &&
      isTestFrameworkGlobalError(err, specContent)
    ).length;
    if (falsePositiveCount > 0) {
      emit(`Healer: ${falsePositiveCount} false positive(s) from test framework globals — ignoring`);
    }

    // ── Errors outside all it() blocks, excluding test-framework globals ───
    const outsideItErrors = errorRanges.filter(err =>
      !itBlocks.some(b => errorOverlapsBlock(err, b)) &&
      !isTestFrameworkGlobalError(err, specContent)
    );

    // ── Category C: attempt cast recovery for TS2345 inside describe() ─────
    // Process in reverse position order so earlier positions stay valid after
    // each insertion.
    let workContent    = specContent;
    let workErrorCount = diagnostics.length;

    emit(`Healer: ${outsideItErrors.length} outside-it error(s), checking for Category C candidates`);

    const categoryCCandidates = outsideItErrors
      .filter(err =>
        err.code === 2345 &&
        describeBlocks.some(b => err.start >= b.start && err.end <= b.end) &&
        !isInsideMockFactory(err.start, specContent)
      )
      .sort((a, b) => b.start - a.start);

    for (const err of categoryCCandidates) {
      const lineNum = getLineNumber1Based(err.start, workContent);
      const casted  = applyTypeCast(workContent, err);
      const { errorRanges: castErrors } = diagnose(casted, specFileName, sourceFilePath, compilerOptions);
      if (castErrors.length < workErrorCount) {
        workContent    = casted;
        workErrorCount = castErrors.length;
        emit(`Healer: recovered describe-scoped type error on line ${lineNum}`);
      }
      // If cast didn't help, will be logged as Category A in classification below
    }

    // ── Re-diagnose if any casts were applied ──────────────────────────────
    let finalErrors        = errorRanges;
    let finalItBlocks      = itBlocks;
    let finalDescribeBlocks = describeBlocks;

    if (workContent !== specContent) {
      const rediag        = diagnose(workContent, specFileName, sourceFilePath, compilerOptions);
      finalErrors         = rediag.errorRanges;
      finalItBlocks       = rediag.itBlocks;
      finalDescribeBlocks = rediag.describeBlocks;
    }

    // ── Classify remaining outside-it() errors into Category A / B ─────────
    const finalOutsideItErrors = finalErrors.filter(err =>
      !finalItBlocks.some(b => errorOverlapsBlock(err, b)) &&
      !isTestFrameworkGlobalError(err, workContent)
    );

    let hasCategoryA = false;
    let hasCategoryB = false;

    const workLines = workContent.split('\n');

    for (const err of finalOutsideItErrors) {
      const lineNum   = getLineNumber1Based(err.start, workContent);
      const lineIndex = lineNum - 1;
      const lineText  = workLines[lineIndex] ?? '';

      if (isInsideMockFactory(err.start, workContent)) {
        // Category A — inside vi.mock()/jest.mock() factory (runtime-handled)
        emit(`Healer: skipping recoverable mock-factory error on line ${lineNum}`);
        hasCategoryA = true;
      } else if (err.code === 6133 || err.code === 6192) {
        // Category A — TS6133: 'X' is declared but its value is never read.
        //              TS6192: All imports in import declaration are unused.
        // Generated spec files import ALL exported functions up front, but only
        // a subset are tested in each batch. Unused import identifiers are a
        // batch coverage gap, not a real bug — later batches will consume them.
        emit(`Healer: skipping unused-identifier error on line ${lineNum} (batch coverage gap)`);
        hasCategoryA = true;
      } else if (err.code === 2307 && lineText.trimStart().startsWith('import ')) {
        // Category A — TS2307: "Cannot find module '...' or its corresponding type declarations"
        // on an import line is a healer false positive. The TypeScript compiler runs from
        // the spec file location with its own module resolution, but Jest uses its own
        // moduleFileExtensions / moduleNameMapper config and resolves the same path
        // correctly at runtime. All tests pass — this is a tsc-vs-Jest resolver mismatch,
        // not a missing module. Only bail on TS2307 outside import lines (e.g. dynamic
        // require() inside a test body) where the module is genuinely absent.
        emit(`Healer: skipping TS2307 on import line ${lineNum} (Jest resolver handles this)`);
        hasCategoryA = true;
      } else if (lineText.includes('jest.mock(') || lineText.includes('vi.mock(')) {
        // Category A — the jest.mock/vi.mock declaration line itself.
        // The test runner hoists these calls and handles them at runtime;
        // TypeScript errors on the declaration line are false positives.
        emit(`Healer: skipping jest.mock/vi.mock hoisted call on line ${lineNum}`);
        hasCategoryA = true;
      } else if (finalDescribeBlocks.some(b => err.start >= b.start && err.end <= b.end)) {
        // Category A — scoped inside a describe() block
        emit(`Healer: skipping recoverable describe-scoped error on line ${lineNum}`);
        hasCategoryA = true;
      } else {
        // Category B — file-level (wrong import path, missing module, syntax)
        emit(`Healer: unrecoverable file-level error on line ${lineNum} — bailing`);
        hasCategoryB = true;
      }
    }

    // Only bail if EVERY outside-it() error is Category B (no recoverable errors found)
    const hasGlobalErrors = hasCategoryB && !hasCategoryA;

    if (hasGlobalErrors) {
      return {
        healed: specContent, removedTests: [], removedTestReasons: {},
        errorCount: diagnostics.length, wasHealed: false, healedCount: 0, hasGlobalErrors: true,
      };
    }

    const blocksWithErrors = finalItBlocks.filter(block =>
      finalErrors.some(err => errorOverlapsBlock(err, block))
    );

    if (blocksWithErrors.length === 0) {
      return {
        healed: workContent, removedTests: [], removedTestReasons: {},
        errorCount: diagnostics.length, wasHealed: workContent !== specContent,
        healedCount: workContent !== specContent ? 1 : 0, hasGlobalErrors: false,
      };
    }

    // Part 5 — log a hint when TS2582 is present (missing type defs, not a test bug)
    const ts2582Count = finalErrors.filter(e => e.code === 2582).length;
    if (ts2582Count > 0) {
      emit('Healer: test type definitions may be missing — check your project\'s test setup');
    }

    let healed = workContent;
    const removedTests: string[] = [];
    const removedTestReasons: Record<string, string> = {};
    let healedCount = 0;

    // Capture safe mode as a boolean so TypeScript does not narrow it away
    // after a conditional return — we need it inside the removal loop below.
    const inSafeMode = mode === 'safe';

    const sortedBlocks = [...blocksWithErrors].sort((a, b) => b.start - a.start);

    for (const block of sortedBlocks) {
      const blockErrors = finalErrors.filter(err => errorOverlapsBlock(err, block));

      // Safe mode: skip test removal entirely.
      // TS2582 errors get a specific log ("missing type defs — not a real test bug").
      // All other error types in safe mode are also preserved without logging.
      if (inSafeMode) {
        const hasTs2582 = blockErrors.some(err => err.code === 2582);
        if (hasTs2582) {
          emit(`Healer: safe mode — preserving test despite TS2582: "${block.name}"`);
        }
        continue;
      }

      const partiallyRepaired = partialRepair(healed, block, blockErrors);

      if (partiallyRepaired !== healed) {
        const { errorRanges: partialErrors, itBlocks: partialBlocks } = diagnose(
          partiallyRepaired, specFileName, sourceFilePath, compilerOptions
        );
        const blockStillHasErrors = partialBlocks.some(b =>
          b.name === block.name &&
          partialErrors.some(err => errorOverlapsBlock(err, b))
        );

        if (!blockStillHasErrors) {
          healed = partiallyRepaired;
          emit(`Healer: partially repaired "${block.name}" — commented failing assertion(s)`);
          healedCount++;
          continue;
        }
      }

      const { itBlocks: currentBlocks } = diagnose(
        healed, specFileName, sourceFilePath, compilerOptions
      );
      const currentBlock = currentBlocks.find(b => b.name === block.name);

      if (currentBlock) {
        const currentErrors = finalErrors.filter(err => errorOverlapsBlock(err, currentBlock));
        const category = dominantErrorCategory(currentErrors);
        const topError  = currentErrors[0];
        const codeStr   = topError ? `TS${topError.code} (${category})` : category;

        const comment = `// [SS-HEALED] Removed: "${block.name}" — ${codeStr}: ${topError?.message.split('\n')[0] ?? 'unknown error'}`;
        healed = healed.slice(0, currentBlock.start) + comment + healed.slice(currentBlock.end);
        removedTests.push(block.name);
        removedTestReasons[block.name] = codeStr;
        emit(`Healer: removed "${block.name}" — ${codeStr}`);
        healedCount++;
      }
    }

    const { errorRanges: remainingErrors } = diagnose(
      healed, specFileName, sourceFilePath, compilerOptions
    );

    if (remainingErrors.length === 0) {
      emit(`Healer: spec is now clean ✓ (${healedCount} test(s) repaired)`);
    } else {
      emit(`Healer: ${remainingErrors.length} error(s) remain — likely in shared scope or imports`);
    }

    return {
      healed, removedTests, removedTestReasons,
      errorCount: diagnostics.length, wasHealed: healedCount > 0,
      healedCount, hasGlobalErrors,
    };

  } catch (err) {
    emit(`Healer: unexpected error — ${err instanceof Error ? err.message : String(err)} — spec unchanged`);
    return {
      healed: specContent, removedTests: [], removedTestReasons: {},
      errorCount: 0, wasHealed: false, healedCount: 0, hasGlobalErrors: false,
    };
  }
}