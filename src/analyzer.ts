import type { FeatureManifest } from './manifest.js';
import { projectPath } from './manifest.js';

export type ImportRef =
  | { kind: 'internal'; path: string }
  | { kind: 'package'; package: string };

export interface ModuleRecord {
  path: string;
  imports: ImportRef[];
}

export interface AnalysisBlocker {
  from: string;
  path: string;
  reason: 'missing-module' | 'invalid-entrypoint';
}

export interface FeatureClosure {
  files: string[];
  boundaryModules: string[];
  packages: string[];
  blockers: AnalysisBlocker[];
  ready: boolean;
}

export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisError';
  }
}

function packageName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 214 || normalized.startsWith('.') || normalized.startsWith('/')) {
    throw new AnalysisError(`invalid package import: ${value}`);
  }
  const root = normalized.startsWith('@')
    ? normalized.split('/').slice(0, 2).join('/')
    : normalized.split('/')[0]!;
  if (!/^(@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/iu.test(root)) {
    throw new AnalysisError(`invalid package import: ${value}`);
  }
  return root;
}

/**
 * Computes the deterministic file closure for a normalized module graph.
 * Capability modules are adapter boundaries: they are recorded but never
 * copied or traversed into the destination feature.
 */
export function analyzeFeatureClosure(
  feature: FeatureManifest,
  inputModules: ModuleRecord[],
): FeatureClosure {
  const modules = new Map<string, ModuleRecord>();
  for (const raw of inputModules) {
    const path = projectPath(raw.path, 'module.path');
    if (modules.has(path)) throw new AnalysisError(`duplicate module: ${path}`);
    modules.set(path, {
      path,
      imports: raw.imports.map(ref => ref.kind === 'internal'
        ? { kind: 'internal' as const, path: projectPath(ref.path, `imports from ${path}`) }
        : { kind: 'package' as const, package: packageName(ref.package) }),
    });
  }

  const boundaries = new Set(feature.capabilities.map(capability => capability.module));
  const files = new Set<string>();
  const boundaryModules = new Set<string>();
  const packages = new Set<string>();
  const blockers: AnalysisBlocker[] = [];
  const queue = feature.entrypoints.map(entry => ({ from: '<manifest>', path: entry.path }));
  const queued = new Set(queue.map(item => item.path));

  while (queue.length) {
    const current = queue.shift()!;
    if (boundaries.has(current.path)) {
      blockers.push({ from: current.from, path: current.path, reason: 'invalid-entrypoint' });
      continue;
    }
    const module = modules.get(current.path);
    if (!module) {
      blockers.push({ from: current.from, path: current.path, reason: 'missing-module' });
      continue;
    }
    files.add(module.path);

    for (const ref of module.imports) {
      if (ref.kind === 'package') {
        packages.add(ref.package);
        continue;
      }
      if (boundaries.has(ref.path)) {
        boundaryModules.add(ref.path);
        continue;
      }
      if (!queued.has(ref.path)) {
        queued.add(ref.path);
        queue.push({ from: module.path, path: ref.path });
      }
    }
  }

  blockers.sort((a, b) => `${a.path}:${a.from}`.localeCompare(`${b.path}:${b.from}`));
  return {
    files: [...files].sort(),
    boundaryModules: [...boundaryModules].sort(),
    packages: [...packages].sort(),
    blockers,
    ready: blockers.length === 0,
  };
}
