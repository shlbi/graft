import { projectPath } from './manifest.js';

export interface FileSnapshot {
  path: string;
  content: string;
}

export interface IntegrationMount {
  id: string;
  targetPath: string;
  marker: string;
  content: string;
}

export type IntegrationBlockerReason =
  | 'duplicate-id'
  | 'duplicate-target'
  | 'target-missing'
  | 'marker-missing'
  | 'marker-ambiguous';

export interface IntegrationBlocker {
  id: string;
  targetPath: string;
  reason: IntegrationBlockerReason;
}

export interface PreparedIntegrationPatch {
  id: string;
  targetPath: string;
  marker: string;
  content: string;
  before: string;
  after: string;
}

export interface IntegrationPlan {
  patches: PreparedIntegrationPatch[];
  blockers: IntegrationBlocker[];
  touchedTargets: string[];
  ready: boolean;
}

export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationError';
  }
}

function validateId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw new IntegrationError(`invalid integration id: ${value}`);
  }
  return value;
}

function validateMarker(value: string): string {
  if (!value || value.length > 256 || /[\r\n]/u.test(value)) {
    throw new IntegrationError('integration marker must be one nonempty line of at most 256 characters');
  }
  return value;
}

function validateContent(value: string): string {
  if (!value.trim() || value.length > 32_768 || /\x00/u.test(value)) {
    throw new IntegrationError('integration content must be nonempty UTF-8 text of at most 32768 characters');
  }
  return value.endsWith('\n') ? value : `${value}\n`;
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

/**
 * Prepares exact marker replacements without mutating the destination. A mount
 * is reviewable because both before/after snapshots are retained, and it is
 * safe-by-default because zero or multiple marker matches block application.
 */
export function prepareIntegrationPlan(
  mounts: IntegrationMount[],
  destinationSnapshots: FileSnapshot[],
): IntegrationPlan {
  const files = new Map<string, string>();
  for (const [index, snapshot] of destinationSnapshots.entries()) {
    const path = projectPath(snapshot.path, `destinationSnapshots[${index}].path`);
    if (files.has(path)) throw new IntegrationError(`duplicate destination snapshot: ${path}`);
    files.set(path, snapshot.content);
  }

  const seenIds = new Set<string>();
  const seenTargets = new Set<string>();
  const blockers: IntegrationBlocker[] = [];
  const patches: PreparedIntegrationPatch[] = [];

  for (const [index, raw] of mounts.entries()) {
    const id = validateId(raw.id);
    const targetPath = projectPath(raw.targetPath, `mounts[${index}].targetPath`);
    const marker = validateMarker(raw.marker);
    const content = validateContent(raw.content);

    if (seenIds.has(id)) {
      blockers.push({ id, targetPath, reason: 'duplicate-id' });
      continue;
    }
    seenIds.add(id);
    if (seenTargets.has(targetPath)) {
      blockers.push({ id, targetPath, reason: 'duplicate-target' });
      continue;
    }
    seenTargets.add(targetPath);

    const before = files.get(targetPath);
    if (before === undefined) {
      blockers.push({ id, targetPath, reason: 'target-missing' });
      continue;
    }
    const matchCount = occurrences(before, marker);
    if (matchCount === 0) {
      blockers.push({ id, targetPath, reason: 'marker-missing' });
      continue;
    }
    if (matchCount !== 1) {
      blockers.push({ id, targetPath, reason: 'marker-ambiguous' });
      continue;
    }

    patches.push({
      id,
      targetPath,
      marker,
      content,
      before,
      after: before.replace(marker, content.trimEnd()),
    });
  }

  patches.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  blockers.sort((a, b) => `${a.targetPath}:${a.id}:${a.reason}`.localeCompare(`${b.targetPath}:${b.id}:${b.reason}`));
  return {
    patches,
    blockers,
    touchedTargets: patches.map(patch => patch.targetPath),
    ready: blockers.length === 0,
  };
}

/** Applies only the exact before/after patches that were previously reviewed. */
export function applyIntegrationPlan(
  plan: IntegrationPlan,
  destinationSnapshots: FileSnapshot[],
): FileSnapshot[] {
  if (!plan.ready) throw new IntegrationError('integration plan contains blockers');
  const patches = new Map(plan.patches.map(patch => [patch.targetPath, patch]));
  const seen = new Set<string>();
  const result = destinationSnapshots.map((snapshot, index) => {
    const path = projectPath(snapshot.path, `destinationSnapshots[${index}].path`);
    if (seen.has(path)) throw new IntegrationError(`duplicate destination snapshot: ${path}`);
    seen.add(path);
    const patch = patches.get(path);
    if (!patch) return { ...snapshot, path };
    if (snapshot.content !== patch.before) {
      throw new IntegrationError(`destination changed after review: ${path}`);
    }
    return { path, content: patch.after };
  });
  for (const path of patches.keys()) {
    if (!seen.has(path)) throw new IntegrationError(`reviewed integration target disappeared: ${path}`);
  }
  return result;
}
