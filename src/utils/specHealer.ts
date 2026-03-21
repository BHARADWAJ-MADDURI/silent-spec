import * as ts from 'typescript';

export interface HealResult {
  healed: string;
  removedTests: string[];
  errorCount: number;
  wasHealed: boolean;
  healedCount: number;
  hasGlobalErrors: boolean;
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
}

/**
 * Checks if a call expression is it(), test(), it.only(), it.skip(), test.each(), etc.
 */
function isItOrTestCall(expr: ts.Expression): boolean {
  // Direct: it(...) or test(...)
  if (ts.isIdentifier(expr)) {
    return expr.text === 'it' || expr.text === 'test';
  }
  // Chained: it.only(...) or it.skip(...) or test.each(...)
  if (ts.isPropertyAccessExpression(expr)) {
    const base = expr.expression;
    return (
      ts.isIdentifier(base) &&
      (base.text === 'it' || base.text === 'test')
    );
  }
  // Tagged: test.each(...)(...) — CallExpression on a CallExpression
  if (ts.isCallExpression(expr)) {
    return isItOrTestCall(expr.expression);
  }
  return false;
}

/**
 * Extracts test name from first argument of it()/test() call.
 */
function extractTestName(node: ts.CallExpression, sourceFile: ts.SourceFile): string {
  const firstArg = node.arguments[0];
  if (!firstArg) { return 'unknown test'; }
  if (ts.isStringLiteral(firstArg)) { return firstArg.text; }
  if (ts.isNoSubstitutionTemplateLiteral(firstArg)) { return firstArg.text; }
  if (ts.isTemplateExpression(firstArg)) {
    return firstArg.head.text + '...'; // partial name for template literals
  }
  return firstArg.getText(sourceFile);
}

/**
 * Walk AST and find all it()/test() blocks including it.only, it.skip, test.each.
 */
function findItBlocks(sourceFile: ts.SourceFile): ItBlock[] {
  const blocks: ItBlock[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      isItOrTestCall(node.expression)
    ) {
      blocks.push({
        name: extractTestName(node, sourceFile),
        start: node.getStart(sourceFile),
        end: node.getEnd(),
      });
      // Don't recurse into it() — nested it() is unusual and would double-count
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return blocks;
}

/**
 * Build error ranges from diagnostics using start + length for accurate interval matching.
 */
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
    }));
}

/**
 * Check if an error range overlaps with a block range.
 * Uses proper interval overlap: range.start <= block.end && range.end >= block.start
 */
function errorOverlapsBlock(error: ErrorRange, block: ItBlock): boolean {
  return error.start <= block.end && error.end >= block.start;
}

/**
 * Attempt partial repair: comment out only the failing line(s) within the test body.
 * Falls back to full test removal if partial repair still leaves errors.
 */
function partialRepair(
  specContent: string,
  block: ItBlock,
  errors: ErrorRange[]
): string {
  const lines = specContent.split('\n');

  // Convert character positions to line numbers
  let charCount = 0;
  const lineStartPositions: number[] = [0];
  for (let i = 0; i < specContent.length; i++) {
    if (specContent[i] === '\n') {
      lineStartPositions.push(i + 1);
    }
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
  const blockEndLine = getLineNumber(block.end);

  // Find which lines within the block have errors
  const errorLineNumbers = new Set<number>();
  for (const error of errors) {
    if (errorOverlapsBlock(error, block)) {
      const errLine = getLineNumber(error.start);
      errorLineNumbers.add(errLine);
    }
  }

  // Comment out only the failing lines
  // Safety: if line contains braces, partial repair could break syntax — abort
  const repairedLines = [...lines];
  for (const lineNum of errorLineNumbers) {
    if (lineNum >= blockStartLine && lineNum <= blockEndLine) {
      const original = repairedLines[lineNum];
      if (original.includes('{') || original.includes('}')) {
        // Brace on failing line — partial repair would break syntax
        // Return original to trigger full test removal fallback
        return specContent;
      }
      repairedLines[lineNum] =
        `${original.match(/^(\s*)/)?.[1] ?? ''}// [SS-HEALED] type error: ${original.trim()}`;
    }
  }
  return repairedLines.join('\n');
}

/**
 * Build compiler program for a given source file content.
 */
function buildProgram(
  specContent: string,
  specFileName: string,
  sourceFilePath: string,
  compilerOptions: ts.CompilerOptions
): { program: ts.Program; sourceFile: ts.SourceFile } {
  const sourceFile = ts.createSourceFile(
    specFileName,
    specContent,
    ts.ScriptTarget.Latest,
    true // setParentNodes required for getStart()/getEnd()
  );

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName: string, languageVersion: ts.ScriptTarget) => {
    if (fileName === specFileName) { return sourceFile; }
    return originalGetSourceFile(fileName, languageVersion);
  };

  const program = ts.createProgram(
    [specFileName, sourceFilePath],
    compilerOptions,
    host
  );

  return { program, sourceFile };
}

/**
 * Main healer entry point.
 *
 * Strategy:
 * 1. Run TS diagnostics on generated spec in-memory
 * 2. Map errors to it()/test() blocks using AST character positions
 * 3. Attempt partial repair (comment failing lines) first
 * 4. If partial repair leaves errors, remove the whole it() block
 * 5. Verify healed content compiles cleanly
 * 6. Fail-open: return original if anything unexpected happens
 */
