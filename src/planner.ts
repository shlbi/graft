import type { CapabilityKind, FeatureManifest } from './manifest.js';

export interface DestinationCapability {
  name: string;
  kind: CapabilityKind;
  contract: string;
  module: string;
}
export interface MappingOverride {
  source: string;
  destination: string;
}
export interface PlannedMapping {
  source: string;
  destination: string;
  kind: CapabilityKind;
  reason: 'explicit' | 'exact-contract';
}
export interface PlanBlocker {
  source: string;
  kind: CapabilityKind;
  reason: 'missing-capability' | 'ambiguous-capability' | 'invalid-override';
  candidates: string[];
}
export interface TransplantPlan {
  feature: string;
  mappings: PlannedMapping[];
  blockers: PlanBlocker[];
  ready: boolean;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

/**
 * Plans only declared adapter boundaries. Graft refuses to guess when a
 * destination has zero or multiple contract-compatible capabilities.
 */
export function planTransplant(
  feature: FeatureManifest,
  destination: DestinationCapability[],
  overrides: MappingOverride[] = [],
): TransplantPlan {
  const duplicateDestinationNames = duplicates(destination.map(item => item.name));
  if (duplicateDestinationNames.length) {
    throw new PlanError(`duplicate destination capability names: ${duplicateDestinationNames.join(', ')}`);
  }
  const duplicateOverrides = duplicates(overrides.map(item => item.source));
  if (duplicateOverrides.length) {
    throw new PlanError(`multiple overrides for source capabilities: ${duplicateOverrides.join(', ')}`);
  }

  const mappings: PlannedMapping[] = [];
  const blockers: PlanBlocker[] = [];
  const claimedDestinations = new Set<string>();

  for (const source of feature.capabilities) {
    const override = overrides.find(item => item.source === source.name);
    if (override) {
      const target = destination.find(item => item.name === override.destination);
      if (!target || target.kind !== source.kind || target.contract !== source.contract || claimedDestinations.has(target.name)) {
        blockers.push({
          source: source.name,
          kind: source.kind,
          reason: 'invalid-override',
          candidates: target ? [target.name] : [],
        });
        continue;
      }
      mappings.push({ source: source.name, destination: target.name, kind: source.kind, reason: 'explicit' });
      claimedDestinations.add(target.name);
      continue;
    }

    const candidates = destination.filter(item =>
      item.kind === source.kind &&
      item.contract === source.contract &&
      !claimedDestinations.has(item.name),
    );

    if (candidates.length === 1) {
      const target = candidates[0];
      mappings.push({ source: source.name, destination: target.name, kind: source.kind, reason: 'exact-contract' });
      claimedDestinations.add(target.name);
    } else {
      blockers.push({
        source: source.name,
        kind: source.kind,
        reason: candidates.length ? 'ambiguous-capability' : 'missing-capability',
        candidates: candidates.map(item => item.name).sort(),
      });
    }
  }

  const declaredSources = new Set(feature.capabilities.map(item => item.name));
  for (const override of overrides) {
    if (!declaredSources.has(override.source)) {
      blockers.push({ source: override.source, kind: 'events', reason: 'invalid-override', candidates: [] });
    }
  }

  return {
    feature: feature.name,
    mappings: mappings.sort((a, b) => a.source.localeCompare(b.source)),
    blockers: blockers.sort((a, b) => a.source.localeCompare(b.source)),
    ready: blockers.length === 0,
  };
}
