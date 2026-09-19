import { analyzeFeatureClosure, type FeatureClosure } from './analyzer.js';
import { parseTypeScriptModules, type ImportParseBlocker, type TypeScriptSnapshot } from './imports.js';
import type { FeatureManifest } from './manifest.js';

export interface SourceAnalysis {
  closure: FeatureClosure | null;
  parseBlockers: ImportParseBlocker[];
  ready: boolean;
}

/** Parse real TypeScript snapshots first; never compute a closure from an incomplete graph. */
export function analyzeTypeScriptFeature(feature: FeatureManifest, snapshots: TypeScriptSnapshot[]): SourceAnalysis {
  const graph = parseTypeScriptModules(snapshots);
  if (!graph.ready) return { closure: null, parseBlockers: graph.blockers, ready: false };
  const closure = analyzeFeatureClosure(feature, graph.modules);
  return { closure, parseBlockers: [], ready: closure.ready };
}
