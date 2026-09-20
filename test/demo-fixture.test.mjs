import assert from 'node:assert/strict';
import test from 'node:test';
import { runDemoTransplant } from '../demo/graft-fixture.mjs';

test('real demo fixtures produce a reviewable, adapter-rewritten transplant without mutating destination files', async () => {
  const { prepared, destinationSnapshots, applied } = await runDemoTransplant();

  assert.equal(prepared.ready, true);
  assert.deepEqual(prepared.analysis.closure?.files, [
    'features/upload/service.ts',
    'features/upload/types.ts',
  ]);
  assert.deepEqual(prepared.changeSet?.touchedTargets, [
    'features/upload/service.ts',
    'features/upload/types.ts',
  ]);
  assert.deepEqual(
    prepared.changeSet?.bindings.map(binding => [binding.sourceCapability, binding.destinationModule]),
    [
      ['jobs', 'platform/task-runner.ts'],
      ['storage', 'platform/blob-store.ts'],
    ],
  );

  const service = applied.created.find(file => file.path === 'features/upload/service.ts');
  const types = applied.created.find(file => file.path === 'features/upload/types.ts');
  assert.ok(service);
  assert.ok(types);
  assert.match(service.content, /\.\.\/\.\.\/platform\/task-runner\.js/u);
  assert.match(service.content, /\.\.\/\.\.\/platform\/blob-store\.js/u);
  assert.match(types.content, /\.\.\/\.\.\/platform\/task-runner\.js/u);

  assert.equal(applied.created.length, 2);
  assert.deepEqual(applied.preserved, destinationSnapshots.map(file => file.path).sort());
  for (const before of destinationSnapshots) {
    assert.equal(applied.result.find(file => file.path === before.path)?.content, before.content);
  }
});
