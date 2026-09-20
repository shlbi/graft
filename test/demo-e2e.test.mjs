import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDemo } from '../demo/verify.mjs';

test('compiles source, baseline and transplanted destination, then resets and repeats using destination adapters', { timeout: 90_000 }, async () => {
  const report = await verifyDemo({ cycles: 2 });
  assert.equal(report.source.result.fileId, 'upload-1');
  assert.equal(report.before.hasUploadFeature, false);
  assert.equal(report.runs.length, 2);
  assert.deepEqual(report.review.touchedTargets, ['entry.ts', 'features/upload/service.ts', 'features/upload/types.ts']);
  for (const run of report.runs) {
    assert.equal(run.compiled, true);
    assert.equal(run.cleanReset, true);
    assert.equal(run.after.result.fileId, 'blob-1');
    assert.equal(run.reset.hasUploadFeature, false);
  }
});

test('bounds repeated verification work before creating a workspace', async () => {
  for (const cycles of [0, 4, 1.5, NaN, '2']) {
    await assert.rejects(verifyDemo({ cycles }), /cycles must be/u);
  }
});
