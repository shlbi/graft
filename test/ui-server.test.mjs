import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewServer } from '../ui/server.mjs';

test('localhost review server gates apply, verifies, then serves the approved transplanted upload runtime', async () => {
  const app = createReviewServer({ host: '127.0.0.1', port: 0 });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Feature Transplant Review/u);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/u);

    const reviewResponse = await fetch(`${base}/api/review`);
    assert.equal(reviewResponse.status, 200);
    const reviewPayload = await reviewResponse.json();
    assert.equal(reviewPayload.review.ready, true);
    assert.equal(typeof reviewPayload.reviewId, 'string');
    assert.ok(reviewPayload.reviewId.length > 16);

    const denied = await fetch(`${base}/api/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId: reviewPayload.reviewId, approved: false }),
    });
    assert.equal(denied.status, 400);

    const unknown = await fetch(`${base}/api/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId: 'not-a-real-review', approved: true }),
    });
    assert.equal(unknown.status, 404);

    const approved = await fetch(`${base}/api/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ reviewId: reviewPayload.reviewId, approved: true }),
    });
    assert.equal(approved.status, 200);
    const result = await approved.json();
    assert.deepEqual(result.applied.created, ['features/upload/service.ts', 'features/upload/types.ts']);
    assert.deepEqual(result.applied.updated, ['entry.ts']);
    assert.equal(result.verification.runs[0].after.hasUploadFeature, true);
    assert.equal(result.verification.runs[0].after.result.fileId, 'blob-1');
    assert.deepEqual(result.verification.runs[0].after.result.progress.map(item => item.progress), [0, 50, 90, 100]);
    assert.equal(result.verification.runs[0].cleanReset, true);
    assert.equal(typeof result.uploadDemo.token, 'string');
    assert.ok(result.uploadDemo.token.length > 16);

    const unauthorizedUpload = await fetch(`${base}/api/demo-upload?name=proof.txt`, {
      method: 'POST', body: 'not approved for this runtime',
    });
    assert.equal(unauthorizedUpload.status, 403);

    const uploadPayload = 'browser review proof\nactual bytes reach the destination processor';
    const uploaded = await fetch(`${base}/api/demo-upload?name=browser-proof.txt`, {
      method: 'POST',
      headers: { 'x-graft-upload-token': result.uploadDemo.token, origin: base, 'content-type': 'text/plain' },
      body: uploadPayload,
    });
    assert.equal(uploaded.status, 201);
    const upload = await uploaded.json();
    assert.equal(upload.result.fileId, 'blob-1');
    assert.equal(upload.size, Buffer.byteLength(uploadPayload));
    assert.deepEqual(upload.result.progress.map(item => item.progress), [0, 50, 90, 100]);
    assert.equal(upload.result.progress.at(-1).metrics.bytes, Buffer.byteLength(uploadPayload));
    assert.equal(upload.result.progress.at(-1).metrics.lines, 2);

    const replay = await fetch(`${base}/api/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId: reviewPayload.reviewId, approved: true }),
    });
    assert.equal(replay.status, 404, 'consumed review IDs are pruned and cannot be replayed');
  } finally {
    await app.close();
  }
});
