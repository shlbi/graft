import ts from 'typescript';
import type { CapabilityBinding } from './changeset.js';
import { projectPath } from './manifest.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;
export interface RewriteResult { content: string; rewritten: { from: string; to: string }[]; }
export class RewriteError extends Error { constructor(message: string) { super(message); this.name = 'RewriteError'; } }

function dirname(path: string): string { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
function joined(base: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const stack = base ? base.split('/') : [];
  for (const part of specifier.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!stack.length) return null; stack.pop(); } else stack.push(part);
  }
  return stack.join('/');
}
function boundaryCandidates(importer: string, specifier: string): string[] {
  const base = joined(dirname(importer), specifier); if (!base) return [];
  const leaf = base.slice(base.lastIndexOf('/') + 1); const dot = leaf.lastIndexOf('.'); const extension = dot > 0 ? leaf.slice(dot) : '';
  if (extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs') {
    const stem = base.slice(0, -extension.length);
    const mapped = extension === '.mjs' ? '.mts' : extension === '.cjs' ? '.cts' : extension === '.jsx' ? '.tsx' : '.ts';
    return [`${stem}${mapped}`];
  }
  if (SOURCE_EXTENSIONS.includes(extension as (typeof SOURCE_EXTENSIONS)[number])) return [base];
  if (extension) return [];
  return [...SOURCE_EXTENSIONS.map(ext => `${base}${ext}`), ...SOURCE_EXTENSIONS.map(ext => `${base}/index${ext}`)];
}
function runtimePath(path: string): string { return path.replace(/\.mts$/u, '.mjs').replace(/\.cts$/u, '.cjs').replace(/\.tsx?$/u, '.js'); }
function relativeSpecifier(from: string, to: string): string {
  const a = dirname(from).split('/').filter(Boolean); const b = runtimePath(to).split('/').filter(Boolean); let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const result = [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  return result.startsWith('.') ? result : `./${result}`;
}

/** Rewrite only static ESM edges that resolve to a declared adapter boundary. */
export function rewriteAdapterImports(sourcePath: string, content: string, bindings: CapabilityBinding[]): RewriteResult {
  sourcePath = projectPath(sourcePath, 'sourcePath');
  const bySource = new Map<string, CapabilityBinding>();
  for (const binding of bindings) {
    const sourceModule = projectPath(binding.sourceModule, 'binding.sourceModule');
    const destinationModule = projectPath(binding.destinationModule, 'binding.destinationModule');
    if (bySource.has(sourceModule)) throw new RewriteError(`duplicate binding for ${sourceModule}`);
    bySource.set(sourceModule, { ...binding, sourceModule, destinationModule });
  }
  const sourceFile = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true, sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: { start: number; end: number; text: string; from: string; to: string }[] = [];
  function consider(literal: ts.StringLiteralLike): void {
    const matches = boundaryCandidates(sourcePath, literal.text).filter(candidate => bySource.has(candidate));
    if (matches.length > 1) throw new RewriteError(`ambiguous adapter import ${literal.text} from ${sourcePath}`);
    if (!matches.length) return;
    const binding = bySource.get(matches[0]!)!; const to = relativeSpecifier(sourcePath, binding.destinationModule);
    edits.push({ start: literal.getStart(sourceFile) + 1, end: literal.getEnd() - 1, text: to, from: literal.text, to });
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) consider(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) consider(node.moduleSpecifier);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  let rewritten = content;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  return { content: rewritten, rewritten: edits.map(({ from, to }) => ({ from, to })) };
}
