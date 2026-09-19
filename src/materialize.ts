import type { ReviewableChangeSet } from './changeset.js';
import { projectPath } from './manifest.js';
import { rewriteAdapterImports } from './rewrite.js';

export interface FileSnapshot {
  path: string;
  content: string;
}

export interface MaterializedFile extends FileSnapshot {
  sourcePath: string;
  sourceKind: 'module' | 'asset';
  rewrittenImports: { from: string; to: string }[];
}

export interface MaterializationResult {
  feature: string;
  created: MaterializedFile[];
  preserved: string[];
  result: FileSnapshot[];
}

export class MaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaterializationError';
  }
}

function snapshotMap(snapshots: FileSnapshot[], label: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const [index, snapshot] of snapshots.entries()) {
    const pathname = projectPath(snapshot.path, `${label}[${index}].path`);
    if (map.has(pathname)) throw new MaterializationError(`duplicate ${label} path: ${pathname}`);
    if (typeof snapshot.content !== 'string') throw new MaterializationError(`invalid content for ${pathname}`);
    map.set(pathname, snapshot.content);
  }
  return map;
}

/**
 * Applies an already-reviewed change set to immutable synthetic snapshots.
 * Copied TypeScript modules are rewritten only at declared adapter boundaries;
 * assets are copied byte-for-byte (as UTF-8 text in this v0.1 snapshot model).
 */
export function materializeChangeSet(
  changeSet: ReviewableChangeSet,
  sourceSnapshots: FileSnapshot[],
  destinationSnapshots: FileSnapshot[],
): MaterializationResult {
  if (!changeSet.ready || changeSet.blockers.length) {
    throw new MaterializationError('change set is not ready for materialization');
  }

  const source = snapshotMap(sourceSnapshots, 'sourceSnapshots');
  const destination = snapshotMap(destinationSnapshots, 'destinationSnapshots');
  const created: MaterializedFile[] = [];
  const targets = new Set<string>();

  for (const operation of changeSet.operations) {
    if (operation.kind !== 'copy') throw new MaterializationError('unsupported change-set operation');
    const sourcePath = projectPath(operation.sourcePath, 'operation.sourcePath');
    const targetPath = projectPath(operation.targetPath, 'operation.targetPath');
    if (targets.has(targetPath)) throw new MaterializationError(`duplicate target operation: ${targetPath}`);
    targets.add(targetPath);
    if (destination.has(targetPath)) throw new MaterializationError(`refusing to overwrite destination path: ${targetPath}`);
    const originalContent = source.get(sourcePath);
    if (originalContent === undefined) throw new MaterializationError(`missing source snapshot: ${sourcePath}`);

    const rewritten = operation.sourceKind === 'module'
      ? rewriteAdapterImports(sourcePath, originalContent, changeSet.bindings, targetPath)
      : { content: originalContent, rewritten: [] };
    created.push({
      path: targetPath,
      content: rewritten.content,
      sourcePath,
      sourceKind: operation.sourceKind,
      rewrittenImports: rewritten.rewritten,
    });
  }

  created.sort((a, b) => a.path.localeCompare(b.path));
  const preserved = [...destination.keys()].sort();
  const result: FileSnapshot[] = [
    ...[...destination].map(([path, content]) => ({ path, content })),
    ...created.map(({ path, content }) => ({ path, content })),
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { feature: changeSet.feature, created, preserved, result };
}
