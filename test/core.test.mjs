import test from 'node:test';
import assert from 'node:assert/strict';
import { ManifestError, parseFeatureManifest, projectPath } from '../dist/manifest.js';
import { PlanError, planTransplant } from '../dist/planner.js';

const manifest = () => parseFeatureManifest({
  schemaVersion: 1,
  name: 'upload-jobs',
  entrypoints: [{ path: 'features/upload/index.ts', role: 'shared' }],
  capabilities: [
    { name: 'blob-store', kind: 'storage', contract: 'graft.storage.v1', module: 'features/upload/storage.ts' },
    { name: 'job-runner', kind: 'jobs', contract: 'graft.jobs.v1', module: 'features/upload/jobs.ts' },
  ],
  assets: [{ path: 'features/upload/schema.sql', kind: 'schema' }],
  environment: ['UPLOAD_LIMIT_BYTES'],
});

test('manifest parser accepts declared boundaries and rejects secret/path traversal inputs', () => {
  assert.equal(manifest().name, 'upload-jobs');
  assert.equal(projectPath('features/upload/view.tsx'), 'features/upload/view.tsx');
  for (const unsafe of ['../secret.txt', '/etc/passwd', '.env', 'keys/service.pem', 'a//b']) {
    assert.throws(() => projectPath(unsafe), ManifestError);
  }
});

test('planner maps exact contracts deterministically', () => {
  const result = planTransplant(manifest(), [
    { name: 'uploads', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/storage.ts' },
    { name: 'worker', kind: 'jobs', contract: 'graft.jobs.v1', module: 'infra/jobs.ts' },
  ]);
  assert.equal(result.ready, true);
  assert.deepEqual(result.mappings.map(({ source, destination, reason }) => ({ source, destination, reason })), [
    { source: 'blob-store', destination: 'uploads', reason: 'exact-contract' },
    { source: 'job-runner', destination: 'worker', reason: 'exact-contract' },
  ]);
});

test('planner blocks missing/ambiguous capabilities instead of guessing', () => {
  const result = planTransplant(manifest(), [
    { name: 'uploads-a', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/a.ts' },
    { name: 'uploads-b', kind: 'storage', contract: 'graft.storage.v1', module: 'infra/b.ts' },
  ]);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, [
    { source: 'blob-store', kind: 'storage', reason: 'ambiguous-capability', candidates: ['uploads-a', 'uploads-b'] },
    { source: 'job-runner', kind: 'jobs', reason: 'missing-capability', candidates: [] },
  ]);
});

test('explicit overrides must preserve kind and contract and destination names stay unique', () => {
  assert.throws(() => planTransplant(manifest(), [
    { name: 'same', kind: 'storage', contract: 'graft.storage.v1', module: 'a.ts' },
    { name: 'same', kind: 'jobs', contract: 'graft.jobs.v1', module: 'b.ts' },
  ]), PlanError);
  const invalid = planTransplant(manifest(), [
    { name: 'worker', kind: 'jobs', contract: 'wrong', module: 'infra/jobs.ts' },
  ], [{ source: 'job-runner', destination: 'worker' }]);
  assert.equal(invalid.ready, false);
  assert.equal(invalid.blockers.find(b => b.source === 'job-runner')?.reason, 'invalid-override');
});
