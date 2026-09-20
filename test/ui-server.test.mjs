import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewServer } from '../ui/server.mjs';

test('localhost review server requires one-time explicit approval and returns executable proof', async () => {
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
      method: 'POST', headers: { 'content-type': 'application/json' },
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

    const replay = await fetch(`${base}/api/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewId: reviewPayload.reviewId, approved: true }),
    });
    assert.equal(replay.status, 404, 'consumed review IDs are pruned and cannot be replayed');
  } finally {
    await app.close();
  }
});
