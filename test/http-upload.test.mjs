import assert from 'node:assert/strict';
import test from 'node:test';
import { runHttpTransplantDemo } from '../demo/http-transplant.mjs';
import { createUploadHttpServer } from '../demo/upload-server.mjs';

test('bounded HTTP upload transport passes real request bytes to its injected feature', async () => {
  const calls = [];
  const app = createUploadHttpServer({
    maxUploadBytes: 64,
    uploadAndProcess: async (name, content) => {
      calls.push({ name, content });
      return { fileId: 'fixture-1', name, progress: [{ progress: 100, stage: 'complete' }] };
    },
  });
  const address = await app.listen();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/upload?name=notes.txt`, { method: 'POST', body: 'hello graft' });
    assert.equal(response.status, 201);
    assert.deepEqual(calls, [{ name: 'notes.txt', content: 'hello graft' }]);
    assert.equal((await response.json()).size, 11);

    const traversal = await fetch(`${base}/api/upload?name=${encodeURIComponent('../secret.txt')}`, { method: 'POST', body: 'x' });
    assert.equal(traversal.status, 400);
    const tooLarge = await fetch(`${base}/api/upload?name=big.txt`, { method: 'POST', body: 'x'.repeat(65) });
    assert.equal(tooLarge.status, 413);
  } finally {
    await app.close();
  }
});

test('real HTTP request reaches the compiled transplanted destination feature', async () => {
  const report = await runHttpTransplantDemo();
  assert.equal(report.observed.status, 201);
  assert.equal(report.observed.result.fileId, 'blob-1');
  assert.deepEqual(report.observed.result.progress.map(item => item.progress), [0, 50, 90, 100]);
  assert.equal(report.review.created.includes('features/upload/service.ts'), true);
});
