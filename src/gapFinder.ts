import * as vscode from 'vscode';
import { analyzeFile } from './astAnalyzer';
import { extractContext } from './contextExtractor';
import { buildPrompt } from './promptBuilder';
import { resolveSpecPath } from './fileWriter';
import { detectTestedFunctions } from './utils/testScanner';

function buildGapPrompt(
  filePath: string,
  gaps: string[],
  testedFunctions: string[],
  exportTypes: Record<string, 'default' | 'named'>,
  log: (msg: string) => void
): string {
  const result = analyzeFile(filePath, log);
  if (!result.isTestable) {
    throw new Error(`Gap Finder: not testable — ${result.skipReason}`);
  }

  const ctx = extractContext(
    filePath,
    gaps,
    result.imports,
    log,
    exportTypes 
  );

  const basePrompt = buildPrompt(ctx);

  const alreadyTestedNote = testedFunctions.length > 0
    ? [
      '## Already Tested — Do Not Regenerate',
      'These functions already have tests in the spec file.',
      'Do NOT generate tests for them under any circumstance:',
      ...testedFunctions.map(f => `- ${f}`),
      '',
      'Generate ONLY for the functions listed in ## Functions to Test above.',
    ].join('\n')
    : '';

  return alreadyTestedNote
    ? `${basePrompt}\n\n${alreadyTestedNote}`
    : basePrompt;
}

export async function runGapFinder(
  log: (msg: string) => void,
  onPromptReady: (
    prompt: string,
    filePath: string,
    log: (msg: string) => void,
    abortSignal: AbortSignal,
    isMerge: boolean,
    exportedFunctions: string[],                       
    exportTypes: Record<string, 'default' | 'named'>   
  ) => Promise<void>
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('SilentSpec: No active file open');
    return;
  }

  const filePath = editor.document.uri.fsPath;

  if (/\.(test|spec)\.[tj]sx?$/.test(filePath)) {
    vscode.window.showWarningMessage(
      'SilentSpec: Cannot run Gap Finder on a test file'
    );
    return;
  }

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: '$(sync~spin) SS: Finding test gaps...',
  }, async () => {
    log(`Gap Finder: analyzing ${filePath}`);

    const result = analyzeFile(filePath, log);
    if (!result.isTestable) {
      vscode.window.showInformationMessage(
        `SilentSpec: No testable functions — ${result.skipReason}`
      );
      return;
    }

    log(`Gap Finder: ${result.exportedFunctions.length} function(s) detected`);

    const specPath = await resolveSpecPath(filePath);
    let gaps = result.exportedFunctions;
    let testedFunctions: string[] = [];
    let isMerge = false;

    try {
      const specBytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(specPath)
      );
      const specContent = Buffer.from(specBytes).toString('utf8');

      testedFunctions = detectTestedFunctions(
        specContent,
        result.exportedFunctions
      );
      log(`Gap Finder: tested — [${testedFunctions.join(', ')}]`);

      gaps = result.exportedFunctions.filter(
        fn => !testedFunctions.includes(fn)
      );
      isMerge = true;

    } catch {
      log('Gap Finder: no spec found — full generation');
    }

    if (gaps.length === 0) {
      vscode.window.showInformationMessage(
        'SilentSpec: No gaps found — all exports have tests ✓'
      );
      return;
    }

    log(`Gap Finder: gaps — [${gaps.join(', ')}]`);

    const gapDisplay = gaps.length <= 3
      ? gaps.join(', ')
      : `${gaps.length} functions`;
    vscode.window.showInformationMessage(
      `SilentSpec: Generating tests for ${gapDisplay}...`
    );

    let prompt: string;
    try {
      prompt = buildGapPrompt(
        filePath,
        gaps,
        testedFunctions,
        result.exportTypes,   
        log
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Gap Finder: prompt build failed — ${msg}`);
      vscode.window.showWarningMessage(`SilentSpec: Gap Finder failed — ${msg}`);
      return;
    }

    const controller = new AbortController();
    await onPromptReady(
      prompt,
      filePath,
      log,
      controller.signal,
      isMerge,
      result.exportedFunctions,  
      result.exportTypes       
    );
  });
}