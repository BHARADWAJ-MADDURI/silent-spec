import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@typescript-eslint/typescript-estree';
import { ImportInfo } from './astAnalyzer';

export interface DependencyContext {
  source: string;
  resolvedPath: string;
  summary: string;
}

const MAX_DEP_CHARS    = 2000;
const MAX_DEPENDENCIES = 5;
const MAX_FILE_BYTES   = 100_000;

function extractSignatures(fileContent: string): string {
  try {
    const ast = parse(fileContent, {
      jsx: true,
      tokens: false,
      range: false,
      loc: true,       // required — enables line-based extraction
      comment: false,
    });

    const fileLines = fileContent.split('\n'); // pre-split once
    const lines: string[] = [];

    for (const node of ast.body) {
      if (node.type === 'ExportNamedDeclaration' && node.declaration) {
        const decl = node.declaration;

        if (
          decl.type === 'TSInterfaceDeclaration' ||
          decl.type === 'TSTypeAliasDeclaration'
        ) {
          const raw = fileLines
            .slice(decl.loc.start.line - 1, decl.loc.end.line)
            .join('\n');
          lines.push(raw);
        }

        if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
          lines.push(fileLines[decl.loc.start.line - 1].trim());
        }

        if (decl.type === 'VariableDeclaration') {
          for (const declarator of decl.declarations) {
            if (declarator.id.type !== 'Identifier') { continue; }
            const init = declarator.init;
            if (
              init?.type === 'ArrowFunctionExpression' ||
              init?.type === 'FunctionExpression'
            ) {
              lines.push(fileLines[declarator.loc.start.line - 1].trim());
            }
          }
        }
      }

      if (node.type === 'ExportDefaultDeclaration') {
        const decl = node.declaration;
        if (
          decl.type === 'FunctionDeclaration' ||
          decl.type === 'ClassDeclaration' ||
          decl.type === 'ArrowFunctionExpression'
        ) {
          lines.push(fileLines[node.loc.start.line - 1].trim());
        }
      }
    }

    return lines.join('\n').slice(0, MAX_DEP_CHARS);

  } catch {
    return fileContent.slice(0, MAX_DEP_CHARS);
  }
}

export function collectDependencyContext(
  imports: ImportInfo[],
  log: (msg: string) => void
): DependencyContext[] {
  const results: DependencyContext[] = [];

  for (const imp of imports) {
    if (results.length >= MAX_DEPENDENCIES) { break; }

    if (!imp.isLocal || !imp.resolvedPath) { continue; }

    // Skip test files
    if (/\.(test|spec)\.[tj]sx?$/.test(imp.resolvedPath)) { continue; }

    // Skip barrel files
    if (path.basename(imp.resolvedPath).startsWith('index.')) { continue; }

    // Skip huge files
    try {
      const stats = fs.statSync(imp.resolvedPath);
      if (stats.size > MAX_FILE_BYTES) {
        log(`Warning: ${imp.source} too large (${Math.round(stats.size / 1024)}KB) — skipping`);
        continue;
      }
    } catch {
      continue;
    }

    try {
      const fileContent = fs.readFileSync(imp.resolvedPath, 'utf8');
      const summary = extractSignatures(fileContent);

      if (summary.trim().length === 0) { continue; }

      results.push({
        source: imp.source,
        resolvedPath: imp.resolvedPath,
        summary,
      });

      log(`Dependency context extracted: ${imp.source} (${path.basename(imp.resolvedPath)})`);

    } catch {
      log(`Warning: could not read dependency ${imp.source} — skipping`);
    }
  }

  return results;
}