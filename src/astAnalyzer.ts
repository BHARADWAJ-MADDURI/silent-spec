import { parse } from "@typescript-eslint/typescript-estree";
import * as fs from 'fs';
import * as path from 'path';

export interface ASTAnalysisResult {
  isTestable: boolean;
  exportedFunctions: string[];
  imports: ImportInfo[];
  skipReason?: string;
}

export interface ImportInfo {
  source: string;
  isLocal: boolean;
  resolvedPath?: string;
}

function parseFile(fileContent: string) {
  try {
    return parse(fileContent, {
      jsx: true,
      tokens: false,
      range: false,
      loc: false,
      comment: false,
    });
  } catch {
    return null;
  }
}

function extractExportedFunctions(ast: any, filePath: string): string[] {
  const exported = new Set<string>();
  const fileName = path.basename(filePath, path.extname(filePath));

  for (const node of ast.body) {
    // Type-only exports (TSInterfaceDeclaration, TSTypeAliasDeclaration)
    // intentionally ignored — not testable

    // Barrel re-exports (ExportAllDeclaration: export * from './utils')
    // intentionally ignored — no direct logic to test

    // Named exports
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration;

        if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
          exported.add(decl.id.name);
        }

        if (decl.type === 'ClassDeclaration' && decl.id?.name) {
          exported.add(decl.id.name);
        }

        if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            if (declarator.id.type !== 'Identifier') {
              continue;
            }
            const init = declarator.init;
            if (
              init?.type === 'ArrowFunctionExpression' ||
              init?.type === 'FunctionExpression'
            ) {
              exported.add(declarator.id.name);
            }
          }
        }
      }

      // Late exports: export { sum } or export { sum as total }
      if (node.specifiers?.length > 0 && !node.source) {
        for (const specifier of node.specifiers) {
          if (specifier.exported?.name) {
            exported.add(specifier.exported.name);
          }
        }
      }
    }

    // Default exports
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;

      if (decl.type === 'FunctionDeclaration') {
        exported.add(decl.id?.name ?? fileName);
      } else if (decl.type === 'ClassDeclaration') {
        exported.add(decl.id?.name ?? fileName);
      } else if (
        decl.type === 'ArrowFunctionExpression' ||
        decl.type === 'FunctionExpression'
      ) {
        exported.add(fileName);
      }
    }
  }

  return [...exported];
}

function extractImports(ast: any, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const fileDir = path.dirname(filePath);

  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') {
      continue;
    }
    const source = node.source.value as string;
    const isLocal = source.startsWith('./') || source.startsWith('../');

    let resolvedPath: string | undefined;

    if (isLocal) {
      const exts = ['.ts', '.tsx', '.js', '.jsx'];
      const candidates = [
        ...exts.map(e => path.resolve(fileDir, source + e)),
        ...exts.map(e => path.resolve(fileDir, source, 'index' + e))
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          resolvedPath = candidate;
          break;
        }
      }
    }

    imports.push({ source, isLocal, resolvedPath });
  }

  return imports;
}

export function analyzeFile(
  filePath: string,
  log?: (msg: string) => void
): ASTAnalysisResult {
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { isTestable: false, exportedFunctions: [], imports: [], skipReason: 'cannot read file' };
  }

  const ast = parseFile(fileContent);
  if (!ast) {
    return { isTestable: false, exportedFunctions: [], imports: [], skipReason: 'syntax error' };
  }

  const exportedFunctions = extractExportedFunctions(ast, filePath);

  // Phase 7 — fallback for unexported functions
  // Handles files with no exports: module.exports, internal helpers, etc.
  if (exportedFunctions.length === 0) {
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        exportedFunctions.push(node.id.name);
      }
      if (node.type === 'VariableDeclaration') {
        for (const declarator of node.declarations) {
          if (
            declarator.id.type === 'Identifier' &&
            (declarator.init?.type === 'ArrowFunctionExpression' ||
             declarator.init?.type === 'FunctionExpression')
          ) {
            exportedFunctions.push(declarator.id.name);
          }
        }
      }
    }

    if (exportedFunctions.length > 0) {
      log?.(`No exports found — falling back to ${exportedFunctions.length} top-level function(s)`);
    }
  }

  // Skip only if truly no functions found at all — not just no exports
  if (exportedFunctions.length === 0) {
    return {
      isTestable: false,
      exportedFunctions: [],
      imports: [],
      skipReason: 'no testable functions found',
    };
  }

  const imports = extractImports(ast, filePath);
  const brokenImport = imports.find(i => i.isLocal && !i.resolvedPath);
  if (brokenImport) {
    log?.(`Warning: unresolvable import ${brokenImport.source} — may use path aliases, continuing...`);
  }

  return { isTestable: true, exportedFunctions, imports };
}