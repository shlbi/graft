import assert from 'node:assert/strict';
import test from 'node:test';
import { runHttpTransplantDemo } from '../demo/http-transplant.mjs';
import { createUploadHttpServer } from '../demo/upload-server.mjs';

async function waitForJob(base, pollPath) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}${pollPath}`);
    assert.equal(response.status, 200);
    const job = await response.json();
    if (job.state === 'complete' || job.state === 'failed') return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('job did not reach a terminal state');
}

test('bounded HTTP upload transport queues real request bytes and exposes pollable job state', async () => {
  const calls = [];
  const app = createUploadHttpServer({
    maxUploadBytes: 64,
    uploadAndProcess: async (name, content) => {
      calls.push({ name, content });
      await new Promise(resolve => setTimeout(resolve, 10));
      return { fileId: 'fixture-1', name, progress: [{ progress: 100, stage: 'complete' }] };
    },
  });
  const address = await app.listen();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/upload?name=notes.txt`, { method: 'POST', body: 'hello graft' });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.state, 'queued');
    assert.match(accepted.poll, /^\/api\/jobs\//u);
    const job = await waitForJob(base, accepted.poll);
    assert.equal(job.state, 'complete');
    assert.equal(job.result.fileId, 'fixture-1');
    assert.deepEqual(calls, [{ name: 'notes.txt', content: 'hello graft' }]);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.activeJobs, 0);
    assert.equal(healthBody.queuedJobs, 0);
    assert.equal(healthBody.retainedJobs, 1);

    const traversal = await fetch(`${base}/api/upload?name=${encodeURIComponent('../secret.txt')}`, { method: 'POST', body: 'x' });
    assert.equal(traversal.status, 400);
    const tooLarge = await fetch(`${base}/api/upload?name=big.txt`, { method: 'POST', body: 'x'.repeat(65) });
    assert.equal(tooLarge.status, 413);
  } finally {
    await app.close();
  }
});

test('real HTTP request is queued then reaches the compiled transplanted destination feature', async () => {
  const report = await runHttpTransplantDemo();
  assert.equal(report.observed.status, 202);
  assert.equal(report.observed.job.state, 'complete');
  assert.equal(report.observed.result.fileId, 'blob-1');
  assert.deepEqual(report.observed.result.progress.map(item => item.progress), [0, 50, 90, 100]);
  const completed = report.observed.result.progress.at(-1);
  assert.equal(completed.metrics.bytes, report.observed.bytes);
  assert.equal(completed.metrics.lines, 2);
  assert.match(completed.metrics.checksum, /^[0-9a-f]{8}$/u);
  assert.equal(report.review.created.includes('features/upload/service.ts'), true);
  assert.match(report.transport, /job queue with polling/u);
});
