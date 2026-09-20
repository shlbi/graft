import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createReviewServer } from '../ui/server.mjs';

// A real HTTP/API verification run. No browser execution is claimed here.
// Session IDs and upload authorization tokens are intentionally not saved.
const sample = 'Graft moves behavior, not infrastructure.\nThe destination owns storage and processing.\nReview. Approve. Verify. Repeat.\n';
const app = createReviewServer({ port: 0 });
try {
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const reviewResponse = await fetch(`${base}/api/review`);
  assert.equal(reviewResponse.status, 200);
  const prepared = await reviewResponse.json();
  assert.equal(prepared.review.ready, true);
  const approvalResponse = await fetch(`${base}/api/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ reviewId: prepared.reviewId, approved: true }),
  });
  assert.equal(approvalResponse.status, 200);
  const approved = await approvalResponse.json();
  const token = approved.uploadDemo.token;
  const rejectedResponse = await fetch(`${base}/api/demo-upload?name=invalid.txt`, {
    method: 'POST', headers: { 'x-graft-upload-token': token }, body: Buffer.from([255]),
  });
  assert.equal(rejectedResponse.status, 415);
  const uploadResponse = await fetch(`${base}/api/demo-upload?name=graft-proof.txt`, {
    method: 'POST', headers: { 'x-graft-upload-token': token, 'content-type': 'text/plain; charset=utf-8' }, body: sample,
  });
  assert.equal(uploadResponse.status, 202);
  const accepted = await uploadResponse.json();
  assert.equal(accepted.state, 'queued');
  let completed;
  for (let attempt = 0; attempt < 100; attempt++) {
    const poll = await fetch(`${base}${accepted.poll}`, { headers: { 'x-graft-upload-token': token } });
    assert.equal(poll.status, 200);
    const job = await poll.json();
    if (job.state === 'complete') { completed = job; break; }
    if (job.state === 'failed') throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(completed, 'accepted upload must complete');
  assert.equal(completed.result.fileId, 'blob-1');
  assert.equal(completed.result.progress.at(-1).metrics.bytes, Buffer.byteLength(sample));
  const replay = await fetch(`${base}/api/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reviewId: prepared.reviewId, approved: true }),
  });
  assert.equal(replay.status, 404);
  const { token: _token, ...uploadMetadata } = approved.uploadDemo;
  const report = {
    schemaVersion: 1, recordedAt: new Date().toISOString(), runtime: process.version,
    evidence: 'Actual localhost HTTP/API execution. Not a live-browser test.',
    statuses: { review: 200, approval: 200, invalidUtf8: 415, upload: 202, completed: completed.state, replay: 404 },
    sample, review: prepared.review,
    approval: { applied: approved.applied, verification: approved.verification, uploadDemo: uploadMetadata },
    accepted, completed,
  };
  const destination = new URL('../docs/verification/release-http-session.json', import.meta.url);
  await mkdir(new URL('../docs/verification/', import.meta.url), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(`Verified HTTP session saved: ${fileURLToPath(destination)}`);
  console.log(JSON.stringify(report.statuses));
} finally { await app.close(); }
