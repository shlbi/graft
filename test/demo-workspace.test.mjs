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
