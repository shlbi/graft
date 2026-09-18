import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatureManifest } from '../dist/manifest.js';
import { planTransplant } from '../dist/planner.js';
import { InventoryError, parseDestinationInventory } from '../dist/inventory.js';

const manifest = () => parseFeatureManifest({
  schemaVersion: 1,
  name: 'upload-jobs',
  entrypoints: [{ path: 'features/upload/index.ts', role: 'shared' }],
  capabilities: [
    { name: 'blob-store', kind: 'storage', contract: 'graft.storage.v1', module: 'features/upload/storage.ts' },
    { name: 'job-runner', kind: 'jobs', contract: 'graft.jobs.v1', module: 'features/upload/jobs.ts' },
  ],
  assets: [],
  environment: [],
});

test('destination inventory feeds explicit adapter contracts into the planner', () => {
  const inventory = parseDestinationInventory({
    schemaVersion: 1,
    capabilities: [
      { name: 'worker', kind: 'jobs', contract: 'graft.jobs.v1', module: 'infra/worker.ts' },
      { name: 'uploads', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/storage.ts' },
    ],
  });

  assert.deepEqual(inventory.capabilities.map(capability => capability.name), ['uploads', 'worker']);
  const plan = planTransplant(manifest(), inventory.capabilities);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.mappings.map(mapping => [mapping.source, mapping.destination]), [
    ['blob-store', 'uploads'],
    ['job-runner', 'worker'],
  ]);
});

test('destination inventory rejects undeclared fields, secret paths, and duplicate names', () => {
  assert.throws(() => parseDestinationInventory({ schemaVersion: 1, capabilities: [], guess: true }), InventoryError);
  assert.throws(() => parseDestinationInventory({
    schemaVersion: 1,
    capabilities: [{ name: 'storage', kind: 'storage', contract: 'graft.storage.v1', module: '.env' }],
  }), /secret files are excluded/);
  assert.throws(() => parseDestinationInventory({
    schemaVersion: 1,
    capabilities: [
      { name: 'storage', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/a.ts' },
      { name: 'storage', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/b.ts' },
    ],
  }), InventoryError);
});
