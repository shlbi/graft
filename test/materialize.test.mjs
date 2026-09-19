import test from 'node:test';
import assert from 'node:assert/strict';
import { MaterializationError, materializeChangeSet } from '../dist/materialize.js';

const changeSet = {
  feature: 'upload-jobs',
  operations: [
    { kind: 'copy', sourcePath: 'features/upload/index.ts', targetPath: 'features/upload/index.ts', sourceKind: 'module' },
    { kind: 'copy', sourcePath: 'features/upload/schema.sql', targetPath: 'features/upload/schema.sql', sourceKind: 'asset' },
  ],
  bindings: [], blockers: [], touchedTargets: ['features/upload/index.ts', 'features/upload/schema.sql'], ready: true,
};

test('materializes reviewed copies without changing existing destination snapshots', () => {
  const result = materializeChangeSet(changeSet, [
    { path: 'features/upload/index.ts', content: 'export const upload = true;' },
    { path: 'features/upload/schema.sql', content: 'create table uploads(id text);' },
  ], [{ path: 'src/existing.ts', content: 'export const existing = true;' }]);
  assert.deepEqual(result.preserved, ['src/existing.ts']);
  assert.deepEqual(result.created.map(file => [file.path, file.sourceKind]), [
    ['features/upload/index.ts', 'module'],
    ['features/upload/schema.sql', 'asset'],
  ]);
  assert.equal(result.result.find(file => file.path === 'src/existing.ts')?.content, 'export const existing = true;');
});

test('materializer refuses missing sources, destination overwrites, and duplicate operations', () => {
  assert.throws(() => materializeChangeSet(changeSet, [], []), /missing source snapshot/);
  assert.throws(() => materializeChangeSet(changeSet,
    [{ path: 'features/upload/index.ts', content: 'x' }, { path: 'features/upload/schema.sql', content: 'y' }],
    [{ path: 'features/upload/index.ts', content: 'existing' }]), /refusing to overwrite/);
  assert.throws(() => materializeChangeSet({ ...changeSet, operations: [changeSet.operations[0], changeSet.operations[0]] },
    [{ path: 'features/upload/index.ts', content: 'x' }], []), MaterializationError);
});
