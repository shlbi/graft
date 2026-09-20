import { buildReviewableChangeSet, type ReviewableChangeSet } from './changeset.js';
import { parseDestinationInventory, type DestinationInventory } from './inventory.js';
import { parseFeatureManifest, type FeatureManifest } from './manifest.js';
import { materializeChangeSet, type FileSnapshot, type MaterializationResult } from './materialize.js';
import { analyzeTypeScriptFeature, type SourceAnalysis } from './pipeline.js';
import { planTransplant, type MappingOverride, type TransplantPlan } from './planner.js';
import type { TypeScriptSnapshot } from './imports.js';

export interface PreparedTransplant {
  feature: FeatureManifest;
  inventory: DestinationInventory;
  analysis: SourceAnalysis;
  plan: TransplantPlan | null;
  changeSet: ReviewableChangeSet | null;
  ready: boolean;
}

export class TransplantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransplantError';
  }
}

/**
 * Runs the full read-only Graft planning pipeline. No destination content is
 * changed until the returned reviewable change set is explicitly applied.
 */
export function prepareTransplant(
  featureInput: unknown,
  inventoryInput: unknown,
  sourceSnapshots: TypeScriptSnapshot[],
  destinationSnapshots: FileSnapshot[],
  overrides: MappingOverride[] = [],
): PreparedTransplant {
  const feature = parseFeatureManifest(featureInput);
  const inventory = parseDestinationInventory(inventoryInput);
  const analysis = analyzeTypeScriptFeature(feature, sourceSnapshots);

  if (!analysis.ready || !analysis.closure) {
    return { feature, inventory, analysis, plan: null, changeSet: null, ready: false };
  }

  const plan = planTransplant(feature, inventory.capabilities, overrides);
  if (!plan.ready) {
    return { feature, inventory, analysis, plan, changeSet: null, ready: false };
  }

  const changeSet = buildReviewableChangeSet(
    feature,
    analysis.closure,
    plan,
    destinationSnapshots.map(snapshot => snapshot.path),
  );

  return { feature, inventory, analysis, plan, changeSet, ready: changeSet.ready };
}

/** Applies only a previously prepared, blocker-free reviewable change set. */
export function applyPreparedTransplant(
  prepared: PreparedTransplant,
  sourceSnapshots: FileSnapshot[],
  destinationSnapshots: FileSnapshot[],
): MaterializationResult {
  if (!prepared.ready || !prepared.changeSet) {
    throw new TransplantError('prepared transplant is not ready for application');
  }
  return materializeChangeSet(prepared.changeSet, sourceSnapshots, destinationSnapshots);
}
