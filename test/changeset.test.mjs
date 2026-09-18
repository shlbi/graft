import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatureManifest } from '../dist/manifest.js';
import { analyzeFeatureClosure } from '../dist/analyzer.js';
import { planTransplant } from '../dist/planner.js';
import { ChangeSetError, buildReviewableChangeSet } from '../dist/changeset.js';

const feature = parseFeatureManifest({
  schemaVersion: 1,
  name: 'upload-jobs',
  entrypoints: [{ path: 'features/upload/index.ts', role: 'shared' }],
  capabilities: [
    { name: 'blob-store', kind: 'storage', contract: 'graft.storage.v1', module: 'features/upload/storage.ts' },
    { name: 'job-runner', kind: 'jobs', contract: 'graft.jobs.v1', module: 'features/upload/jobs.ts' },
  ],
  assets: [{ path: 'features/upload/schema.sql', kind: 'schema' }],
  environment: [],
});

const closure = analyzeFeatureClosure(feature, [
  { path: 'features/upload/index.ts', imports: [{ kind: 'internal', path: 'features/upload/service.ts' }] },
  { path: 'features/upload/service.ts', imports: [
    { kind: 'internal', path: 'features/upload/storage.ts' },
    { kind: 'internal', path: 'features/upload/jobs.ts' },
  ] },
]);

const plan = planTransplant(feature, [
  { name: 'uploads', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/storage.ts' },
  { name: 'worker', kind: 'jobs', contract: 'graft.jobs.v1', module: 'infra/worker.ts' },
]);

test('reviewable change set enumerates module and asset copies without hidden writes', () => {
  const changeSet = buildReviewableChangeSet(feature, closure, plan, ['src/existing.ts']);
  assert.equal(changeSet.ready, true);
  assert.deepEqual(changeSet.touchedTargets, [
    'features/upload/index.ts',
    'features/upload/schema.sql',
    'features/upload/service.ts',
  ]);
  assert.deepEqual(changeSet.operations.map(operation => operation.sourceKind), ['module', 'asset', 'module']);
  assert.deepEqual(changeSet.bindings.map(binding => [binding.sourceCapability, binding.destinationModule]), [
    ['blob-store', 'infra/storage.ts'],
    ['job-runner', 'infra/worker.ts'],
  ]);
});

test('reviewable change set blocks destination collisions and unresolved analysis', () => {
  const collision = buildReviewableChangeSet(feature, closure, plan, ['features/upload/service.ts']);
  assert.equal(collision.ready, false);
  assert.deepEqual(collision.blockers, [{ targetPath: 'features/upload/service.ts', reason: 'target-exists' }]);
  assert.throws(() => buildReviewableChangeSet(feature, { ...closure, ready: false }, plan, []), ChangeSetError);
});
