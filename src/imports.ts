import ts from 'typescript';
import type { ModuleRecord, ImportRef } from './analyzer.js';
import { projectPath } from './manifest.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

export type ImportParseBlockerReason =
  | 'commonjs-require'
  | 'dynamic-import'
  | 'unresolved-relative-import'
  | 'unsupported-source-extension';

export interface ImportParseBlocker {
  path: string;
  specifier: string;
  reason: ImportParseBlockerReason;
}

export interface TypeScriptSnapshot {
  path: string;
  content: string;
}

export interface ParsedModuleGraph {
  modules: ModuleRecord[];
  blockers: ImportParseBlocker[];
  ready: boolean;
}

function isSupportedSource(pathname: string): boolean {
  return SOURCE_EXTENSIONS.some(extension => pathname.endsWith(extension));
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): { staticSpecifiers: string[]; blockers: ImportParseBlocker[] } {
  const staticSpecifiers: string[] = [];
  const blockers: ImportParseBlocker[] = [];
  const sourcePath = projectPath(sourceFile.fileName, 'source.path');

  function addStatic(node: ts.StringLiteralLike): void {
    staticSpecifiers.push(node.text);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addStatic(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      addStatic(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      blockers.push({ path: sourcePath, specifier: node.getText(sourceFile), reason: 'commonjs-require' });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      blockers.push({
        path: sourcePath,
        specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : node.getText(sourceFile),
        reason: 'dynamic-import',
      });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const argument = node.arguments[0];
      blockers.push({
        path: sourcePath,
        specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : node.getText(sourceFile),
        reason: 'commonjs-require',
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { staticSpecifiers, blockers };
}

function relativeCandidates(importer: string, specifier: string): string[] {
  const parent = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '';
  const stack = parent ? parent.split('/') : [];
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!stack.length) return [];
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  const normalized = stack.join('/');
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = leaf.lastIndexOf('.');
  const extension = dot > 0 ? leaf.slice(dot) : '';
  if (extension) {
    if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
      const stem = normalized.slice(0, -extension.length);
      return SOURCE_EXTENSIONS.map(sourceExtension => `${stem}${sourceExtension}`);
    }
    return isSupportedSource(normalized) ? [normalized] : [];
  }

  return [
    ...SOURCE_EXTENSIONS.map(sourceExtension => `${normalized}${sourceExtension}`),
    ...SOURCE_EXTENSIONS.map(sourceExtension => `${normalized}/index${sourceExtension}`),
  ];
}

function resolveSpecifier(importer: string, specifier: string, knownPaths: Set<string>): ImportRef | null {
  if (!specifier.startsWith('.')) return { kind: 'package', package: specifier };
  const matches = relativeCandidates(importer, specifier).filter(candidate => knownPaths.has(candidate));
  if (matches.length !== 1) return null;
  return { kind: 'internal', path: matches[0]! };
}

/**
 * Parses the deliberately narrow v0.1 TypeScript module subset. It supports
 * static ESM import/export edges and refuses dynamic/CommonJS dependencies.
 */
export function parseTypeScriptModules(snapshots: TypeScriptSnapshot[]): ParsedModuleGraph {
  const knownPaths = new Set<string>();
  for (const snapshot of snapshots) {
    const pathname = projectPath(snapshot.path, 'snapshot.path');
    if (knownPaths.has(pathname)) throw new Error(`duplicate source snapshot: ${pathname}`);
    knownPaths.add(pathname);
  }

  const modules: ModuleRecord[] = [];
  const blockers: ImportParseBlocker[] = [];

  for (const snapshot of snapshots) {
    const pathname = projectPath(snapshot.path, 'snapshot.path');
    if (!isSupportedSource(pathname)) {
      blockers.push({ path: pathname, specifier: pathname, reason: 'unsupported-source-extension' });
      continue;
    }
    const scriptKind = pathname.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(pathname, snapshot.content, ts.ScriptTarget.Latest, true, scriptKind);
    const parsed = collectModuleSpecifiers(sourceFile);
    blockers.push(...parsed.blockers);
    const imports: ImportRef[] = [];
    for (const specifier of parsed.staticSpecifiers) {
      const ref = resolveSpecifier(pathname, specifier, knownPaths);
      if (!ref) {
        blockers.push({ path: pathname, specifier, reason: 'unresolved-relative-import' });
        continue;
      }
      imports.push(ref);
    }
    modules.push({ path: pathname, imports });
  }

  modules.sort((a, b) => a.path.localeCompare(b.path));
  blockers.sort((a, b) => `${a.path}:${a.reason}:${a.specifier}`.localeCompare(`${b.path}:${b.reason}:${b.specifier}`));
  return { modules, blockers, ready: blockers.length === 0 };
}
