import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { builtinModules } from 'module';
import { ImportInfo } from './astAnalyzer';
import { collectDependencyContext, DependencyContext } from './dependencyResolver';

export type TestFramework = 'jest' | 'vitest' | 'mocha' | 'jasmine';

export interface SilentSpecContext {
  fileContent: string;
  filePath: string;
  exportedFunctions: string[];    // ALL exports — used for import statement generation
  workList?: string[];            // Current batch to generate tests for (≤ maxFunctionsPerRun)
  exportTypes: Record<string, 'default' | 'named'>;
  framework: TestFramework;
  testPatternSample: string | null;
  mockHints: MockHint[];
  isFrontend: boolean;
  isNestJS: boolean;
  isNextJS: boolean;
  isGraphQL: boolean;
  isPrisma: boolean;
  specPath?: string;
  dependencyContext: DependencyContext[];
  internalTypes: string[];
  healerMode?: 'full' | 'safe';  // set by preflight check; 'safe' disables test removal
  typesWarning?: boolean;         // pre-flight detected missing @types package
  preflightProjectRoot?: string | null; // project root where types are missing
  installAttempted?: boolean;       // true when auto-install was attempted this session
  tsconfigTypesWarning?: boolean;   // @types installed but absent from tsconfig types array
}

export interface MockHint {
  source: string;
  mockStrategy: string;
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? null;
}

// Walk up from the source file's directory to find the nearest package.json
// that declares a known test framework. Stops at filesystem root.
//
// Why walk from the file and not the workspace root:
// In monorepos (e.g. bulletproof-react), the workspace root package.json
// may have no test framework while a nested app package.json has vitest.
// Walking from the source file finds the most specific package.json first.
//
// Continues past package.json files with no known framework — does NOT
// stop at the first package.json found, only at one that declares a framework.
export function detectFramework(filePath: string, workspaceRoot: string): TestFramework {
  let dir = path.dirname(filePath);
  const fsRoot = path.parse(dir).root;

  while (dir !== fsRoot) {
    const pkgPath = path.join(dir, 'package.json');

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps['vitest'])                                          { return 'vitest'; }
        if (deps['mocha'])                                           { return 'mocha'; }
        if (deps['jasmine'])                                         { return 'jasmine'; }
        if (deps['jest'] || deps['ts-jest'] || deps['babel-jest'])   { return 'jest'; }

        // This package.json has no known test framework —
        // keep walking up in case a parent package.json does.
      } catch {
        // Malformed package.json — keep walking up
      }
    }

    // Stop walking if we've reached or passed the workspace root
    if (dir === workspaceRoot) { break; }

    const parent = path.dirname(dir);
    if (parent === dir) { break; } // filesystem root guard
    dir = parent;
  }

  // No framework found in any package.json — default to jest
  return 'jest';
}

export function findNearestTestFile(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) { return null; }

  while (dir.startsWith(workspaceRoot)) {
    try {
      const entries = fs.readdirSync(dir);
      const testFile = entries.find(f => /\.(test|spec)\.[tj]sx?$/.test(f));
      if (testFile) { return path.join(dir, testFile); }

      const testDirs = ['__tests__', 'tests', 'test'];
      for (const testDir of testDirs) {
        const testDirPath = path.join(dir, testDir);
        if (fs.existsSync(testDirPath)) {
          try {
            const dirEntries = fs.readdirSync(testDirPath);
            const dirTestFile = dirEntries.find(f => /\.[tj]sx?$/.test(f));
            if (dirTestFile) { return path.join(testDirPath, dirTestFile); }
          } catch { /* skip unreadable test directory */ }
        }
      }
    } catch { /* skip unreadable directories */ }

    const parent = path.dirname(dir);
    if (parent === dir) { break; }
    dir = parent;
  }
  return null;
}

export function extractTestPattern(testFilePath: string): string | null {
  try {
    const content = fs.readFileSync(testFilePath, 'utf8');
    return content.split('\n').slice(0, 30).join('\n');
  } catch {
    return null;
  }
}

