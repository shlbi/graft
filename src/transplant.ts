import { buildReviewableChangeSet, type ReviewableChangeSet } from './changeset.js';
import { parseDestinationInventory, type DestinationInventory } from './inventory.js';
import { parseFeatureManifest, projectPath, type FeatureManifest } from './manifest.js';
import { materializeChangeSet, type FileSnapshot, type MaterializationResult } from './materialize.js';
import { analyzeTypeScriptFeature, type SourceAnalysis } from './pipeline.js';
import { planTransplant, type MappingOverride, type TransplantPlan } from './planner.js';
import { applyIntegrationPlan, prepareIntegrationPlan, type IntegrationMount, type IntegrationPlan, type PreparedIntegrationPatch } from './integration.js';
import type { TypeScriptSnapshot } from './imports.js';

export interface PreparedTransplant {
  feature: FeatureManifest;
  inventory: DestinationInventory;
  analysis: SourceAnalysis;
  plan: TransplantPlan | null;
  changeSet: ReviewableChangeSet | null;
  integration: IntegrationPlan;
  touchedTargets: string[];
  dependencyBlockers: { path: string; reason: 'destination-adapter-missing' }[];
  /** Content preconditions, not a signature or a substitute for user approval. */
  reviewedInputs: { source: FileSnapshot[]; destination: FileSnapshot[] };
  ready: boolean;
}

export interface AppliedTransplant extends MaterializationResult {
  updated: PreparedIntegrationPatch[];
}

export class TransplantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransplantError';
  }
}

function indexSnapshots(snapshots: FileSnapshot[], label: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const snapshot of snapshots) {
    const path = projectPath(snapshot.path, `${label}.path`);
    if (files.has(path)) throw new TransplantError(`duplicate ${label} path: ${path}`);
    if (typeof snapshot.content !== 'string') throw new TransplantError(`invalid content: ${path}`);
    files.set(path, snapshot.content);
  }
  return files;
}

function assertUnchanged(reviewed: FileSnapshot[], actual: Map<string, string>, label: string): void {
  for (const snapshot of reviewed) {
    if (actual.get(snapshot.path) !== snapshot.content) {
      throw new TransplantError(`${label} changed after review: ${snapshot.path}`);
    }
  }
}

/**
 * Read-only preparation of BOTH feature copies and explicit integration edits.
 * The last argument supplies user-reviewed mount points; omitted mounts retain
 * the original copy-only behavior. No scripts or destination files are run.
 */
export function prepareTransplant(
  featureInput: unknown,
  inventoryInput: unknown,
  sourceSnapshots: TypeScriptSnapshot[],
  destinationSnapshots: FileSnapshot[],
  overrides: MappingOverride[] = [],
  mounts: IntegrationMount[] = [],
): PreparedTransplant {
  const feature = parseFeatureManifest(featureInput);
  const inventory = parseDestinationInventory(inventoryInput);
  const source = indexSnapshots(sourceSnapshots, 'source');
  const destination = indexSnapshots(destinationSnapshots, 'destination');
  const integration = prepareIntegrationPlan(mounts, destinationSnapshots);
  const analysis = analyzeTypeScriptFeature(feature, sourceSnapshots);
  const prepared: PreparedTransplant = {
    feature, inventory, analysis, integration, plan: null, changeSet: null,
    touchedTargets: [...integration.touchedTargets], dependencyBlockers: [],
    reviewedInputs: {
      source: [...source].map(([path, content]) => ({ path, content })),
      destination: [],
    },
    ready: false,
  };
  if (!analysis.ready || !analysis.closure) return prepared;

  const plan = planTransplant(feature, inventory.capabilities, overrides);
  prepared.plan = plan;
  if (!plan.ready) return prepared;

  const changeSet = buildReviewableChangeSet(feature, analysis.closure, plan, [...destination.keys()]);
  prepared.changeSet = changeSet;
  const requiredPaths = new Set([
    ...changeSet.bindings.map(binding => binding.destinationModule),
    ...integration.touchedTargets,
  ]);
  for (const path of [...requiredPaths].sort()) {
    const content = destination.get(path);
    if (content === undefined) {
      prepared.dependencyBlockers.push({ path, reason: 'destination-adapter-missing' });
    } else {
      prepared.reviewedInputs.destination.push({ path, content });
    }
  }
  prepared.touchedTargets = [...new Set([...changeSet.touchedTargets, ...integration.touchedTargets])].sort();
  prepared.ready = changeSet.ready && integration.ready && prepared.dependencyBlockers.length === 0;
  return prepared;
}

/**
 * Apply the trusted in-process planner's output after the caller approves it.
 * All checks and transformations use immutable snapshots. Rejection returns no
 * partial result; unrelated destination changes made after review are preserved.
 * This API is not an authorization boundary for an untrusted serialized plan.
 */
export function applyPreparedTransplant(
  prepared: PreparedTransplant,
  sourceSnapshots: FileSnapshot[],
  destinationSnapshots: FileSnapshot[],
): AppliedTransplant {
  if (!prepared.ready || !prepared.changeSet || !prepared.integration.ready
    || prepared.dependencyBlockers.length) {
    throw new TransplantError('prepared transplant is not ready for application');
  }
  const source = indexSnapshots(sourceSnapshots, 'source');
  const destination = indexSnapshots(destinationSnapshots, 'destination');
  assertUnchanged(prepared.reviewedInputs.source, source, 'source');
  assertUnchanged(prepared.reviewedInputs.destination, destination, 'destination');

  const integrated = applyIntegrationPlan(prepared.integration, destinationSnapshots);
  const materialized = materializeChangeSet(prepared.changeSet, sourceSnapshots, integrated);
  const updatedPaths = new Set(prepared.integration.touchedTargets);
  return {
    ...materialized,
    preserved: materialized.preserved.filter(path => !updatedPaths.has(path)),
    updated: prepared.integration.patches.map(patch => ({ ...patch })),
  };
}
