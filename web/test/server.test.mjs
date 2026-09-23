import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { demoInput } from '../lib/demo.mjs';
async function withServer(options, fn) {
  const server = createApp(options); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; }
}
const payload = { source: { kind: 'folder', snapshot: demoInput.source }, destination: { kind: 'folder', snapshot: demoInput.destination }, feature: 'CSV export', useAI: false, consent: false };
const post = (base, path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
test('web shell, styles and modules serve from exact routes with restrictive CSP', async () => withServer({}, async base => {
  for (const route of ['/', '/app.mjs', '/style.css', '/policy.mjs']) {
    const r = await fetch(base + route); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok((await r.text()).length > 20);
  }
  assert.equal((await fetch(base + '/server.mjs')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
}));
test('discovery returns actual file matches and no unrequested AI calls', async () => {
  let calls = 0;
  await withServer({ apiKey: 'test-placeholder', model: 'test-model', aiProvider: async () => { calls++; } }, async base => {
    const r = await post(base, '/api/analyze', payload); assert.equal(r.status, 200);
    const result = await r.json(); assert.equal(result.mode, 'discovery'); assert.equal(result.review, null);
    assert.ok(result.analysis.candidates.some(x => x.path === 'src/csv.mjs')); assert.equal(result.analysis.context, undefined);
  }); assert.equal(calls, 0);
});
test('demo produces a real downloadable patch but identifies itself as authored', async () => withServer({}, async base => {
  const r = await post(base, '/api/demo', {}); assert.equal(r.status, 200);
  const data = await r.json(); assert.equal(data.mode, 'synthetic-demo'); assert.match(data.review.patch, /diff --git/); assert.equal(data.review.verification.build, 'not_run');
}));
test('foreign Host and Origin denied before intake', async () => withServer({}, async base => {
  assert.equal((await post(base, '/api/analyze', payload, { origin: 'https://evil.example' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/analyze', { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
  assert.equal(status, 403);
}));
test('malformed JSON, invalid feature and unsupported content types return actionable errors', async () => withServer({}, async base => {
  assert.equal((await fetch(base + '/api/analyze', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await post(base, '/api/analyze', { ...payload, feature: '' })).status, 400);
}));
test('unconfigured or unconsented AI never starts repository intake', async () => {
  let calls = 0;
  await withServer({ repositoryReader: async () => calls++ }, async base => {
    assert.equal((await post(base, '/api/analyze', { ...payload, useAI: true, consent: true })).status, 503);
    assert.equal((await post(base, '/api/analyze', { ...payload, useAI: true, consent: false })).status, 403);
  }); assert.equal(calls, 0);
});
test('server forwards abort when an active client disconnects', async () => {
  let start, stopped; const began = new Promise(r => start = r), aborted = new Promise(r => stopped = r);
  await withServer({ repositoryReader: async (_url, _feature, { signal }) => {
    start(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => { stopped(); reject(signal.reason); }, { once: true }));
  } }, async base => {
    const c = new AbortController();
    const pending = fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, source: { kind: 'github', url: 'owner/repo' } }), signal: c.signal }).catch(e => e);
    await began; c.abort(); await pending;
    await Promise.race([aborted, new Promise((_, reject) => { const id = setTimeout(() => reject(new Error('Abort was not forwarded')), 1000); id.unref(); })]);
  });
});
test('non-object bodies are rejected without an internal failure', async () => withServer({}, async base => {
  for (const value of [null, [], 'text']) assert.equal((await post(base, '/api/analyze', value)).status, 400);
}));
test('only two concurrent jobs are admitted; client cancellation frees the slots', async () => {
  let started = 0;
  await withServer({ repositoryReader: async (_url, _feature, { signal }) => {
    started++;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }, async base => {
    const controllers = [new AbortController(), new AbortController()];
    const body = JSON.stringify({ ...payload, source: { kind: 'github', url: 'owner/repo' } });
    const pending = controllers.map(c => fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: c.signal }).catch(e => e));
    for (let i = 0; i < 100 && started < 2; i++) await new Promise(r => setImmediate(r));
    assert.equal(started, 2);
    assert.equal((await post(base, '/api/analyze', payload)).status, 429);
    controllers.forEach(c => c.abort()); await Promise.all(pending);
  });
});
