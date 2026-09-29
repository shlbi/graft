/**
 * @file Core Repot transfer-engine module for pipeline. This deterministic layer plans or materializes repository changes.
 *
 * Engine invariant: identical snapshots and options should produce identical results.
 */
import { analyzeFeatureClosure, type FeatureClosure } from './analyzer.js';
import { parseTypeScriptModules, type ImportParseBlocker, type TypeScriptSnapshot } from './imports.js';
import type { FeatureManifest } from './manifest.js';

export interface SourceAnalysis {
  closure: FeatureClosure | null;
  parseBlockers: ImportParseBlocker[];
  ready: boolean;
}

/** Parse real TypeScript snapshots first; never compute a closure from an incomplete graph. */
/**
 * @function analyzeTypeScriptFeature
 * Implements analyze type script feature within the deterministic transfer engine.
 * Reviewability: preserve explicit inputs, stable ordering, and auditable outputs.
 */
export function analyzeTypeScriptFeature(feature: FeatureManifest, snapshots: TypeScriptSnapshot[]): SourceAnalysis {
  const graph = parseTypeScriptModules(snapshots);
  if (!graph.ready) return { closure: null, parseBlockers: graph.blockers, ready: false };
  const closure = analyzeFeatureClosure(feature, graph.modules);
  return { closure, parseBlockers: [], ready: closure.ready };
}
