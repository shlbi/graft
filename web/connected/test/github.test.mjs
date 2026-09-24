import test from 'node:test';
import assert from 'node:assert/strict';
import { config, fakeGitHub } from './fixtures.mjs';
import { GitHubClient, boundedResponse } from '../github.mjs';
const json = body => new Response(JSON.stringify(body));
test('GitHub API sends credentials only to its fixed origin, disables redirects and uses bounded requests', async () => {
  const cfg = config(), gh = fakeGitHub(cfg); await gh.client.user('ghu_alice');
  assert.equal(gh.calls[0].options.redirect, 'error'); assert.equal(gh.calls[0].options.headers.authorization, 'Bearer ghu_alice');
  for (const path of ['https://evil.test', '//evil.test', '/repos/demo/a/../../secret', '/user\\evil']) await assert.rejects(gh.client.api('ghu_alice', path));
  assert.equal(gh.calls.length, 1);
});
test('bounded responses reject oversized bodies and invalid JSON', async () => {
  await assert.rejects(boundedResponse(new Response('x'.repeat(200)), 100), /size limit/);
  await assert.rejects(boundedResponse(new Response('{no')), /invalid response/);
});
test('authentication refuses OAuth-app tokens, missing expiry and unbounded token lifetime', async () => {
  for (const data of [{ access_token: 'gho_wrong', token_type: 'bearer', expires_in: 1000 }, { access_token: 'ghu_test', token_type: 'bearer' }, { access_token: 'ghu_test', token_type: 'bearer', expires_in: 999999 }]) {
    const c = new GitHubClient(config(), { fetchImpl: async () => json(data) }); await assert.rejects(c.exchange('abc', 'def'), /GitHub App/);
  }
});
test('repository listing ignores different Apps and suspended installations', async () => {
  const c = new GitHubClient(config(), { fetchImpl: async () => json({ total_count: 2, installations: [{ id: 1, app_id: 1 }, { id: 2, app_id: 99, suspended_at: '2026-01-01' }] }) });
  assert.deepEqual(await c.repositories('token'), []);
});
test('repository membership, write access and distinct selections are verified before intake', async () => {
  const h = fakeGitHub(config()); await assert.rejects(h.client.authorize('ghu_alice', 999, 20), /Both repositories/); await assert.rejects(h.client.authorize('ghu_alice', 10, 10), /different/);
  const c = new GitHubClient(config(), { fetchImpl: async u => u.includes('/user/installations?') ? json({ total_count: 1, installations: [{ id: 7, app_id: 99 }] }) : json({ total_count: 2, repositories: [{ id: 10, full_name: 'demo/source' }, { id: 20, full_name: 'demo/destination', permissions: { push: false } }] }) });
  await assert.rejects(c.authorize('token', 10, 20), /write access/);
});
test('authenticated snapshots pin the commit and verify every Git blob SHA', async () => {
  const gh = fakeGitHub(config()); const r = await gh.client.readRepository('ghu_alice', { id: 10, name: 'demo/source' });
  assert.equal(r.snapshot.files.length, 1); assert.equal(r.snapshot.coverage.completeTextSnapshot, true); assert.equal(r.repository.id, 10);
  const bad = new GitHubClient(config(), { fetchImpl: async (url, opts) => {
    const response = await gh.fetchImpl(url, opts);
    if (!url.includes('/git/blobs/')) return response;
    const body = await response.json(); body.content = Buffer.from('tampered').toString('base64'); return json(body);
  } });
  await assert.rejects(bad.readRepository('ghu_alice', { id: 10, name: 'demo/source' }), /integrity/);
});
test('truncated trees and changed repository identities stop without constructing partial drafts', async () => {
  for (const fault of ['tree', 'identity']) {
    const gh = fakeGitHub(config()); const c = new GitHubClient(config(), { fetchImpl: async (url, opts) => {
      const response = await gh.fetchImpl(url, opts); const b = await response.json();
      if (fault === 'tree' && url.includes('/git/trees/')) b.truncated = true;
      if (fault === 'identity' && url.endsWith('/repos/demo/source')) b.id = 999; return json(b);
    } });
    await assert.rejects(c.readRepository('ghu_alice', { id: 10, name: 'demo/source' }), /too large|identity/);
  }
});
test('repository pagination is complete within the explicit bound, never a silent first page', async () => {
  const paths = []; const c = new GitHubClient(config(), { fetchImpl: async url => {
    paths.push(url); if (url.includes('/user/installations?')) return json({ total_count: 1, installations: [{ id: 7, app_id: 99 }] });
    const page = new URL(url).searchParams.get('page'); return json({ total_count: 101, repositories: page === '1' ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: 'demo/r' + i })) : [{ id: 101, full_name: 'demo/last' }] });
  } });
  assert.equal((await c.repositories('token')).length, 101); assert.equal(paths.length, 3);
});
