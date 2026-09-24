import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createConnectedApp } from '../server.mjs';
import { Store } from '../store.mjs';
import { sha256 } from '../security.mjs';
import { config, fakeGitHub, fixtureDraft, ids } from './fixtures.mjs';
async function harness(extra = {}) {
  let cfg = config(extra.env); const gh = fakeGitHub(cfg), store = new Store(':memory:', cfg.dataKey);
  const app = createConnectedApp({ config: cfg, store, github: gh.client, draft: extra.draft || fixtureDraft });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  // Use the configured canonical Host in real HTTP tests while the TCP server uses an ephemeral port.
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const sessions = {};
  function session(owner = '1') { return sessions[owner] ||= store.session({ id: Number(owner), login: owner === '1' ? 'alice' : 'bob' }, owner === '1' ? 'ghu_alice' : 'ghu_bob', 28800, cfg); }
  const request = async (path, { body, owner = '1', headers = {}, raw, method, auth = true } = {}) => {
    const s = auth ? session(owner) : null;
    return await new Promise((done, reject) => {
      const textBody = body !== undefined ? JSON.stringify(body) : raw;
      const req = http.request(base + path, { method: method || (textBody === undefined ? 'GET' : 'POST'), headers: {
        host: cfg.host, ...(auth ? { cookie: `graft-session=${s.sid}` } : {}),
        ...(textBody !== undefined ? { origin: cfg.origin, 'x-csrf-token': s?.csrf || '', 'content-type': 'application/json', 'content-length': Buffer.byteLength(textBody) } : {}), ...headers
      } }, response => {
        const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch { json = null; }
          const h = new Headers(); for (const [k, value] of Object.entries(response.headers)) for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) h.append(k, v);
          done({ res: { status: response.statusCode, headers: h }, json, text });
        });
      }); req.on('error', reject); req.setTimeout(10000, () => req.destroy(new Error('HTTP test timed out'))); req.end(textBody);
    });
  };
  const start = async () => { const r = await request('/api/jobs', { body: { sourceId: 10, destinationId: 20, feature: 'greeting', consentAI: true } }); assert.equal(r.res.status, 202, r.text); await Promise.allSettled([...app.service.pending]); return store.get('job', r.json.id, '1'); };
  const publish = job => request(`/api/jobs/${job.id}/publish`, { body: { digest: job.digest, acknowledgeUnverified: true, acknowledgeWorkflows: true } });
  return { app, cfg, gh, store, base, request, start, publish, session, close: () => app.close() };
}
test('real HTTP endpoints protect sessions and production metadata, serving real static assets', async () => {
  const h = await harness(); try {
    assert.equal((await h.request('/api/session', { auth: false })).res.status, 401);
    const auth = await h.request('/api/session'); assert.equal(auth.json.user.login, 'alice'); assert.equal(auth.json.verificationAvailable, false);
    assert.ok(!auth.text.includes('ghu_alice')); assert.ok(auth.res.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    const home = await h.request('/', { auth: false }); assert.equal(home.res.status, 200); assert.match(home.text, /Keep the feature/);
    assert.equal((await h.request('/api/session', { headers: { host: 'evil.example' } })).res.status, 403);
    const repos = await h.request('/api/repos'); assert.equal(repos.json.repositories.length, 2); assert.equal(repos.json.repositories[0].private, true);
  } finally { await h.close(); }
});
test('mutations reject absent/cross-site origin, CSRF forgery and unknown fields before work', async () => {
  const h = await harness(); try {
    const body = { sourceId: 10, destinationId: 20, feature: 'greeting', consentAI: true };
    for (const headers of [{ origin: '' }, { origin: 'https://evil.example' }, { 'x-csrf-token': '' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await h.request('/api/jobs', { body, headers })).res.status, 403);
    assert.equal((await h.request('/api/jobs', { body: { ...body, force: true } })).res.status, 400);
    assert.equal((await h.request('/api/jobs', { body: { ...body, consentAI: false } })).res.status, 403);
    assert.equal(h.gh.calls.length, 0);
  } finally { await h.close(); }
});
test('OAuth authorization uses state and PKCE; callback rotates session and rejects replay/cross-browser requests', async () => {
  const h = await harness(); try {
    const begin = await h.request('/auth/github', { auth: false }); assert.equal(begin.res.status, 302);
    const url = new URL(begin.res.headers.get('location')), state = url.searchParams.get('state');
    assert.equal(url.origin, 'https://github.com'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('code_challenge').length, 43);
    const before = h.session().sid;
    assert.equal((await h.request(`/auth/callback?state=${state}&code=abc`, { auth: false })).res.status, 403);
    const callback = await h.request(`/auth/callback?state=${state}&code=abc`, { headers: { cookie: `graft-oauth=${state}; graft-session=${before}` } });
    assert.equal(callback.res.status, 303, callback.text); const cookies = callback.res.headers.getSetCookie(); assert.ok(cookies.some(c => c.startsWith('graft-session=')));
    assert.equal(h.store.get('session', sha256(before)), null); assert.equal(h.store.get('oauth', sha256(state)), null);
    assert.equal((await h.request(`/auth/callback?state=${state}&code=abc`, { headers: { cookie: `graft-oauth=${state}` } })).res.status, 403);
    const exchange = h.gh.calls.find(c => c.path === '/login/oauth/access_token'); assert.equal(exchange.body.code_verifier.length, 43); assert.equal(exchange.options.redirect, 'error');
    assert.ok(!callback.text.includes('ghu_'));
  } finally { await h.close(); }
});
test('jobs persist reviewed bytes and owner-only access; publication makes exactly one draft PR and no main writes', async () => {
  const h = await harness(); try {
    const job = await h.start(); assert.equal(job.state, 'review_ready', job.message); assert.equal(job.verification.transferredTests, 'not_run');
    assert.equal((await h.request(`/api/jobs/${job.id}`, { owner: '2' })).res.status, 404);
    assert.equal((await h.request('/api/jobs', { owner: '2' })).json.jobs.length, 0);
    const r = await h.publish(job); assert.equal(r.res.status, 200, r.text); assert.equal(r.json.draft, true);
    assert.equal((await h.publish(job)).res.status, 200); assert.equal(h.gh.prs.length, 1);
    const writes = h.gh.calls.filter(c => c.method !== 'GET');
    assert.ok(writes.every(c => c.method === 'POST' && c.path.startsWith('/repos/demo/destination/')));
    assert.equal(writes.filter(c => c.path.endsWith('/git/refs')).length, 1); assert.ok(writes.find(c => c.path.endsWith('/git/refs')).body.ref.startsWith('refs/heads/graft/'));
    assert.deepEqual(writes.find(c => c.path.endsWith('/git/commits')).body.parents, [ids.base]);
    assert.equal(writes.find(c => c.path.endsWith('/git/trees')).body.base_tree, ids.tree);
    assert.match(writes.find(c => c.path.endsWith('/pulls')).body.body, /NOT been executed/);
    assert.equal(h.store.get('job', job.id, '1').state, 'delivered');
  } finally { await h.close(); }
});
test('stale destination, missing confirmations, tampered reviews and disabled writes prevent publication', async () => {
  const h = await harness(); try {
    const job = await h.start();
    assert.equal((await h.request(`/api/jobs/${job.id}/publish`, { body: { digest: job.digest, acknowledgeUnverified: true, acknowledgeWorkflows: false } })).res.status, 403);
    assert.equal((await h.request(`/api/jobs/${job.id}/publish`, { body: { digest: 'wrong', acknowledgeUnverified: true, acknowledgeWorkflows: true } })).res.status, 409);
    h.gh.state.head = 'e'.repeat(40); const r = await h.publish(job); assert.equal(r.res.status, 409); assert.equal(r.json.code, 'stale_base'); assert.equal(h.gh.branches.size, 0);
    assert.equal(h.gh.calls.filter(c => c.method === 'POST').length, 0);
  } finally { await h.close(); }
  const off = await harness({ env: { GRAFT_ENABLE_PR_WRITES: 'false' } }); try { const job = await off.start(); assert.equal((await off.publish(job)).res.status, 403); assert.equal(off.gh.branches.size, 0); } finally { await off.close(); }
});
for (const failure of ['losePRResponse', 'loseBranchResponse']) test(`retries reconcile ${failure} without duplicate branches, PRs or force updates`, async () => {
  const h = await harness(); try {
    const job = await h.start(); h.gh.state[failure] = true;
    assert.equal((await h.publish(job)).res.status, 502); assert.equal(h.store.get('job', job.id).state, 'delivery_uncertain');
    const retry = await h.publish(job); assert.equal(retry.res.status, 200, retry.text); assert.equal(h.gh.branches.size, 1); assert.equal(h.gh.prs.length, 1);
    assert.equal(h.gh.calls.filter(c => c.method === 'POST' && c.path.endsWith('/git/refs')).length, 1);
    assert.equal(h.gh.calls.filter(c => c.method === 'POST' && c.path.endsWith('/pulls')).length, 1);
  } finally { await h.close(); }
});
test('an externally edited delivery branch is preserved and never republished blindly', async () => {
  const h = await harness(); try {
    const job = await h.start(); h.gh.state.loseBranchResponse = true; await h.publish(job);
    h.gh.branches.set('graft/' + job.id, 'f'.repeat(40));
    const r = await h.publish(job); assert.equal(r.res.status, 409); assert.equal(r.json.code, 'branch_changed'); assert.equal(h.gh.branches.get('graft/' + job.id), 'f'.repeat(40)); assert.equal(h.gh.prs.length, 0);
  } finally { await h.close(); }
});
test('concurrent publish requests do not create two PRs', async () => {
  const h = await harness(); try {
    const job = await h.start(); const results = await Promise.all([h.publish(job), h.publish(job)]);
    assert.ok(results.some(r => r.res.status === 200)); assert.ok(results.every(r => [200, 409].includes(r.res.status))); assert.equal(h.gh.prs.length, 1);
  } finally { await h.close(); }
});
test('cancellation aborts ongoing provider work and prevents later results from becoming publishable', async () => {
  let entered; const ready = new Promise(r => entered = r);
  const h = await harness({ draft: async (_s, _d, _f, _c, signal) => { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  try {
    const r = await h.request('/api/jobs', { body: { sourceId: 10, destinationId: 20, feature: 'greeting', consentAI: true } }); assert.equal(r.res.status, 202, r.text); await ready;
    assert.equal((await h.request(`/api/jobs/${r.json.id}/cancel`, { body: {} })).res.status, 200);
    await Promise.allSettled([...h.app.service.pending]); assert.equal(h.store.get('job', r.json.id).state, 'cancelled'); assert.equal(h.gh.branches.size, 0);
  } finally { await h.close(); }
});
test('signed revocation invalidates sessions; forged webhooks do not; no raw provider error is returned', async () => {
  const h = await harness(); try {
    h.session(); const raw = JSON.stringify({ action: 'revoked', sender: { id: 1 } });
    assert.equal((await h.request('/webhooks/github', { auth: false, raw, headers: { 'x-github-event': 'github_app_authorization', 'x-hub-signature-256': 'bad' } })).res.status, 401);
    assert.equal((await h.request('/api/session')).res.status, 200);
    const signature = 'sha256=' + createHmac('sha256', h.cfg.webhookSecret).update(raw).digest('hex');
    assert.equal((await h.request('/webhooks/github', { auth: false, raw, headers: { 'x-github-event': 'github_app_authorization', 'x-hub-signature-256': signature } })).res.status, 200);
    assert.equal((await h.request('/api/session')).res.status, 401);
  } finally { await h.close(); }
});
test('deleting Graft data removes only the authenticated owner, not GitHub branches or another user', async () => {
  const h = await harness(); try {
    const j = await h.start(); h.session('2'); await h.publish(j);
    assert.equal((await h.request('/api/account/delete', { body: {} })).res.status, 200); assert.equal(h.store.get('job', j.id), null);
    assert.equal((await h.request('/api/session', { owner: '2' })).res.status, 200); assert.equal(h.gh.branches.size, 1); assert.equal(h.gh.prs.length, 1);
  } finally { await h.close(); }
});
test('GitHub authorization loss blocks further reads and invalidates the local session', async () => {
  const h = await harness(); try { h.session(); h.gh.state.deny = true; assert.equal((await h.request('/api/repos')).res.status, 401); assert.equal((await h.request('/api/session')).res.status, 401); } finally { await h.close(); }
});
test('large, invalid JSON and compressed mutation bodies fail safely', async () => {
  const h = await harness(); try {
    assert.equal((await h.request('/api/jobs', { raw: '{invalid' })).res.status, 400);
    assert.equal((await h.request('/api/jobs', { raw: JSON.stringify({ value: 'a'.repeat(20000) }) })).res.status, 413);
    assert.equal((await h.request('/api/jobs', { body: {}, headers: { 'content-encoding': 'gzip' } })).res.status, 415);
  } finally { await h.close(); }
});
