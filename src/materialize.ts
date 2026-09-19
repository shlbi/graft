import type { ReviewableChangeSet } from './changeset.js';
import { projectPath } from './manifest.js';

export interface FileSnapshot {
  path: string;
  content: string;
}

export interface MaterializedFile extends FileSnapshot {
  sourcePath: string;
  sourceKind: 'module' | 'asset';
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
 * It does not rewrite adapter imports yet; that is a separate, reviewable step.
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
    const content = source.get(sourcePath);
    if (content === undefined) throw new MaterializationError(`missing source snapshot: ${sourcePath}`);
    created.push({ path: targetPath, content, sourcePath, sourceKind: operation.sourceKind });
  }

  created.sort((a, b) => a.path.localeCompare(b.path));
  const preserved = [...destination.keys()].sort();
  const result: FileSnapshot[] = [
    ...[...destination].map(([path, content]) => ({ path, content })),
    ...created.map(({ path, content }) => ({ path, content })),
  ].sort((a, b) => a.path.localeCompare(b.path));

  return { feature: changeSet.feature, created, preserved, result };
}
