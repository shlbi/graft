import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './fixtures.mjs';
import { cryptoBox, sha256, cookie, readCookie, limiter, readConfig, equal } from '../security.mjs';
import { Store } from '../store.mjs';
const key = '11'.repeat(32);
test('authenticated encryption rejects wrong context, tampering and keys', () => {
  const b = cryptoBox(key), encoded = b.seal({ secret: 'private value' }, 'a');
  assert.deepEqual(b.open(encoded, 'a'), { secret: 'private value' }); assert.notEqual(encoded, b.seal({ secret: 'private value' }, 'a'));
  assert.throws(() => b.open(encoded, 'b')); assert.throws(() => cryptoBox('22'.repeat(32)).open(encoded, 'a'));
  const bytes = Buffer.from(encoded, 'base64'); bytes[14] ^= 1; assert.throws(() => b.open(bytes.toString('base64'), 'a'));
});
test('startup fails closed without invites, keys, HTTPS and a GitHub App', () => {
  for (const bad of [{ GRAFT_ALLOWED_USER_IDS: '' }, { GRAFT_DATA_KEY: 'weak' }, { GRAFT_GITHUB_APP_ID: '0' }, { GRAFT_GITHUB_CLIENT_SECRET: '' }, { GRAFT_ENV: 'production', GRAFT_PUBLIC_URL: 'http://example.com' }, { GRAFT_PUBLIC_URL: 'http://example.com' }, { GRAFT_PUBLIC_URL: 'http://127.0.0.1:4319/evil' }, { GRAFT_AI_MODEL: '' }]) assert.throws(() => config(bad));
  assert.equal(config({ GRAFT_ENV: 'production', GRAFT_PUBLIC_URL: 'https://graft.example' }).origin, 'https://graft.example');
  assert.throws(() => readConfig({}));
});
test('production cookies are host-scoped, HttpOnly, Secure, bounded and SameSite', () => {
  const c = config({ GRAFT_ENV: 'production', GRAFT_PUBLIC_URL: 'https://graft.example' });
  assert.match(cookie(c, 'session', 'a'.repeat(43), 300), /^__Host-graft-session=/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=300']) assert.ok(cookie(c, 'session', 'a'.repeat(43), 300).includes(part));
  assert.equal(readCookie({ headers: { cookie: 'x=1; a=' + 'a'.repeat(43) } }, 'a'), 'a'.repeat(43));
  assert.equal(readCookie({ headers: { cookie: 'a=' + 'a'.repeat(43) + '; a=' + 'b'.repeat(43) } }, 'a'), null);
  assert.equal(equal('a', 'aa'), false);
});
test('rate limiter caps both requests and bucket memory, then expires', () => {
  let now = 0; const hit = limiter({ max: 2, capacity: 1, windowMs: 10, now: () => now });
  hit('one'); hit('one'); assert.throws(() => hit('one')); assert.throws(() => hit('two')); now = 11; hit('two');
});
test('durable records encrypt source/tokens, enforce owner and expiry, and consume OAuth once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graft-store-')); let now = 1000;
  try {
    let s = new Store(join(dir, 'store.sqlite'), key, { now: () => now });
    s.put('job', 'one', 'alice', { secret: 'unpublished-source-content', token: 'test-private-token' }, 2000, 'running');
    assert.equal(s.get('job', 'one', 'bob'), null); assert.equal(s.get('job', 'one', 'alice').state, 'running');
    s.put('oauth', 'once', '', { verifier: 'my-pkce-value' }, 2000); assert.ok(s.consume('oauth', 'once')); assert.equal(s.consume('oauth', 'once'), null);
    s.close(); const raw = readFileSync(join(dir, 'store.sqlite'));
    for (const text of ['unpublished-source-content', 'test-private-token', 'my-pkce-value']) assert.equal(raw.includes(Buffer.from(text)), false);
    s = new Store(join(dir, 'store.sqlite'), key, { now: () => now }); assert.equal(s.get('job', 'one', 'alice').secret, 'unpublished-source-content'); now = 2001; s.purge(); assert.equal(s.get('job', 'one'), null); s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('session stores only a digest of the browser ID and respects the shorter token lifetime', () => {
  const s = new Store(':memory:', key, { now: () => 1000 }); const session = s.session({ id: 1, login: 'alice' }, 'private-token', 60, config());
  assert.equal(s.get('session', session.sid), null); assert.equal(s.get('session', sha256(session.sid)).expires, 61000); s.close();
});
test('quotas reserve atomically, survive cancellation and are not reset by account deletion', () => {
  const s = new Store(':memory:', key), cfg = { ...config(), userDailyLimit: 1, globalDailyLimit: 2 };
  const j = s.reserve('1', cfg, { feature: 'abc' }); s.transition(j.id, '1', ['queued'], { state: 'cancelled' });
  s.deleteOwner('1'); assert.throws(() => s.reserve('1', cfg, { feature: 'abc' }), /allowance/);
  s.reserve('2', cfg, { feature: 'abc' }); assert.throws(() => s.reserve('3', cfg, { feature: 'abc' }), /allowance/); s.close();
});
test('job ownership and compare-and-swap prevent duplicate transitions', () => {
  const s = new Store(':memory:', key); const j = s.reserve('1', config(), { feature: 'abc' });
  assert.throws(() => s.transition(j.id, '2', ['queued'], { state: 'running' }), /not found/);
  s.transition(j.id, '1', ['queued'], { state: 'running' }); assert.throws(() => s.transition(j.id, '1', ['queued'], { state: 'running' })); s.close();
});
test('restart marks interrupted drafts without replaying AI and uncertain publications without rewriting GitHub', () => {
  const s = new Store(':memory:', key);
  for (const [id, state] of [['a', 'running'], ['b', 'publishing'], ['c', 'delivered']]) s.saveJob({ id, owner: '1', state, expires: Date.now() + 10000 });
  s.recover(); assert.equal(s.get('job', 'a').state, 'interrupted'); assert.equal(s.get('job', 'b').state, 'delivery_uncertain'); assert.equal(s.get('job', 'c').state, 'delivered'); s.close();
});
