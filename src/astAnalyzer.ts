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
    });
  } catch {
    return null;
  }
}

function extractExportedFunctions(ast: any): string[] {
  const exported: string[] = [];
  
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') {
      continue;
    }
    if (!node.declaration) {
      continue;
    }
    const dec1 = node.declaration;

    if (dec1.type === 'FunctionDeclaration' && dec1.id?.name) {
      exported.push(dec1.id.name);
    }

    if  (dec1.type === 'ClassDeclaration' && dec1.id?.name) {
      exported.push(dec1.id.name);
    }

    if (dec1.type === 'VariableDeclaration') {
      for (const declarator of dec1.declarations) {
        const init = declarator.init;
        if (
          init?.type === 'ArrowFunctionExpression' || 
          init.type === 'FunctionExpression'
        ) {
          exported.push(declarator.id.name);
        }
      }
    }
  }

  return exported;
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
    // Try resolving with common extensions
    const exts = ['.ts', '.tsx', '.js', '.jsx', ''];
    for  (const ext of exts) {
      const candidate = path.resolve(fileDir, source + ext);
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

export function analyzeFile(filePath: string): ASTAnalysisResult {

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, 'utf8');
  } catch {
    return  { isTestable: false, exportedFunctions: [], imports: [], skipReason: 'cannot read file' };
  }

  // Parse to AST
  const ast = parseFile(fileContent);
  if (!ast) {
    return { isTestable: false, exportedFunctions: [], imports: [], skipReason: 'syntax error' };
  }

  // Detect exported Functions 
  const exportedFunctions = extractExportedFunctions(ast);
  if (exportedFunctions.length === 0) {
    return { isTestable: false, exportedFunctions: [], imports: [], skipReason: 'no exported functions' };
  }

  // Extract and validate imports
  const imports = extractImports(ast, filePath);

  const brokenImport = imports.find(i => i.isLocal && !i.resolvedPath);
  if (brokenImport) {
    return { isTestable: false, exportedFunctions: [], imports, skipReason: `unresolvable import: ${brokenImport.source}` };
  }

  return { isTestable: true, exportedFunctions, imports };  
 
}
