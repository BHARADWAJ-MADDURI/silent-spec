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
  exportedFunctions: string[];
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
}

export interface MockHint {
  source: string;
  mockStrategy: string;
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath ?? null;
}

export function detectFramework(workspaceRoot: string): TestFramework {
  try {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps['vitest']) { return 'vitest'; }
    if (deps['mocha']) { return 'mocha'; }
    if (deps['jasmine']) { return 'jasmine'; }
    return 'jest';
  } catch {
    return 'jest';
  }
}

export function findNearestTestFile(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) { return null; }

  while (dir.startsWith(workspaceRoot)) {
    try {
      const entries = fs.readdirSync(dir);

      const testFile = entries.find(f =>
        /\.(test|spec)\.[tj]sx?$/.test(f)
      );
      if (testFile) { return path.join(dir, testFile); }

      const testDirs = ['__tests__', 'tests', 'test'];
      for (const testDir of testDirs) {
        const testDirPath = path.join(dir, testDir);
        if (fs.existsSync(testDirPath)) {
          try {
            const dirEntries = fs.readdirSync(testDirPath);
            const dirTestFile = dirEntries.find(f =>
              /\.[tj]sx?$/.test(f)
            );
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
    return content.split('\n').slice(0, 60).join('\n');
  } catch {
    return null;
  }
}

export function buildMockHints(
  imports: ImportInfo[],
  framework: TestFramework
): MockHint[] {
  const mockFn = framework === 'vitest' ? 'vi.mock' : 'jest.mock';

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

  const isNestJS = imports.some(i => i.source.startsWith('@nestjs/'));

  const isNextJS = imports.some(i =>
    i.source === 'next' || i.source.startsWith('next/')
  );

  const graphqlPackages = [
    'graphql', '@apollo/client', '@apollo/server',
    'graphql-request', 'urql', 'relay-runtime', 'type-graphql'
  ];
  const isGraphQL = imports.some(i => graphqlPackages.includes(i.source));

  const isPrisma = imports.some(i =>
    i.source === '@prisma/client' || i.source.includes('prisma')
  );

  return { isFrontend, isNestJS, isNextJS, isGraphQL, isPrisma };
}

export function extractContext(
  filePath: string,
  exportedFunctions: string[],
  imports: ImportInfo[],
  log: (msg: string) => void
): SilentSpecContext {

  const workspaceRoot = getWorkspaceRoot() ?? path.dirname(filePath);
  const fileContent = fs.readFileSync(filePath, 'utf8');

  const framework = detectFramework(workspaceRoot);
  log(`Framework detected: ${framework}`);

  const { isFrontend, isNestJS, isNextJS, isGraphQL, isPrisma } =
    detectProjectType(filePath, imports);

  const projectFlags = [
    isFrontend && 'frontend',
    isNestJS && 'nestjs',
    isNextJS && 'nextjs',
    isGraphQL && 'graphql',
    isPrisma && 'prisma',
  ].filter(Boolean).join(', ') || 'standard';
  log(`Project type: ${projectFlags}`);

  const nearestTest = findNearestTestFile(filePath);
  const testPatternSample = nearestTest
    ? extractTestPattern(nearestTest)
    : null;
  log(`Test pattern: ${testPatternSample ? 'found' : 'none'}`);

  const mockHints = buildMockHints(imports, framework);
  log(`Mock hints: ${mockHints.length} dependencies`);

  // Phase 7 — collect dependency signatures for local imports
  const dependencyContext = collectDependencyContext(imports, log);
  if (dependencyContext.length > 0) {
    log(`Dependencies resolved: ${dependencyContext.length}`);
  }

  return {
    fileContent,
    filePath,
    exportedFunctions,
    framework,
    testPatternSample,
    mockHints,
    isFrontend,
    isNestJS,
    isNextJS,
    isGraphQL,
    isPrisma,
    dependencyContext, // Phase 7
  };
}