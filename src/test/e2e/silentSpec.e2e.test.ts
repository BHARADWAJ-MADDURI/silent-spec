import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

interface FakeAiRequest {
  path: string;
  model?: string;
  prompt: string;
  functions: string[];
}

interface FakeAiServer {
  baseUrl: string;
  requests: FakeAiRequest[];
  close(): Promise<void>;
}

const TEST_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 100;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

function extractRequestedFunctions(prompt: string): string[] {
  const match = prompt.match(/## Functions to Test\n([\s\S]*?)(?:\n## |\n# |$)/);
  const section = match?.[1] ?? '';
  const functions = section
    .split('\n')
    .map(line => line.trim().match(/^-\s+([A-Za-z_$][\w$]*)/)?.[1])
    .filter((value): value is string => Boolean(value));

  return functions.length > 0 ? functions : ['add'];
}

function buildAiResponse(functions: string[]): string {
  const blocks = functions.map(fn => [
    `describe('${fn}', () => {`,
    `  it('is covered by the SilentSpec E2E fake provider', () => {`,
    `    expect(typeof ${fn}).toBe('function');`,
    '  });',
    '});',
  ].join('\n'));

  return [
    '// <SS-GENERATED-START>',
    blocks.join('\n\n'),
    '// <SS-GENERATED-END>',
  ].join('\n');
}

function buildProviderResponseFunctions(functions: string[]): string[] {
  if (functions.includes('overMissing')) {
    return ['overExisting', 'overMissing'];
  }
  return functions;
}

function countOccurrences(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

async function startFakeAiServer(): Promise<FakeAiServer> {
  const requests: FakeAiRequest[] = [];

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as {
          model?: string;
          messages?: Array<{ role?: string; content?: string }>;
        };
        const prompt = parsed.messages?.find(message => message.role === 'user')?.content ?? '';
        const functions = extractRequestedFunctions(prompt);
        const responseFunctions = buildProviderResponseFunctions(functions);
        requests.push({
          path: req.url ?? '',
          model: parsed.model,
          prompt,
          functions,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                content: buildAiResponse(responseFunctions),
              },
            },
          ],
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object', 'fake AI server did not bind to a TCP port');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

async function createFixtureWorkspace(workspaceRoot: string, name: string): Promise<string> {
  const root = path.join(
    workspaceRoot,
    'cases',
    `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  await writeText(path.join(root, 'package.json'), JSON.stringify({
    name: `silentspec-e2e-${name}`,
    private: true,
    devDependencies: {
      jest: '29.0.0',
      '@types/jest': '29.0.0',
      'ts-jest': '29.0.0',
    },
  }, null, 2));
  await writeText(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'CommonJS',
      types: ['jest'],
      strict: true,
      allowJs: true,
      jsx: 'react-jsx',
    },
    include: ['src/**/*'],
  }, null, 2));

  await fs.mkdir(path.join(root, 'node_modules', 'jest'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', '@types', 'jest'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'ts-jest'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });

  return root;
}

async function configureSilentSpec(server: FakeAiServer): Promise<void> {
  const config = vscode.workspace.getConfiguration('silentspec');
  await config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
  await config.update('provider', 'vllm', vscode.ConfigurationTarget.Workspace);
  await config.update('vllm.baseUrl', server.baseUrl, vscode.ConfigurationTarget.Workspace);
  await config.update('vllm.model', 'silent-spec-e2e-model', vscode.ConfigurationTarget.Workspace);
  await config.update('openSpecOnCreate', false, vscode.ConfigurationTarget.Workspace);
  await config.update('aiTimeoutSeconds', 5, vscode.ConfigurationTarget.Workspace);
  await config.update('maxFunctionsPerRun', 10, vscode.ConfigurationTarget.Workspace);
}

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.all.find(candidate =>
    candidate.id === 'bharadwajmadduri.silent-spec' ||
    candidate.id.endsWith('.silent-spec')
  );
  assert.ok(extension, 'SilentSpec extension was not installed in the extension host');
  await extension.activate();
}

async function saveSourceAndWaitForSpec(sourcePath: string, specPath: string): Promise<string> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  const editor = await vscode.window.showTextDocument(document);
  await editor.edit(editBuilder => {
    const end = document.lineAt(document.lineCount - 1).range.end;
    editBuilder.insert(end, '\n');
  });
  await document.save();

  await waitFor(async () => {
    if (!await pathExists(specPath)) {
      return false;
    }
    const content = await readText(specPath);
    return content.includes('// @auto-generated by SilentSpec') &&
      content.includes('// <SS-GENERATED-START') &&
      content.includes('// <SS-GENERATED-END>');
  }, `spec generation at ${specPath}`);

  return readText(specPath);
}

async function replaceDocumentContent(filePath: string, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(document);
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  await editor.edit(editBuilder => {
    editBuilder.replace(fullRange, content);
  });
  await document.save();
}

async function replaceSourceAndWaitForSpec(
  sourcePath: string,
  content: string,
  specPath: string,
  expectedSubstring?: string
): Promise<string> {
  await replaceDocumentContent(sourcePath, content);

  await waitFor(async () => {
    if (!await pathExists(specPath)) {
      return false;
    }
    const spec = await readText(specPath);
    return spec.includes('// @auto-generated by SilentSpec') &&
      spec.includes('// <SS-GENERATED-START') &&
      spec.includes('// <SS-GENERATED-END>') &&
      (!expectedSubstring || spec.includes(expectedSubstring));
  }, `spec regeneration at ${specPath}`);

  return readText(specPath);
}

async function executeGapFinder(sourcePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('silentspec.findGaps');
  await new Promise(resolve => setTimeout(resolve, 500));
}

suite('SilentSpec extension E2E', function () {
  this.timeout(TEST_TIMEOUT_MS);

  let server: FakeAiServer;
  let fixtureRoot: string;
  let tempRoots: string[] = [];

  suiteSetup(async () => {
    server = await startFakeAiServer();
  });

  setup(async function () {
    server.requests.length = 0;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(workspaceRoot, 'VS Code test runner did not open the configured workspace folder');
    fixtureRoot = await createFixtureWorkspace(
      workspaceRoot,
      this.currentTest?.title.replace(/\W+/g, '-').toLowerCase() ?? 'case'
    );
    tempRoots.push(fixtureRoot);
    await configureSilentSpec(server);
    await activateExtension();
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  suiteTeardown(async () => {
    await server.close();
    await Promise.all(tempRoots.map(root => fs.rm(root, { recursive: true, force: true })));
    tempRoots = [];
  });

  test('creates a managed adjacent spec on source save through the fake vLLM provider', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'calculator.ts');
    const specPath = path.join(root, 'src', 'calculator.spec.ts');

    await writeText(sourcePath, [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
    ].join('\n'));

    const spec = await saveSourceAndWaitForSpec(sourcePath, specPath);

    assert.strictEqual(server.requests.length, 1, 'expected exactly one fake provider call');
    assert.deepStrictEqual(server.requests[0].functions, ['add']);
    assert.ok(spec.includes("import { add } from './calculator';"), 'generated spec should import the source function');
    assert.ok(spec.includes("describe('add'"), 'generated spec should include add coverage');
    assert.ok(spec.includes('covered: add'), 'marker should record add as covered');
  });

  test('creates a sister file beside an unmanaged adjacent spec and leaves the handwritten spec untouched', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'money.ts');
    const handwrittenPath = path.join(root, 'src', 'money.spec.ts');
    const sisterPath = path.join(root, 'src', 'money.silentspec.spec.ts');
    const handwritten = [
      "import { toCents } from './money';",
      '',
      "describe('handwritten toCents behavior', () => {",
      "  it('is intentionally preserved', () => {",
      '    expect(toCents(1)).toBe(100);',
      '  });',
      '});',
    ].join('\n');

    await writeText(sourcePath, [
      'export function toCents(value: number): number {',
      '  return Math.round(value * 100);',
      '}',
    ].join('\n'));
    await writeText(handwrittenPath, handwritten);

    const spec = await saveSourceAndWaitForSpec(sourcePath, sisterPath);

    assert.strictEqual(await readText(handwrittenPath), handwritten, 'handwritten spec must remain byte-for-byte unchanged');
    assert.ok(spec.includes('// Companion to: money.spec.ts (hand-written - never modified by SilentSpec)'));
    assert.ok(spec.includes("describe('toCents'"));
    assert.strictEqual(await pathExists(path.join(root, 'src', 'money.silentspec.silentspec.spec.ts')), false);
  });

  test('reuses an existing managed sister file instead of creating a double-sister filename', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'pricing.ts');
    const handwrittenPath = path.join(root, 'src', 'pricing.spec.ts');
    const sisterPath = path.join(root, 'src', 'pricing.silentspec.spec.ts');

    await writeText(sourcePath, [
      'export function subtotal(value: number): number {',
      '  return value;',
      '}',
    ].join('\n'));
    await writeText(handwrittenPath, "describe('handwritten pricing', () => { it('stays', () => {}); });\n");
    await saveSourceAndWaitForSpec(sourcePath, sisterPath);

    const spec = await replaceSourceAndWaitForSpec(sourcePath, [
      'export function subtotal(value: number): number {',
      '  return value;',
      '}',
      'export function discount(value: number): number {',
      '  return value * 0.9;',
      '}',
    ].join('\n'), sisterPath, "describe('discount'");

    assert.ok(spec.includes("describe('subtotal'"));
    assert.ok(spec.includes("describe('discount'"));
    assert.strictEqual(await pathExists(path.join(root, 'src', 'pricing.silentspec.silentspec.spec.ts')), false);
  });

  test('places a sister file next to an unmanaged spec inside __tests__', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'greeting.ts');
    const testDir = path.join(root, 'src', '__tests__');
    const handwrittenPath = path.join(testDir, 'greeting.spec.ts');
    const sisterPath = path.join(testDir, 'greeting.silentspec.spec.ts');

    await writeText(sourcePath, [
      'export function greet(name: string): string {',
      "  return `hello ${name}`;",
      '}',
    ].join('\n'));
    await writeText(handwrittenPath, "describe('handwritten greeting', () => { it('stays', () => {}); });\n");

    const spec = await saveSourceAndWaitForSpec(sourcePath, sisterPath);

    assert.ok(spec.includes('// Companion to: greeting.spec.ts (hand-written - never modified by SilentSpec)'));
    assert.ok(spec.includes("describe('greet'"));
    assert.strictEqual(await pathExists(path.join(root, 'src', 'greeting.silentspec.spec.ts')), false, 'sister should not be misplaced beside source');
  });

  test('findGaps on an unmanaged spec without a sister does not call the provider or write files', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'manualOnly.ts');
    const handwrittenPath = path.join(root, 'src', 'manualOnly.spec.ts');
    const sisterPath = path.join(root, 'src', 'manualOnly.silentspec.spec.ts');

    await writeText(sourcePath, [
      'export function manualOnly(): string {',
      "  return 'manual';",
      '}',
    ].join('\n'));
    await writeText(handwrittenPath, "describe('manual only', () => { it('stays', () => {}); });\n");

    await executeGapFinder(sourcePath);

    assert.strictEqual(server.requests.length, 0, 'gap finder should not call AI before a managed sister exists');
    assert.strictEqual(await pathExists(sisterPath), false, 'gap finder should not create a sister file by itself');
    assert.strictEqual(
      await readText(handwrittenPath),
      "describe('manual only', () => { it('stays', () => {}); });\n",
      'handwritten spec should remain untouched'
    );
  });

  test('findGaps uses an existing managed sister and appends coverage for newly added exports', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'coverage.ts');
    const handwrittenPath = path.join(root, 'src', 'coverage.spec.ts');
    const sisterPath = path.join(root, 'src', 'coverage.silentspec.spec.ts');

    await writeText(sourcePath, [
      'export function first(): string {',
      "  return 'first';",
      '}',
    ].join('\n'));
    await writeText(handwrittenPath, "describe('human coverage', () => { it('stays', () => {}); });\n");
    await saveSourceAndWaitForSpec(sourcePath, sisterPath);
    server.requests.length = 0;

    const config = vscode.workspace.getConfiguration('silentspec');
    await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
    await replaceDocumentContent(sourcePath, [
      'export function first(): string {',
      "  return 'first';",
      '}',
      'export function second(): string {',
      "  return 'second';",
      '}',
    ].join('\n'));
    await new Promise(resolve => setTimeout(resolve, 2500));
    await config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
    await executeGapFinder(sourcePath);

    await waitFor(async () => {
      const spec = await readText(sisterPath);
      return spec.includes("describe('first'") &&
        spec.includes("describe('second'") &&
        spec.includes('covered: first, second');
    }, 'gap finder to append second coverage to existing sister');

    assert.strictEqual(server.requests.length, 1, 'gap finder should make one provider call for the new export');
    assert.deepStrictEqual(server.requests[0].functions, ['second']);
    assert.strictEqual(await pathExists(path.join(root, 'src', 'coverage.silentspec.silentspec.spec.ts')), false);
  });

  test('findGaps repairs a manually deleted generated describe block even when the marker is stale', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'staleMarker.ts');
    const specPath = path.join(root, 'src', 'staleMarker.spec.ts');

    await writeText(sourcePath, [
      'export function keep(): string {',
      "  return 'keep';",
      '}',
      'export function repairMe(): string {',
      "  return 'repair';",
      '}',
    ].join('\n'));

    const generated = await saveSourceAndWaitForSpec(sourcePath, specPath);
    assert.ok(generated.includes("describe('keep'"));
    assert.ok(generated.includes("describe('repairMe'"));
    assert.ok(/covered="[^"]*\brepairMe\b[^"]*"/.test(generated));

    const manuallyEdited = generated.replace(
      /\ndescribe\('repairMe'[\s\S]*?\n}\);\n?/,
      '\n'
    );
    assert.ok(!manuallyEdited.includes("describe('repairMe'"));
    assert.ok(/covered="[^"]*\brepairMe\b[^"]*"/.test(manuallyEdited), 'test setup should leave the stale marker behind');
    await writeText(specPath, manuallyEdited);
    server.requests.length = 0;

    await executeGapFinder(sourcePath);

    await waitFor(async () => {
      const repaired = await readText(specPath);
      return repaired.includes("describe('keep'") &&
        repaired.includes("describe('repairMe'") &&
        /covered="[^"]*\brepairMe\b[^"]*"/.test(repaired);
    }, 'gap finder to repair manually deleted describe block');

    assert.strictEqual(
      server.requests.length,
      1,
      `gap finder should call AI once for the missing describe block; requests=${JSON.stringify(server.requests.map(request => request.functions))}`
    );
    assert.deepStrictEqual(server.requests[0].functions, ['repairMe']);
  });

  test('save repairs marker and imports when describe coverage still exists', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'metadataRepair.ts');
    const specPath = path.join(root, 'src', 'metadataRepair.spec.ts');

    await writeText(sourcePath, [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      'export function subtract(a: number, b: number): number {',
      '  return a - b;',
      '}',
    ].join('\n'));

    const generated = await saveSourceAndWaitForSpec(sourcePath, specPath);
    assert.ok(generated.includes("describe('add'"));
    assert.ok(generated.includes("describe('subtract'"));

    const drifted = generated
      .replace(/import \{ add, subtract \} from '\.\/metadataRepair';/, "import { subtract } from './metadataRepair';")
      .replace(/covered="add,subtract"/, 'covered="subtract"')
      .replace('// Functions covered: add, subtract', '// Functions covered: subtract');
    assert.ok(drifted.includes("describe('add'"), 'test setup should keep add describe coverage');
    assert.ok(!/import \{ add, subtract \}/.test(drifted), 'test setup should remove add import');
    assert.ok(!/covered="add,subtract"/.test(drifted), 'test setup should remove add marker coverage');
    await writeText(specPath, drifted);
    server.requests.length = 0;

    await replaceDocumentContent(sourcePath, [
      await readText(sourcePath),
      '',
      '// save-only edit to trigger metadata repair',
    ].join('\n'));

    await waitFor(async () => {
      const repaired = await readText(specPath);
      return repaired.includes("import { add, subtract } from './metadataRepair';") &&
        repaired.includes('covered="add,subtract"') &&
        repaired.includes('// Functions covered: add, subtract');
    }, 'save handler to repair marker/header/import drift without AI');

    assert.strictEqual(server.requests.length, 0, 'metadata repair should not call the provider');
  });

  test('save prunes generated tests and imports for removed exports without touching user tests', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'removedExport.ts');
    const specPath = path.join(root, 'src', 'removedExport.spec.ts');
    const userTest = [
      "describe('human-owned removedExport behavior', () => {",
      "  it('must stay in SS-USER-TESTS', () => {",
      "    expect('human').toBe('human');",
      '  });',
      '});',
    ].join('\n');

    await writeText(sourcePath, [
      'export function keep(): string {',
      "  return 'keep';",
      '}',
      'export function removeMe(): string {',
      "  return 'remove';",
      '}',
    ].join('\n'));

    const generated = await saveSourceAndWaitForSpec(sourcePath, specPath);
    const withUserTest = generated.replace(
      '// Add your own tests here — SilentSpec will never modify this section',
      userTest
    );
    await writeText(specPath, withUserTest);
    server.requests.length = 0;

    await replaceDocumentContent(sourcePath, [
      'export function keep(): string {',
      "  return 'keep';",
      '}',
      '',
      '// save-only edit after removeMe was removed',
    ].join('\n'));

    await waitFor(async () => {
      const repaired = await readText(specPath);
      return repaired.includes("describe('keep'") &&
        !repaired.includes("describe('removeMe'") &&
        repaired.includes("import { keep } from './removedExport';") &&
        repaired.includes('covered="keep"') &&
        repaired.includes('// Functions covered: keep') &&
        repaired.includes(userTest);
    }, 'save handler to prune stale generated coverage for a removed export');

    assert.strictEqual(server.requests.length, 0, 'removing an already-covered export should not call the provider');
  });

  test('save treats a renamed export as prune old coverage plus generate new coverage', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'renamedExport.ts');
    const specPath = path.join(root, 'src', 'renamedExport.spec.ts');

    await writeText(sourcePath, [
      'export function oldName(): string {',
      "  return 'old';",
      '}',
    ].join('\n'));

    const generated = await saveSourceAndWaitForSpec(sourcePath, specPath);
    assert.ok(generated.includes("describe('oldName'"));
    server.requests.length = 0;

    await replaceDocumentContent(sourcePath, [
      'export function newName(): string {',
      "  return 'new';",
      '}',
    ].join('\n'));

    try {
      await waitFor(async () => {
        const repaired = await readText(specPath);
        return !repaired.includes("describe('oldName'") &&
          repaired.includes("describe('newName'") &&
          repaired.includes("import { newName } from './renamedExport';") &&
          repaired.includes('covered="newName"') &&
          repaired.includes('// Functions covered: newName');
      }, 'save handler to prune renamed coverage and generate new coverage');
    } catch (error) {
      const spec = await readText(specPath);
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `requests=${JSON.stringify(server.requests.map(request => request.functions))}`,
        `marker=${spec.match(/\/\/ <SS-GENERATED-START[^\n]*/)?.[0] ?? 'missing'}`,
        `import=${spec.split('\n').find(line => line.includes("from './renamedExport';")) ?? 'missing'}`,
        `hasOld=${spec.includes("describe('oldName'")}`,
        `hasNew=${spec.includes("describe('newName'")}`,
        spec,
      ].join('\n'));
    }

    assert.deepStrictEqual(
      server.requests.map(request => request.functions),
      [['newName']],
      'rename should call provider only for the new export'
    );
  });

  test('findGaps filters provider over-generation and remains stable across subsequent saves', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'overGenerate.ts');
    const specPath = path.join(root, 'src', 'overGenerate.spec.ts');

    await writeText(sourcePath, [
      'export function overExisting(): string {',
      "  return 'existing';",
      '}',
    ].join('\n'));

    const generated = await saveSourceAndWaitForSpec(sourcePath, specPath);
    assert.strictEqual(countOccurrences(generated, "describe('overExisting'"), 1);
    assert.strictEqual(countOccurrences(generated, "describe('overMissing'"), 0);

    const config = vscode.workspace.getConfiguration('silentspec');
    await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
    await replaceDocumentContent(sourcePath, [
      'export function overExisting(): string {',
      "  return 'existing';",
      '}',
      'export function overMissing(): string {',
      "  return 'missing';",
      '}',
    ].join('\n'));
    await new Promise(resolve => setTimeout(resolve, 2500));
    await config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
    server.requests.length = 0;

    await executeGapFinder(sourcePath);

    await waitFor(async () => {
      const spec = await readText(specPath);
      return countOccurrences(spec, "describe('overExisting'") === 1 &&
        countOccurrences(spec, "describe('overMissing'") === 1 &&
        /covered="[^"]*\boverExisting\b[^"]*"/.test(spec) &&
        /covered="[^"]*\boverMissing\b[^"]*"/.test(spec);
    }, 'gap finder to append only the missing function from an over-generated provider response');

    assert.strictEqual(server.requests.length, 1, 'gap finder should call the provider only once');
    assert.deepStrictEqual(server.requests[0].functions, ['overMissing']);

    await replaceDocumentContent(sourcePath, [
      'export function overExisting(): string {',
      "  return 'existing';",
      '}',
      'export function overMissing(): string {',
      "  return 'missing';",
      '}',
      '',
      '// save-only edit after coverage is complete',
    ].join('\n'));

    await new Promise(resolve => setTimeout(resolve, 3500));
    const afterSave = await readText(specPath);

    assert.strictEqual(server.requests.length, 1, 'subsequent saves should not call the provider after all functions are covered');
    assert.strictEqual(countOccurrences(afterSave, "describe('overExisting'"), 1);
    assert.strictEqual(countOccurrences(afterSave, "describe('overMissing'"), 1);
  });

  test('findGaps completes a 10-function partial spec in capped batches without duplicating coverage', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'manyFunctions.ts');
    const specPath = path.join(root, 'src', 'manyFunctions.test.ts');
    const readGeneratedSpec = (): Promise<string> => readText(specPath);
    const functionNames = Array.from({ length: 10 }, (_, index) => `fn${index + 1}`);

    await vscode.workspace
      .getConfiguration('silentspec')
      .update('maxFunctionsPerRun', 3, vscode.ConfigurationTarget.Workspace);

    await writeText(sourcePath, functionNames.map((fn, index) => [
      `export function ${fn}(): number {`,
      `  return ${index + 1};`,
      '}',
    ].join('\n')).join('\n\n'));
    const partialSpec = [
      '// @auto-generated by SilentSpec | 2026-04-12',
      '// Source: src/manyFunctions.ts',
      '// Functions covered: fn1, fn2, fn3',
      '',
      '// <SS-IMPORTS-START>',
      "import { fn1, fn2, fn3 } from './manyFunctions';",
      '// <SS-IMPORTS-END>',
      '',
      '// <SS-HELPERS-START>',
      '',
      '// <SS-HELPERS-END>',
      '',
      '// <SS-USER-TESTS>',
      '// Add your own tests here - SilentSpec will never modify this section',
      '// </SS-USER-TESTS>',
      '',
      '// <SS-GENERATED-START v="1" covered="fn1,fn2,fn3">',
      ...['fn1', 'fn2', 'fn3'].map(fn => [
        `describe('${fn}', () => {`,
        "  it('keeps initial capped coverage', () => {",
        `    expect(${fn}()).toBeGreaterThan(0);`,
        '  });',
        '});',
      ].join('\n')),
      '// <SS-GENERATED-END>',
      '',
    ].join('\n');
    await writeText(specPath, partialSpec);

    server.requests.length = 0;

    await executeGapFinder(sourcePath);

    try {
      await waitFor(async () => {
        const spec = await readGeneratedSpec();
        return functionNames.every(fn => countOccurrences(spec, `describe('${fn}'`) === 1) &&
          functionNames.every(fn => new RegExp(`covered="[^"]*\\b${fn}\\b[^"]*"`).test(spec));
      }, 'gap finder to complete 10 functions across capped batches', 25_000);
    } catch (error) {
      let spec = '';
      try {
        spec = await readGeneratedSpec();
      } catch {
        spec = '';
      }
      throw new Error([
        error instanceof Error ? error.message : String(error),
        `requests=${JSON.stringify(server.requests.map(request => request.functions))}`,
        `counts=${JSON.stringify(Object.fromEntries(functionNames.map(fn => [fn, countOccurrences(spec, `describe('${fn}'`)])))}`,
        `marker=${spec.match(/\/\/ <SS-GENERATED-START[^\n]*/)?.[0] ?? 'missing'}`,
      ].join('\n'));
    }

    assert.deepStrictEqual(
      server.requests.map(request => request.functions),
      [
        ['fn4', 'fn5', 'fn6'],
        ['fn7', 'fn8', 'fn9'],
        ['fn10'],
      ]
    );

    await replaceDocumentContent(sourcePath, [
      await readText(sourcePath),
      '',
      '// save-only edit after capped gap fill is complete',
    ].join('\n'));

    await new Promise(resolve => setTimeout(resolve, 3500));
    const afterSave = await readGeneratedSpec();

    assert.strictEqual(server.requests.length, 3, 'subsequent saves should not call the provider after capped gap fill completes');
    for (const fn of functionNames) {
      assert.strictEqual(countOccurrences(afterSave, `describe('${fn}'`), 1, `${fn} should appear exactly once`);
    }
  });

  test('generates JavaScript specs with .spec.js naming and named imports', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'slugify.js');
    const specPath = path.join(root, 'src', 'slugify.spec.js');

    await writeText(sourcePath, [
      'export function slugify(value) {',
      "  return String(value).trim().toLowerCase().replace(/\\s+/g, '-');",
      '}',
    ].join('\n'));

    const spec = await saveSourceAndWaitForSpec(sourcePath, specPath);

    assert.strictEqual(server.requests.length, 1);
    assert.deepStrictEqual(server.requests[0].functions, ['slugify']);
    assert.ok(spec.includes("import { slugify } from './slugify';"));
    assert.ok(spec.includes("describe('slugify'"));
    assert.strictEqual(await pathExists(path.join(root, 'src', 'slugify.spec.ts')), false);
  });

  test('generates TSX specs with .spec.tsx naming', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'Label.tsx');
    const specPath = path.join(root, 'src', 'Label.spec.tsx');

    await writeText(sourcePath, [
      'export function Label(): string {',
      "  return 'label';",
      '}',
    ].join('\n'));

    const spec = await saveSourceAndWaitForSpec(sourcePath, specPath);

    assert.strictEqual(server.requests.length, 1);
    assert.deepStrictEqual(server.requests[0].functions, ['Label']);
    assert.ok(spec.includes("import { Label } from './Label';"));
    assert.ok(spec.includes("describe('Label'"));
    assert.strictEqual(await pathExists(path.join(root, 'src', 'Label.spec.ts')), false);
  });

  test('corrects imports for anonymous default exports', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'formatter.ts');
    const specPath = path.join(root, 'src', 'formatter.spec.ts');

    await writeText(sourcePath, [
      'export default function (value: string): string {',
      '  return value.trim();',
      '}',
    ].join('\n'));

    const spec = await saveSourceAndWaitForSpec(sourcePath, specPath);

    assert.ok(server.requests.length >= 1, 'expected at least one provider call');
    assert.ok(
      server.requests.every(request => request.functions.length === 1 && request.functions[0] === 'formatter'),
      `unexpected provider requests: ${JSON.stringify(server.requests.map(request => request.functions))}`
    );
    assert.ok(spec.includes("import formatter from './formatter';"));
    assert.ok(spec.includes("describe('formatter'"));
  });

  test('preserves SS-USER-TESTS content when regenerating managed TS specs', async () => {
    const root = fixtureRoot;
    const sourcePath = path.join(root, 'src', 'preserve.ts');
    const specPath = path.join(root, 'src', 'preserve.spec.ts');
    const userTest = [
      "describe('human-owned preserve behavior', () => {",
      "  it('is never overwritten', () => {",
      "    expect('human').toBe('human');",
      '  });',
      '});',
    ].join('\n');

    await writeText(sourcePath, [
      'export function alpha(): string {',
      "  return 'alpha';",
      '}',
    ].join('\n'));
    const firstSpec = await saveSourceAndWaitForSpec(sourcePath, specPath);
    const withUserTest = firstSpec.replace(
      '// Add your own tests here — SilentSpec will never modify this section',
      userTest
    );
    await writeText(specPath, withUserTest);

    const regenerated = await replaceSourceAndWaitForSpec(sourcePath, [
      'export function alpha(): string {',
      "  return 'alpha';",
      '}',
      'export function beta(): string {',
      "  return 'beta';",
      '}',
    ].join('\n'), specPath, "describe('beta'");

    assert.ok(regenerated.includes(userTest), 'manual SS-USER-TESTS content should survive regeneration');
    assert.ok(regenerated.includes("describe('alpha'"));
    assert.ok(regenerated.includes("describe('beta'"));
    assert.ok(/covered="[^"]*\balpha\b[^"]*"/.test(regenerated));
    assert.ok(/covered="[^"]*\bbeta\b[^"]*"/.test(regenerated));
  });
});
