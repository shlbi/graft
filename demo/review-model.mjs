import { parseTypeScriptModules } from '../dist/imports.js';
import { prepareDemoTransplant } from './graft-fixture.mjs';

function edgeKey(edge) {
  return `${edge.kind}:${edge.from}:${edge.to}`;
}

/**
 * Build a serializable, read-only review from the same trusted prepared object
 * used by the executable demo. This intentionally contains no apply authority.
 */
export function serializeDemoReview(fixture) {
  const { prepared } = fixture;
  const graph = parseTypeScriptModules(fixture.sourceSnapshots);
  const closure = prepared.analysis.closure;
  const changeSet = prepared.changeSet;

  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const addNode = node => {
    if (seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    nodes.push(node);
  };
  const addEdge = edge => edges.push(edge);

  if (closure) {
    for (const path of closure.files) addNode({ id: `source:${path}`, path, side: 'source', kind: 'feature' });
    for (const path of closure.boundaryModules) addNode({ id: `source:${path}`, path, side: 'source', kind: 'adapter-boundary' });
    for (const module of graph.modules) {
      if (!closure.files.includes(module.path)) continue;
      for (const ref of module.imports) {
        if (ref.kind !== 'internal') continue;
        const targetKind = closure.boundaryModules.includes(ref.path) ? 'adapter-boundary' : 'feature';
        if (targetKind === 'feature' && !closure.files.includes(ref.path)) continue;
        addNode({ id: `source:${ref.path}`, path: ref.path, side: 'source', kind: targetKind });
        addEdge({ kind: targetKind === 'adapter-boundary' ? 'boundary' : 'dependency', from: `source:${module.path}`, to: `source:${ref.path}` });
      }
    }
  }

  for (const capability of prepared.inventory.capabilities) {
    addNode({ id: `destination:${capability.module}`, path: capability.module, side: 'destination', kind: 'adapter' });
  }
  for (const mapping of prepared.plan?.mappings ?? []) {
    const sourceCapability = prepared.feature.capabilities.find(capability => capability.name === mapping.source);
    if (!sourceCapability) continue;
    addEdge({
      kind: 'mapping',
      from: `source:${sourceCapability.module}`,
      to: `destination:${mapping.destinationModule}`,
      label: `${mapping.source} → ${mapping.destination}`,
    });
  }
  for (const patch of prepared.integration.patches) {
    addNode({ id: `destination:${patch.targetPath}`, path: patch.targetPath, side: 'destination', kind: 'integration-target' });
    for (const entrypoint of prepared.feature.entrypoints) {
      addEdge({ kind: 'mount', from: `source:${entrypoint.path}`, to: `destination:${patch.targetPath}`, label: patch.id });
    }
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));

  return {
    schemaVersion: 1,
    feature: prepared.feature.name,
    ready: prepared.ready,
    scope: 'authored TypeScript demo; read-only review before approval; in-memory destination storage; bounded text processing',
    graph: { nodes, edges },
    dependencies: {
      files: closure?.files ?? [],
      adapterBoundaries: closure?.boundaryModules ?? [],
      packages: closure?.packages ?? [],
      blockers: [
        ...prepared.analysis.parseBlockers,
        ...(closure?.blockers ?? []),
      ],
    },
    mappings: (prepared.plan?.mappings ?? []).map(mapping => ({ ...mapping })),
    copies: (changeSet?.operations ?? []).map(operation => ({ ...operation })),
    bindings: (changeSet?.bindings ?? []).map(binding => ({ ...binding })),
    integrations: prepared.integration.patches.map(patch => ({
      id: patch.id,
      targetPath: patch.targetPath,
      marker: patch.marker,
      content: patch.content,
      before: patch.before,
      after: patch.after,
    })),
    touchedTargets: [...prepared.touchedTargets],
    blockers: {
      planning: prepared.plan?.blockers ?? [],
      changes: changeSet?.blockers ?? [],
      integration: prepared.integration.blockers,
      dependencies: prepared.dependencyBlockers,
    },
    limitations: [
      'Review approval is required before any apply operation or live upload runtime is provisioned.',
      'Browser upload becomes available only after approval; destination storage remains in-memory and progress checkpoints are synchronous, with no durable queue, database, or authentication claimed.',
      'Capability contract labels are narrow demo contracts, not proof of arbitrary framework compatibility.',
    ],
  };
}

export async function buildDemoReview() {
  return serializeDemoReview(await prepareDemoTransplant({ integrate: true }));
}
