import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDemoWorkspace } from '../demo/workspace.mjs';

const baseline = [
  { path: 'app.ts', content: "export const baseline = true;\n" },
  { path: 'platform/blob.ts', content: 'export const storage = true;\n' },
];

test('isolated demo workspace applies a materialized snapshot and cleanly resets to baseline', async () => {
  const workspace = await createDemoWorkspace(baseline);
  try {
    assert.equal(await workspace.read('app.ts'), baseline[0].content);
    await workspace.apply([
      ...baseline,
      { path: 'features/upload/service.ts', content: 'export const transplanted = true;\n' },
    ]);
    assert.equal(await workspace.read('features/upload/service.ts'), 'export const transplanted = true;\n');

    await workspace.reset();
    assert.equal(await workspace.read('app.ts'), baseline[0].content);
    await assert.rejects(access(join(workspace.root, 'features/upload/service.ts')));
  } finally {
    await workspace.close();
  }
});

test('workspace rejects traversal and duplicate snapshot paths before writing', async () => {
  await assert.rejects(createDemoWorkspace([{ path: '../escape.ts', content: 'nope' }]), /unsafe snapshot path/u);
  await assert.rejects(
    createDemoWorkspace([
      { path: 'same.ts', content: 'one' },
      { path: 'same.ts', content: 'two' },
    ]),
    /duplicate snapshot path/u,
  );
});

test('invalid apply preserves the existing workspace instead of deleting it first', async () => {
  const workspace = await createDemoWorkspace(baseline);
  try {
    for (const invalid of [
      [{ path: '../escape.ts', content: 'bad' }],
      [{ path: 'same.ts', content: 'one' }, { path: 'same.ts', content: 'two' }],
      [{ path: 'directory', content: 'file' }, { path: 'directory/child.ts', content: 'child' }],
      [{ path: 'bad.ts', content: null }],
      [{ path: 'bad\0.ts', content: 'bad' }],
    ]) {
      await assert.rejects(workspace.apply(invalid));
      assert.equal(await workspace.read('app.ts'), baseline[0].content);
      assert.equal(await workspace.read('platform/blob.ts'), baseline[1].content);
    }
  } finally {
    await workspace.close();
  }
});

test('queued apply and reset are serialized; caller mutations cannot change the captured input', async () => {
  const original = structuredClone(baseline);
  const workspace = await createDemoWorkspace(original);
  try {
    original[0].content = 'changed after creation';
    const candidate = [{ path: 'app.ts', content: 'candidate' }];
    const applied = workspace.apply(candidate);
    candidate[0].content = 'changed after apply call';
    await applied;
    assert.equal(await workspace.read('app.ts'), 'candidate');
    await Promise.all([workspace.apply(candidate), workspace.reset()]);
    assert.equal(await workspace.read('app.ts'), baseline[0].content);
  } finally {
    await workspace.close();
  }
});

test('close waits for pending work and rejects subsequent workspace operations', async () => {
  const workspace = await createDemoWorkspace(baseline);
  const applied = workspace.apply([{ path: 'app.ts', content: 'pending' }]);
  await Promise.all([applied, workspace.close(), workspace.close()]);
  await assert.rejects(access(workspace.root));
  await assert.rejects(workspace.read('app.ts'), /closed/u);
  await assert.rejects(workspace.reset(), /closed/u);
  await assert.rejects(workspace.apply(baseline), /closed/u);
});