export function buildMockHints(
  imports: ImportInfo[],
  framework: TestFramework
): MockHint[] {
  const mockFn = framework === 'vitest'
    ? 'vi.mock'
    : (framework === 'mocha' || framework === 'jasmine')
      ? null  // mocha/jasmine have no standard mock function — use sinon or proxyquire
      : 'jest.mock';

  // For mocha/jasmine, skip module-level mock hints entirely.
  // These frameworks use sinon stubs/spies or proxyquire — not vi.mock/jest.mock.
  // The AI will infer the correct mocking approach from the test pattern sample.
  if (!mockFn) {
    return imports
      .filter(imp => !imp.isLocal)
      .map(imp => ({
        source: imp.source,
        mockStrategy: `// ${imp.source} — use sinon.stub() or proxyquire for mocha/jasmine mocking`,
      }));
  }

  return imports.map(imp => {
    const { source, isLocal } = imp;

    if (isLocal) {
      return { source, mockStrategy: `${mockFn}('${source}')` };
    }

    const isAlias = source.startsWith('@/') || source.startsWith('~/');
    if (isAlias) {
      return { source, mockStrategy: `${mockFn}('${source}')` };
    }

    if (builtinModules.includes(source) || builtinModules.includes(source.replace('node:', ''))) {
      return { source, mockStrategy: `${mockFn}('${source}') // mock Node built-in` };
    }

    if (source === '@prisma/client' || source.includes('prisma')) {
      return { source, mockStrategy: `${mockFn}('${source}') // mock Prisma at DB boundary` };
    }

    if (['axios', 'node-fetch', 'got', 'superagent', 'cross-fetch', 'ky'].includes(source)) {
      return { source, mockStrategy: `${mockFn}('${source}') // mock HTTP client at network boundary` };
    }

    if ([
      'graphql', '@apollo/client', '@apollo/server',
      'graphql-request', 'urql', 'relay-runtime', 'type-graphql'
    ].includes(source)) {
      return { source, mockStrategy: `${mockFn}('${source}') // mock GraphQL client at network boundary` };
    }

    if (source.startsWith('@nestjs/')) {
      return { source, mockStrategy: `${mockFn}('${source}') // mock NestJS module — or use Test.createTestingModule()` };
    }

    if (source === 'next' || source.startsWith('next/')) {
      return { source, mockStrategy: `${mockFn}('${source}') // mock Next.js module at boundary` };
    }

    if (source === 'react' || source === 'react-dom' ||
      source.startsWith('react/') || source.startsWith('react-dom/')) {
      return { source, mockStrategy: `// React — use React Testing Library (@testing-library/react), do not mock React directly` };
    }

    return {
      source,
      mockStrategy: `// ${source} — mock if it makes external calls or has side effects`
    };
  });
}

function detectProjectType(
  filePath: string,
  imports: ImportInfo[]
): {
  isFrontend: boolean;
  isNestJS: boolean;
  isNextJS: boolean;
  isGraphQL: boolean;
  isPrisma: boolean;
} {
  const ext = path.extname(filePath);

  const frontendExts = ['.tsx', '.jsx', '.vue', '.svelte'];
  const frontendImports = [
    'react', '@angular/core', 'vue', 'svelte',
    'solid-js', '@builder.io/qwik', 'lit'
  ];
  const isFrontend = frontendExts.includes(ext) ||
    imports.some(i => frontendImports.includes(i.source));

  const isNestJS  = imports.some(i => i.source.startsWith('@nestjs/'));
  const isNextJS  = imports.some(i => i.source === 'next' || i.source.startsWith('next/'));

  const graphqlPackages = [
    'graphql', '@apollo/client', '@apollo/server',
    'graphql-request', 'urql', 'relay-runtime', 'type-graphql'
  ];
  const isGraphQL = imports.some(i => graphqlPackages.includes(i.source));
  const isPrisma  = imports.some(i =>
    i.source === '@prisma/client' || i.source.includes('prisma')
  );

  return { isFrontend, isNestJS, isNextJS, isGraphQL, isPrisma };
}

export function extractContext(
  filePath: string,
  exportedFunctions: string[],
  imports: ImportInfo[],
  log: (msg: string) => void,
  exportTypes: Record<string, 'default' | 'named'> = {}
): SilentSpecContext {

  const workspaceRoot = getWorkspaceRoot() ?? path.dirname(filePath);
  const fileContent = fs.readFileSync(filePath, 'utf8');

  // Walk up from source file to find nearest package.json with a test framework.
  // Passes workspaceRoot as upper bound to avoid scanning outside the project.
  const framework = detectFramework(filePath, workspaceRoot);
  if (framework === 'jest') {
    // Log whether this was a definitive jest detection or a fallback
    log(`Framework detected: jest`);
  } else {
    log(`Framework detected: ${framework}`);
  }

  const { isFrontend, isNestJS, isNextJS, isGraphQL, isPrisma } =
    detectProjectType(filePath, imports);

  const projectFlags = [
    isFrontend && 'frontend',
    isNestJS   && 'nestjs',
    isNextJS   && 'nextjs',
    isGraphQL  && 'graphql',
    isPrisma   && 'prisma',
  ].filter(Boolean).join(', ') || 'standard';
  log(`Project type: ${projectFlags}`);

  const nearestTest = findNearestTestFile(filePath);
  const testPatternSample = nearestTest ? extractTestPattern(nearestTest) : null;
  log(`Test pattern: ${testPatternSample ? 'found' : 'none'}`);

  const mockHints = buildMockHints(imports, framework);
  log(`Mock hints: ${mockHints.length} dependencies`);

  const dependencyContext = collectDependencyContext(imports, log);
  if (dependencyContext.length > 0) {
    log(`Dependencies resolved: ${dependencyContext.length}`);
  }

  return {
    fileContent,
    filePath,
    exportedFunctions,
    exportTypes,
    framework,
    testPatternSample,
    mockHints,
    isFrontend,
    isNestJS,
    isNextJS,
    isGraphQL,
    isPrisma,
    dependencyContext,
    internalTypes: [],
  };
}