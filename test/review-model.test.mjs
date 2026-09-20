import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDemoReview } from '../demo/review-model.mjs';

test('demo review serializes real dependency, mapping, copy and integration evidence', async () => {
  const review = await buildDemoReview();
  assert.equal(review.ready, true);
  assert.deepEqual(review.dependencies.files, [
    'features/upload/service.ts',
    'features/upload/types.ts',
  ]);
  assert.deepEqual(review.dependencies.adapterBoundaries, ['adapters/jobs.ts', 'adapters/storage.ts']);
  assert.deepEqual(review.copies.map(item => item.targetPath), [
    'features/upload/service.ts',
    'features/upload/types.ts',
  ]);
  assert.deepEqual(review.mappings.map(item => [item.source, item.destination]), [
    ['jobs', 'task-runner'],
    ['storage', 'blob-store'],
  ]);
  assert.deepEqual(review.graph.edges.filter(edge => edge.kind === 'mapping').map(edge => edge.label), [
    'jobs → task-runner',
    'storage → blob-store',
  ]);
  assert.equal(review.graph.edges.some(edge => edge.kind === 'dependency'
    && edge.from === 'source:features/upload/service.ts'
    && edge.to === 'source:features/upload/types.ts'), true);
  assert.equal(review.graph.edges.filter(edge => edge.kind === 'boundary').length, 3);
  assert.equal(review.graph.edges.filter(edge => edge.kind === 'mount').length, 1);
  assert.equal(review.integrations.length, 1);
  assert.match(review.integrations[0].before, /graft:mount:upload-processing-progress/u);
  assert.match(review.integrations[0].after, /uploadAndProcess/u);
  assert.deepEqual(review.touchedTargets, [
    'entry.ts',
    'features/upload/service.ts',
    'features/upload/types.ts',
  ]);
  assert.deepEqual(review.blockers, { planning: [], changes: [], integration: [], dependencies: [] });
});
