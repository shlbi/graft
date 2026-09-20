import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareDemoTransplant, uploadFeature, destinationInventory } from '../demo/graft-fixture.mjs';
import { applyPreparedTransplant, prepareTransplant } from '../dist/transplant.js';

const mount = {
  id: 'upload-progress', targetPath: 'entry.ts',
  marker: '// graft:mount:upload-processing-progress',
  content: "import { uploadAndProcess } from './features/upload/service.js';\noutput = { ...baseline, hasUploadFeature: true, result: await uploadAndProcess('demo.txt', 'demo') };",
};
async function fixture(mounts = [mount]) {
  const { sourceSnapshots: source, destinationSnapshots: destination } = await prepareDemoTransplant();
  const prepared = prepareTransplant(uploadFeature, destinationInventory, source, destination, [], mounts);
  return { prepared, source, destination };
}

test('reviews copies and integration together, reports actual touched/preserved files, mutates no inputs', async () => {
  const { prepared, source, destination } = await fixture();
  const before = structuredClone({ source, destination });
  assert.equal(prepared.ready, true);
  assert.deepEqual(prepared.touchedTargets, ['entry.ts', 'features/upload/service.ts', 'features/upload/types.ts']);
  assert.equal(prepared.integration.patches[0].before, destination.find(file => file.path === 'entry.ts').content);
  const applied = applyPreparedTransplant(prepared, source, destination);
  assert.equal(applied.created.length, 2);
  assert.deepEqual(applied.updated.map(patch => patch.targetPath), ['entry.ts']);
  assert.deepEqual(applied.preserved, ['app.ts', 'platform/blob-store.ts', 'platform/task-runner.ts']);
  assert.match(applied.result.find(file => file.path === 'entry.ts').content, /await uploadAndProcess/u);
  assert.deepEqual({ source, destination }, before);
});

test('an invalid integration marker blocks the entire transplant, not just its integration edits', async () => {
  const { prepared, source, destination } = await fixture([{ ...mount, marker: '// absent' }]);
  assert.equal(prepared.changeSet.ready, true);
  assert.equal(prepared.ready, false);
  assert.equal(prepared.integration.blockers[0].reason, 'marker-missing');
  assert.throws(() => applyPreparedTransplant(prepared, source, destination), /not ready/u);
});

test('rejects stale source, integration targets, and destination adapters after review', async () => {
  const { prepared, source, destination } = await fixture();
  const changed = (files, path) => files.map(file => file.path === path ? { ...file, content: `${file.content}\n// changed` } : file);
  assert.throws(() => applyPreparedTransplant(prepared, changed(source, 'features/upload/service.ts'), destination), /source changed after review/u);
  for (const path of ['entry.ts', 'platform/blob-store.ts', 'platform/task-runner.ts']) {
    assert.throws(() => applyPreparedTransplant(prepared, source, changed(destination, path)), /destination changed after review/u);
  }
});

test('keeps unrelated edits made after review and refuses copies that now collide', async () => {
  const { prepared, source, destination } = await fixture();
  const actual = destination.map(file => file.path === 'app.ts' ? { ...file, content: `${file.content}// keep this edit\n` } : file);
  const applied = applyPreparedTransplant(prepared, source, actual);
  assert.equal(applied.result.find(file => file.path === 'app.ts').content, actual.find(file => file.path === 'app.ts').content);
  assert.throws(() => applyPreparedTransplant(prepared, source, [
    ...destination, { path: 'features/upload/service.ts', content: '// user file' },
  ]), /refusing to overwrite/u);
});

test('missing destination adapter modules prevent a ready plan', async () => {
  const { source, destination } = await fixture();
  const prepared = prepareTransplant(uploadFeature, destinationInventory, source, destination.filter(file => file.path !== 'platform/blob-store.ts'), [], [mount]);
  assert.equal(prepared.ready, false);
  assert.deepEqual(prepared.dependencyBlockers, [{ path: 'platform/blob-store.ts', reason: 'destination-adapter-missing' }]);
});

test('mount content containing JavaScript replacement metacharacters stays literal', async () => {
  const content = `const literal = "$& $' $\u0060 $$";`;
  const { prepared } = await fixture([{ ...mount, content }]);
  const patch = prepared.integration.patches[0];
  assert.equal(patch.after, patch.before.split(mount.marker).join(content));
});
