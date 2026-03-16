import { parse } from "@typescript-eslint/typescript-estree";
import * as fs from 'fs';
import * as path from 'path';

export interface ASTAnalysisResult {
  isTestable: boolean;
  exportedFunctions: string[];
  exportTypes: Record<string, 'default' | 'named'>; 
  imports: ImportInfo[];
  internalTypes: string[];
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
      loc: true,
      comment: false,
    });
  } catch {
    return null;
  }
}

function extractExportedFunctions(
  ast: any,
  filePath: string
): { functions: string[]; exportTypes: Record<string, 'default' | 'named'> } {
  const exported = new Set<string>();
  const exportTypes: Record<string, 'default' | 'named'> = {};
  const fileName = path.basename(filePath, path.extname(filePath));

  for (const node of ast.body) {
    // Named exports
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const decl = node.declaration;

        if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
          exported.add(decl.id.name);
          exportTypes[decl.id.name] = 'named';
        }

        if (decl.type === 'ClassDeclaration' && decl.id?.name) {
          exported.add(decl.id.name);
          exportTypes[decl.id.name] = 'named';
        }

        if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            if (declarator.id.type !== 'Identifier') { continue; }
            const init = declarator.init;
            if (
              init?.type === 'ArrowFunctionExpression' ||
              init?.type === 'FunctionExpression'
            ) {
              exported.add(declarator.id.name);
              exportTypes[declarator.id.name] = 'named';
            }
          }
        }
      }

      // Late exports: export { sum } or export { sum as total }
      if (node.specifiers?.length > 0 && !node.source) {
        for (const specifier of node.specifiers) {
          if (specifier.exported?.name) {
            exported.add(specifier.exported.name);
            exportTypes[specifier.exported.name] = 'named';
          }
        }
      }
    }

    // Default exports
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;

      if (decl.type === 'FunctionDeclaration') {
        const name = decl.id?.name ?? fileName;
        exported.add(name);
        exportTypes[name] = 'default';
      } else if (decl.type === 'ClassDeclaration') {
        const name = decl.id?.name ?? fileName;
        exported.add(name);
        exportTypes[name] = 'default';
      } else if (
        decl.type === 'ArrowFunctionExpression' ||
        decl.type === 'FunctionExpression'
      ) {
        exported.add(fileName);
        exportTypes[fileName] = 'default';
      }
    }
  }

  return { functions: [...exported], exportTypes };
}

function extractImports(ast: any, filePath: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const fileDir = path.dirname(filePath);

  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') { continue; }
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

function extractTypeDefinitions(ast: any, fileContent: string): string[] {
  const lines = fileContent.split('\n');
  const types: string[] = [];

  for (const node of ast.body) {
    // Exported interfaces, types, enums
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (
        decl.type === 'TSInterfaceDeclaration' ||
        decl.type === 'TSTypeAliasDeclaration' ||
        decl.type === 'TSEnumDeclaration'
      ) {
        const raw = lines
          .slice(decl.loc.start.line - 1, decl.loc.end.line)
          .join('\n')
          .trim();
        types.push(raw);
      }
    }

    // Also capture exported function signatures with generic constraints
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      const decl = node.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
        const sigLine = lines[decl.loc.start.line - 1].trim();
        if (sigLine.includes('<') && sigLine.includes('extends')) {
          types.push(sigLine);
        }
      }
    }
  }

  return types;
}

export function analyzeFile(
  filePath: string,
  log?: (msg: string) => void
): ASTAnalysisResult {
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {
      isTestable: false,
      exportedFunctions: [],
      exportTypes: {},
      imports: [],
      internalTypes: [],
      skipReason: 'cannot read file'
    };
  }

  const ast = parseFile(fileContent);
  if (!ast) {
    return {
      isTestable: false,
      exportedFunctions: [],
      exportTypes: {},
      imports: [],
      internalTypes: [],
      skipReason: 'syntax error'
    };
  }

  const { functions: exportedFunctions, exportTypes } =
    extractExportedFunctions(ast, filePath);

  // Phase 7 — fallback for unexported functions
  const fallbackFunctions: string[] = [];
  if (exportedFunctions.length === 0) {
    for (const node of ast.body) {
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        fallbackFunctions.push(node.id.name);
        exportTypes[node.id.name] = 'named'; // fallback = treat as named
      }
      if (node.type === 'VariableDeclaration') {
        for (const declarator of node.declarations) {
          if (
            declarator.id.type === 'Identifier' &&
            (declarator.init?.type === 'ArrowFunctionExpression' ||
             declarator.init?.type === 'FunctionExpression')
          ) {
            fallbackFunctions.push(declarator.id.name);
            exportTypes[declarator.id.name] = 'named';
          }
        }
      }
    }

    if (fallbackFunctions.length > 0) {
      log?.(`No exports found — falling back to ${fallbackFunctions.length} top-level function(s)`);
      exportedFunctions.push(...fallbackFunctions);
    }
  }

  if (exportedFunctions.length === 0) {
    return {
      isTestable: false,
      exportedFunctions: [],
      exportTypes: {},
      imports: [],
      internalTypes: [],
      skipReason: 'no testable functions found',
    };
  }

  const imports = extractImports(ast, filePath);
  const brokenImport = imports.find(i => i.isLocal && !i.resolvedPath);
  if (brokenImport) {
    log?.(`Warning: unresolvable import ${brokenImport.source} — may use path aliases, continuing...`);
  }

  const internalTypes = extractTypeDefinitions(ast, fileContent);
  return { isTestable: true, exportedFunctions, exportTypes, imports, internalTypes };
}