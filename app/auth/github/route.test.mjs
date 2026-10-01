/**
 * @file Executable GitHub sign-in bridge and CSP regression tests.
 *
 * Run: node --experimental-vm-modules --test app/auth/github/route.test.mjs
 * The real route module executes against a synthetic Better Auth dependency.
 * No GitHub account, production cookie, database, API key, or network is used.
 * These are handler/header tests, not live OAuth or browser acceptance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import nextConfig from '../../../next.config.mjs';
import { GET as signInPage } from '../../sign-in/route.js';

const routeSource = await readFile(new URL('./route.js', import.meta.url), 'utf8');
const authorizationURL = 'https://github.com/login/oauth/authorize?client_id=test-client&state=test-state&code_challenge=test-proof&code_challenge_method=S256';

/**
 * Loads the unchanged route body while replacing only its Better Auth import.
 * An unexpected import fails the test rather than acquiring live credentials.
 */
async function loadRoute(signInSocial) {
  const context = vm.createContext({ URL, Headers, Request, Response });
  const auth = new vm.SyntheticModule(['getAuth'], function () {
    this.setExport('getAuth', () => ({ api: { signInSocial } }));
  }, { context });
  const route = new vm.SourceTextModule(routeSource, { context });
  await route.link(specifier => {
    assert.equal(specifier, '../../../remote/auth.mjs');
    return auth;
  });
  await route.evaluate();
  return route.namespace;
}

/** Creates a synthetic browser form POST; all cookies and state are test-only. */
function formRequest(next = '/mcp/') {
  return new Request('https://getrepot.com/auth/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://getrepot.com',
      cookie: 'test_session=not-a-real-session'
    },
    body: new URLSearchParams({ next })
  });
}

/** Creates Better Auth's JSON handoff format without calling the provider. */
function handoff(url = authorizationURL, headers = {}) {
  return new Response(JSON.stringify({ url, redirect: true }), {
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('the public sign-in page has a working POST form with an enabled submit button', async () => {
  const response = await signInPage(new Request('https://getrepot.com/sign-in?next=%2Fmcp%2F'));
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/auth\/github">/);
  assert.match(html, /name="next" value="\/mcp\/"/);
  assert.match(html, /<button[^>]+type="submit">Continue with GitHub/);
  assert.doesNotMatch(html, /<button[^>]+(?:disabled|aria-disabled="true")/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the page policy allows the GitHub redirect as well as the same-origin form POST', async () => {
  const rules = await nextConfig.headers();
  const policy = rules.find(rule => rule.source === '/:path*').headers
    .find(header => header.key === 'Content-Security-Policy').value;
  const directives = new Map(policy.split(';').map(part => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
  // Chromium/Safari can enforce form-action against redirect destinations.
  assert.deepEqual(directives.get('form-action'), ["'self'", 'https://github.com']);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.ok(!policy.includes('*') && !policy.includes('unsafe-inline'));
});

test('an existing Connect GitHub anchor reaches the sign-in page without starting OAuth on GET', async () => {
  let calls = 0;
  const route = await loadRoute(async () => { calls++; return handoff(); });
  const response = await route.GET(new Request('https://getrepot.com/auth/github'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/sign-in');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 0);
});

test('a form POST becomes a browser redirect and does not render handoff JSON', async () => {
  let options;
  const route = await loadRoute(async value => { options = value; return handoff(); });
  const response = await route.POST(formRequest());
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), authorizationURL);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), null);
  assert.equal(options.asResponse, true);
  assert.equal(options.body.provider, 'github');
  assert.equal(options.body.callbackURL, '/mcp/');
  assert.equal(options.body.errorCallbackURL, '/sign-in?error=github');
  assert.equal(options.headers.get('cookie'), 'test_session=not-a-real-session');
});

test('state and PKCE cookies remain separate, including commas in Expires', async () => {
  const cookies = [
    'test_state=value1; Path=/; HttpOnly; Secure; SameSite=Lax',
    'test_pkce=value2; Path=/; HttpOnly; Secure; Expires=Wed, 21 Oct 2037 07:28:00 GMT'
  ];
  const route = await loadRoute(async () => {
    const response = handoff(authorizationURL, { 'content-length': '123', 'x-test-marker': 'preserved' });
    for (const cookie of cookies) response.headers.append('set-cookie', cookie);
    return response;
  });
  const response = await route.POST(formRequest());
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.equal(response.headers.get('x-test-marker'), 'preserved');
  assert.equal(response.headers.get('content-length'), null);
});

for (const next of ['https://untrusted.example/', '//untrusted.example/', 'not-a-path']) {
  test(`absolute or non-relative post-login destinations are not accepted: ${next}`, async () => {
    let callback;
    const route = await loadRoute(async options => { callback = options.body.callbackURL; return handoff(); });
    await route.POST(formRequest(next));
    assert.equal(callback, '/');
  });
}

for (const url of [
  'http://github.com/login/oauth/authorize',
  'https://github.com.evil.example/login/oauth/authorize',
  'https://github.com:444/login/oauth/authorize',
  'https://username:password@github.com/login/oauth/authorize',
  'https://github.com/login/oauth/authorize#unexpected',
  'https://github.com/other',
  'not-a-url'
]) {
  test(`an unexpected provider handoff is rejected: ${url}`, async () => {
    const route = await loadRoute(async () => handoff(url));
    await assert.rejects(route.POST(formRequest()), /authorization (URL|destination)/);
  });
}

test('Better Auth errors remain errors rather than navigating to a provider', async () => {
  const route = await loadRoute(async () => new Response(JSON.stringify({ error: 'synthetic-error' }), {
    status: 403, headers: { 'content-type': 'application/json' }
  }));
  const response = await route.POST(formRequest());
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await response.json(), { error: 'synthetic-error' });
});

test('non-JSON and non-redirect responses are not mistaken for authorization handoffs', async () => {
  for (const body of ['not JSON', JSON.stringify({ url: authorizationURL, redirect: false })]) {
    const route = await loadRoute(async () => new Response(body));
    const response = await route.POST(formRequest());
    assert.equal(response.headers.get('location'), null);
    assert.equal(await response.text(), body);
  }
});

test('an existing Better Auth redirect is preserved, including its correlation cookie', async () => {
  const upstream = new Response(null, { status: 302, headers: {
    location: authorizationURL, 'set-cookie': 'test_state=kept; HttpOnly; Secure; Path=/'
  } });
  const route = await loadRoute(async () => upstream);
  const response = await route.POST(formRequest());
  assert.equal(response, upstream);
  assert.equal(response.headers.getSetCookie().length, 1);
});
