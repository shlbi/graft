import type { FeatureClosure } from './analyzer.js';
import type { FeatureManifest } from './manifest.js';
import { projectPath } from './manifest.js';
import type { TransplantPlan } from './planner.js';

export interface CopyOperation {
  kind: 'copy';
  sourcePath: string;
  targetPath: string;
  sourceKind: 'module' | 'asset';
}

export interface CapabilityBinding {
  sourceCapability: string;
  sourceModule: string;
  destinationCapability: string;
  destinationModule: string;
}

export interface ChangeSetBlocker {
  targetPath: string;
  reason: 'target-exists';
}

export interface ReviewableChangeSet {
  feature: string;
  operations: CopyOperation[];
  bindings: CapabilityBinding[];
  blockers: ChangeSetBlocker[];
  touchedTargets: string[];
  ready: boolean;
}

export class ChangeSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeSetError';
  }
}

/**
 * Builds a deterministic, review-only change set. It never overwrites an
 * existing destination path; collision resolution must be explicit later.
 */
export function buildReviewableChangeSet(
  feature: FeatureManifest,
  closure: FeatureClosure,
  plan: TransplantPlan,
  destinationPaths: string[],
): ReviewableChangeSet {
  if (!closure.ready) throw new ChangeSetError('feature closure contains unresolved blockers');
  if (!plan.ready) throw new ChangeSetError('transplant plan contains unresolved capability mappings');
  if (plan.feature !== feature.name) throw new ChangeSetError('transplant plan belongs to a different feature');

  const existing = new Set(destinationPaths.map((path, index) => projectPath(path, `destinationPaths[${index}]`)));
  const sourcePaths = [
    ...closure.files.map(path => ({ path, sourceKind: 'module' as const })),
    ...feature.assets.map(asset => ({ path: asset.path, sourceKind: 'asset' as const })),
  ];
  const unique = new Map<string, 'module' | 'asset'>();
  for (const source of sourcePaths) {
    if (unique.has(source.path) && unique.get(source.path) !== source.sourceKind) {
      throw new ChangeSetError(`path declared as both module and asset: ${source.path}`);
    }
    unique.set(source.path, source.sourceKind);
  }

  const operations: CopyOperation[] = [...unique]
    .map(([path, sourceKind]) => ({ kind: 'copy' as const, sourcePath: path, targetPath: path, sourceKind }))
    .sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  const blockers = operations
    .filter(operation => existing.has(operation.targetPath))
    .map(operation => ({ targetPath: operation.targetPath, reason: 'target-exists' as const }));

  const sourceCapabilities = new Map(feature.capabilities.map(capability => [capability.name, capability]));
  const bindings = plan.mappings.map(mapping => {
    const source = sourceCapabilities.get(mapping.source);
    if (!source) throw new ChangeSetError(`plan references unknown source capability: ${mapping.source}`);
    return {
      sourceCapability: source.name,
      sourceModule: source.module,
      destinationCapability: mapping.destination,
      destinationModule: mapping.destinationModule,
    };
  }).sort((a, b) => a.sourceCapability.localeCompare(b.sourceCapability));

  return {
    feature: feature.name,
    operations,
    bindings,
    blockers,
    touchedTargets: operations.map(operation => operation.targetPath),
    ready: blockers.length === 0,
  };
}