export function healSpec(
  specContent: string,
  specFileName: string,
  sourceFilePath: string,
  log?: (msg: string) => void
): HealResult {
  const emit = log ?? (() => {});

  const compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    allowJs: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
  };

  try {
    // ── Step 1: Initial compilation ──────────────────────────────────────────
    const { program, sourceFile } = buildProgram(
      specContent, specFileName, sourceFilePath, compilerOptions
    );

    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];

    if (diagnostics.length === 0) {
      return {
        healed: specContent,
        removedTests: [],
        errorCount: 0,
        wasHealed: false,
        healedCount: 0,
        hasGlobalErrors: false,
      };
    }

    emit(`Healer: ${diagnostics.length} diagnostic(s) found`);

    // ── Step 2: Build error ranges (start + length for proper interval match) ─
    const errorRanges = buildErrorRanges(diagnostics, sourceFile);

    // ── Step 3: Find all it()/test() blocks via AST ──────────────────────────
    const itBlocks = findItBlocks(sourceFile);

    // ── Step 4: Classify errors — inside it() vs global scope ────────────────
    const blocksWithErrors = itBlocks.filter(block =>
      errorRanges.some(err => errorOverlapsBlock(err, block))
    );

    const hasGlobalErrors = errorRanges.some(err =>
      !itBlocks.some(block => errorOverlapsBlock(err, block))
    );

    if (hasGlobalErrors) {
      emit(`Healer: errors found outside it() blocks — import or scope issue, returning original unchanged`);
      return {
        healed: specContent,
        removedTests: [],
        errorCount: diagnostics.length,
        wasHealed: false,
        healedCount: 0,
        hasGlobalErrors,
      };
    }

    if (blocksWithErrors.length === 0) {
      return {
        healed: specContent,
        removedTests: [],
        errorCount: diagnostics.length,
        wasHealed: false,
        healedCount: 0,
        hasGlobalErrors,
      };
    }

    // ── Step 5: Attempt partial repair first ─────────────────────────────────
    let healed = specContent;
    const removedTests: string[] = [];
    let healedCount = 0;

    // Sort bottom-up so character positions remain valid during repair
    const sortedBlocks = [...blocksWithErrors].sort((a, b) => b.start - a.start);

    for (const block of sortedBlocks) {
      const blockErrors = errorRanges.filter(err => errorOverlapsBlock(err, block));

      // Try partial repair: comment failing lines only
      const partiallyRepaired = partialRepair(healed, block, blockErrors);

      // Verify partial repair compiles
      const { program: partialProgram, sourceFile: partialFile } = buildProgram(
        partiallyRepaired, specFileName, sourceFilePath, compilerOptions
      );
      const partialDiags = [
        ...partialProgram.getSyntacticDiagnostics(partialFile),
        ...partialProgram.getSemanticDiagnostics(partialFile),
      ];

      // Check if block still has errors after partial repair
      const partialErrorRanges = buildErrorRanges(partialDiags, partialFile);
      const { sourceFile: partialSourceFile } = buildProgram(
        partiallyRepaired, specFileName, sourceFilePath, compilerOptions
      );
      const partialBlocks = findItBlocks(partialSourceFile);
      const blockStillHasErrors = partialBlocks.some(b =>
        b.name === block.name &&
        partialErrorRanges.some(err => errorOverlapsBlock(err, b))
      );

      if (!blockStillHasErrors) {
        // Partial repair worked — comment approach succeeded
        healed = partiallyRepaired;
        emit(`Healer: partially repaired "${block.name}" — commented failing assertion(s)`);
        healedCount++;
      } else {
        // Partial repair insufficient — remove entire it() block
        // Recalculate block position in current healed string
        const { sourceFile: currentFile } = buildProgram(
          healed, specFileName, sourceFilePath, compilerOptions
        );
        const currentBlocks = findItBlocks(currentFile);
        const currentBlock = currentBlocks.find(b => b.name === block.name);

        if (currentBlock) {
          const comment = `// [SS-HEALED] Removed: "${block.name}" — TypeScript errors could not be auto-repaired`;
          healed = healed.slice(0, currentBlock.start) + comment + healed.slice(currentBlock.end);
          removedTests.push(block.name);
          emit(`Healer: removed test "${block.name}" — partial repair insufficient`);
          healedCount++;
        }
      }
    }

    // ── Step 6: Final verification ────────────────────────────────────────────
    const { program: finalProgram, sourceFile: finalFile } = buildProgram(
      healed, specFileName, sourceFilePath, compilerOptions
    );
    const remainingDiags = [
      ...finalProgram.getSyntacticDiagnostics(finalFile),
      ...finalProgram.getSemanticDiagnostics(finalFile),
    ];

    if (remainingDiags.length === 0) {
      emit(`Healer: spec is now clean ✓ (${healedCount} test(s) repaired)`);
    } else {
      emit(`Healer: ${remainingDiags.length} error(s) remain — likely in shared scope or imports`);
    }

    return {
      healed,
      removedTests,
      errorCount: diagnostics.length,
      wasHealed: healedCount > 0,
      healedCount,
      hasGlobalErrors,
    };

  } catch (err) {
    emit(`Healer: unexpected error — ${err instanceof Error ? err.message : String(err)} — spec unchanged`);
    return {
      healed: specContent,
      removedTests: [],
      errorCount: 0,
      wasHealed: false,
      healedCount: 0,
      hasGlobalErrors: false,
    };
  }
}