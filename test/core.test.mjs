import test from 'node:test';
import assert from 'node:assert/strict';
import { ManifestError, parseFeatureManifest, projectPath } from '../dist/manifest.js';
import { PlanError, planTransplant } from '../dist/planner.js';
import { AnalysisError, analyzeFeatureClosure } from '../dist/analyzer.js';

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

test('feature analysis stops at adapter boundaries and collects package roots', () => {
  const result = analyzeFeatureClosure(manifest(), [
    { path: 'features/upload/index.ts', imports: [
      { kind: 'internal', path: 'features/upload/service.ts' },
      { kind: 'package', package: '@tanstack/react-query/build/modern' },
    ] },
    { path: 'features/upload/service.ts', imports: [
      { kind: 'internal', path: 'features/upload/storage.ts' },
      { kind: 'internal', path: 'features/upload/jobs.ts' },
      { kind: 'package', package: 'zod/v4' },
    ] },
    { path: 'features/upload/storage.ts', imports: [{ kind: 'internal', path: 'secrets/never-copy.ts' }] },
    { path: 'features/upload/jobs.ts', imports: [] },
    { path: 'secrets/never-copy.ts', imports: [] },
  ]);
  assert.deepEqual(result, {
    files: ['features/upload/index.ts', 'features/upload/service.ts'],
    boundaryModules: ['features/upload/jobs.ts', 'features/upload/storage.ts'],
    packages: ['@tanstack/react-query', 'zod'],
    blockers: [],
    ready: true,
  });
});

test('feature analysis reports missing internal modules and rejects duplicate snapshots', () => {
  const missing = analyzeFeatureClosure(manifest(), [
    { path: 'features/upload/index.ts', imports: [{ kind: 'internal', path: 'features/upload/missing.ts' }] },
  ]);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.blockers, [
    { from: 'features/upload/index.ts', path: 'features/upload/missing.ts', reason: 'missing-module' },
  ]);
  assert.throws(() => analyzeFeatureClosure(manifest(), [
    { path: 'features/upload/index.ts', imports: [] },
    { path: 'features/upload/index.ts', imports: [] },
  ]), AnalysisError);
});
