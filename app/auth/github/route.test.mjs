/**
 * @file Executable sign-in, callback, session-confirmation and CSP regression tests.
 * Run: node --experimental-vm-modules --test app/auth/github/route.test.mjs
 * Actual route bodies and presentation helpers run with a synthetic Better Auth
 * dependency. These are not live GitHub, database, browser or SDK integration tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import nextConfig from '../../../next.config.mjs';
import { safeNextPath, signInError } from '../../../remote/auth-ui.mjs';

const authorizationURL = 'https://github.com/login/oauth/authorize?client_id=test-client&state=test-state&code_challenge=test-proof&code_challenge_method=S256';
const root = new URL('../../../', import.meta.url);
const apiModule = new URL('remote/auth.mjs', root).href;
const uiModule = new URL('remote/auth-ui.mjs', root).href;
const allowedRoutes = ['app/auth/github/route.js', 'app/auth/callback/route.js', 'app/sign-in/route.js', 'app/connected/route.js'];

/** Load actual route/helper code, substituting only the unavailable Better Auth service. */
async function loadAuthRoute(file, overrides = {}) {
  assert.ok(allowedRoutes.includes(file));
  const context = vm.createContext({ URL, URLSearchParams, Headers, Request, Response, Date });
  const getSession = overrides.getSession ?? (async () => Response.json(null));
  const signInSocial = overrides.signInSocial ?? (async () => { throw new Error('Unexpected sign-in'); });
  const handler = overrides.handler ?? (async () => { throw new Error('Unexpected callback'); });
  const auth = new vm.SyntheticModule(['getAuth'], function () {
    this.setExport('getAuth', () => ({ api: { signInSocial, getSession }, handler }));
  }, { context, identifier: apiModule });
  const ui = new vm.SourceTextModule(await readFile(new URL(uiModule), 'utf8'), { context, identifier: uiModule });
  const routeUrl = new URL(file, root);
  const route = new vm.SourceTextModule(await readFile(routeUrl, 'utf8'), { context, identifier: routeUrl.href });
  await route.link((specifier, referencing) => {
    const resolved = new URL(specifier, referencing.identifier).href;
    if (resolved === apiModule) return auth;
    if (resolved === uiModule) return ui;
    assert.fail('Unexpected import: ' + resolved);
  });
  await route.evaluate();
  return route.namespace;
}

/** Keep the original sign-in bridge tests concise without importing production dependencies. */
const loadRoute = signInSocial => loadAuthRoute('app/auth/github/route.js', { signInSocial });

/** Create a synthetic browser form; no actual credentials or OAuth tokens are used. */
function formRequest(next = '/mcp/') {
  return new Request('https://getrepot.com/auth/github', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://getrepot.com', cookie: 'test_session=not-a-real-session' },
    body: new URLSearchParams({ next })
  });
}

/** Create the provider's handoff response without contacting GitHub. */
function handoff(url = authorizationURL, headers = {}) {
  return Response.json({ url, redirect: true }, { headers });
}

/** Create a synthetic session payload with secret-like sentinels to detect accidental disclosure. */
function sessionPayload() {
  return {
    user: { id: 'test-user', name: '<script>UNTRUSTED_NAME</script>', email: 'private-display@example.invalid' },
    session: { id: 'test-session', userId: 'test-user', token: 'DO_NOT_RENDER_SESSION_TOKEN', expiresAt: new Date(Date.now() + 60000).toISOString() }
  };
}

test('the public sign-in page has an enabled POST form and preserves a safe next path', async () => {
  const route = await loadAuthRoute('app/sign-in/route.js');
  const response = await route.GET(new Request('https://getrepot.com/sign-in?next=%2Fmcp%2F'));
  const html = await response.text();
  assert.match(html, /<form method="post" action="\/auth\/github">/);
  assert.match(html, /name="next" value="\/mcp\/"/);
  assert.match(html, /<button[^>]+type="submit">Continue with GitHub/);
  assert.doesNotMatch(html, /<button[^>]+(?:disabled|aria-disabled="true")/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the page policy retains narrowly allowed GitHub form redirects', async () => {
  const rules = await nextConfig.headers();
  const policy = rules.find(rule => rule.source === '/:path*').headers.find(h => h.key === 'Content-Security-Policy').value;
  const directives = new Map(policy.split(';').map(part => { const [name, ...values] = part.trim().split(/\s+/); return [name, values]; }));
  assert.deepEqual(directives.get('form-action'), ["'self'", 'https://github.com']);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('connect-src'), ["'self'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
  assert.ok(!policy.includes('*') && !policy.includes('unsafe-inline'));
});

test('GET sign-in links reach the page without starting OAuth', async () => {
  let calls = 0;
  const route = await loadRoute(async () => { calls++; return handoff(); });
  const response = await route.GET(new Request('https://getrepot.com/auth/github'));
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/sign-in');
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls, 0);
});

test('GET sign-in links preserve an explicitly supplied safe destination', async () => {
  const route = await loadRoute();
  const response = await route.GET(new Request('https://getrepot.com/auth/github?next=%2Fmcp%2F'));
  assert.equal(response.headers.get('location'), '/sign-in?next=%2Fmcp%2F');
});

test('a form POST redirects to GitHub, preserves the cookie, and does not mask callback errors', async () => {
  let options;
  const route = await loadRoute(async value => { options = value; return handoff(); });
  const response = await route.POST(formRequest());
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), authorizationURL);
  assert.equal(await response.text(), ''); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), null);
  assert.equal(options.asResponse, true); assert.equal(options.body.provider, 'github');
  assert.equal(options.body.callbackURL, '/mcp/'); assert.equal(options.body.newUserCallbackURL, '/mcp/');
  assert.equal(options.body.errorCallbackURL, '/sign-in');
  assert.equal(options.headers.get('cookie'), 'test_session=not-a-real-session');
});

test('new and returning users default to the session-verified confirmation route', async () => {
  let body;
  const route = await loadRoute(async options => { body = options.body; return handoff(); });
  await route.POST(formRequest(''));
  assert.equal(body.callbackURL, '/connected'); assert.equal(body.newUserCallbackURL, '/connected');
});

test('state and PKCE cookies remain separate, including Expires commas', async () => {
  const cookies = ['test_state=value1; Path=/; HttpOnly; Secure; SameSite=Lax', 'test_pkce=value2; Path=/; HttpOnly; Secure; Expires=Wed, 21 Oct 2037 07:28:00 GMT'];
  const route = await loadRoute(async () => {
    const response = handoff(authorizationURL, { 'content-length': '123', 'x-test-marker': 'preserved' });
    for (const cookie of cookies) response.headers.append('set-cookie', cookie);
    return response;
  });
  const response = await route.POST(formRequest());
  assert.deepEqual(response.headers.getSetCookie(), cookies); assert.equal(response.headers.get('x-test-marker'), 'preserved');
  assert.equal(response.headers.get('content-length'), null);
});

for (const next of ['https://untrusted.example/', '//untrusted.example/', 'not-a-path', '/\\untrusted.example/', '/%5cuntrusted.example/', '/%2f%2funtrusted.example/', '/sign-in', '/auth/github', '/auth/callback', '/api/auth/callback/github', '/a/../sign-in', '/%73ign-in', '/mcp\n', '/%00', '/%ZZ']) {
  test('unsafe or looping next path falls back safely: ' + JSON.stringify(next), async () => {
    assert.equal(safeNextPath(next), '/connected');
    let callback;
    const route = await loadRoute(async options => { callback = options.body.callbackURL; return handoff(); });
    await route.POST(formRequest(next)); assert.equal(callback, '/connected');
  });
}

test('safe query and fragment context is retained instead of replaced with a generic success path', () => {
  for (const next of ['/mcp/', '/#desk', '/consent?request=synthetic', '/api/auth/oauth2/authorize?client_id=test&state=test']) assert.equal(safeNextPath(next), next);
});

for (const url of ['http://github.com/login/oauth/authorize', 'https://github.com.evil.example/login/oauth/authorize', 'https://github.com:444/login/oauth/authorize', 'https://username:password@github.com/login/oauth/authorize', 'https://github.com/login/oauth/authorize#unexpected', 'https://github.com/other', 'not-a-url']) {
  test('unexpected provider handoff is rejected: ' + url, async () => {
    const route = await loadRoute(async () => handoff(url));
    await assert.rejects(route.POST(formRequest()), /authorization (URL|destination)/);
  });
}

test('Better Auth errors stay errors, not fake provider navigation', async () => {
  const route = await loadRoute(async () => Response.json({ error: 'synthetic-error' }, { status: 403 }));
  const response = await route.POST(formRequest());
  assert.equal(response.status, 403); assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await response.json(), { error: 'synthetic-error' });
});

test('non-JSON and non-redirect upstream responses are not mistaken for provider handoffs', async () => {
  for (const body of ['not JSON', JSON.stringify({ url: authorizationURL, redirect: false })]) {
    const route = await loadRoute(async () => new Response(body)); const response = await route.POST(formRequest());
    assert.equal(response.headers.get('location'), null); assert.equal(await response.text(), body);
  }
});

test('existing provider redirects and cookies are preserved', async () => {
  const upstream = new Response(null, { status: 302, headers: { location: authorizationURL, 'set-cookie': 'test_state=kept; HttpOnly; Secure; Path=/' } });
  const route = await loadRoute(async () => upstream);
  assert.equal(await route.POST(formRequest()), upstream);
});

test('real callback error is shown even for older attempts containing error=github first', async () => {
  const route = await loadAuthRoute('app/sign-in/route.js');
  const response = await route.GET(new Request('https://getrepot.com/sign-in?error=github&error=email_not_found'));
  const html = await response.text();
  assert.match(html, /role="alert"/); assert.match(html, /email_not_found/);
  assert.match(html, /Repot does not require your email/); assert.match(html, /GitHub identity adapter/);
  assert.doesNotMatch(html, /Email addresses: Read-only|make your email public/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

for (const code of ['state_not_found', 'state_mismatch', 'invalid_code', 'unable_to_get_user_info', 'unable_to_create_user', 'unable_to_create_session', 'access_denied']) {
  test('callback error is visible and does not claim successful sign-in: ' + code, async () => {
    const route = await loadAuthRoute('app/sign-in/route.js');
    const html = await (await route.GET(new Request('https://getrepot.com/sign-in?error=' + code))).text();
    assert.match(html, /GitHub sign-in did not finish/); assert.ok(html.includes('<code>' + code + '</code>'));
    assert.ok(!html.includes('BROWSER SESSION VERIFIED'));
  });
}

test('unknown errors and callback query secrets are never echoed into HTML', async () => {
  const route = await loadAuthRoute('app/sign-in/route.js');
  const params = new URLSearchParams({ error: '<script>ATTACK</script>', error_description: 'PRIVATE_PROVIDER_BODY', code: 'PRIVATE_CODE', state: 'PRIVATE_STATE', access_token: 'PRIVATE_TOKEN' });
  const html = await (await route.GET(new Request('https://getrepot.com/sign-in?' + params))).text();
  assert.match(html, /auth_failed/);
  assert.doesNotMatch(html, /ATTACK|PRIVATE_|<script|onerror=/);
  assert.equal(signInError(new URLSearchParams()), null);
});

test('an existing session skips redundant sign-in, forwards cookies and preserves the requested next', async () => {
  const cookies = ['refresh=synthetic; Secure; HttpOnly; Path=/', 'stale=; Max-Age=0; Path=/'];
  let options;
  const route = await loadAuthRoute('app/sign-in/route.js', { getSession: async value => {
    options = value; const response = Response.json(sessionPayload());
    cookies.forEach(cookie => response.headers.append('set-cookie', cookie)); return response;
  } });
  const response = await route.GET(new Request('https://getrepot.com/sign-in?next=%2Fmcp%2F', { headers: { cookie: 'synthetic=browser' } }));
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/mcp/');
  assert.deepEqual(response.headers.getSetCookie(), cookies); assert.equal(options.asResponse, true);
  assert.equal(options.headers.get('cookie'), 'synthetic=browser');
});

test('a failed new authorization is not hidden by an older valid session', async () => {
  const route = await loadAuthRoute('app/sign-in/route.js', { getSession: async () => Response.json(sessionPayload()) });
  const response = await route.GET(new Request('https://getrepot.com/sign-in?error=state_mismatch'));
  const html = await response.text(); assert.equal(response.status, 200);
  assert.match(html, /state_mismatch/); assert.match(html, /existing Repot session/);
});

for (const mode of ['null', 'expired', 'mismatched', 'malformed']) {
  test('confirmation rejects ' + mode + ' sessions, even with a success query flag', async () => {
    let payload = sessionPayload();
    if (mode === 'null') payload = null;
    if (mode === 'expired') payload.session.expiresAt = '2000-01-01T00:00:00Z';
    if (mode === 'mismatched') payload.session.userId = 'other-user';
    if (mode === 'malformed') payload = { user: payload.user };
    const route = await loadAuthRoute('app/connected/route.js', { getSession: async () => Response.json(payload) });
    const response = await route.GET(new Request('https://getrepot.com/connected?success=true'));
    assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/sign-in?error=session_missing');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
}

test('confirmation shows only session-verified display data, never credentials or fabricated MCP success', async () => {
  const route = await loadAuthRoute('app/connected/route.js', { getSession: async () => Response.json(sessionPayload()) });
  const response = await route.GET(new Request('https://getrepot.com/connected')); const html = await response.text();
  assert.match(html, /BROWSER SESSION VERIFIED/); assert.match(html, /&lt;script&gt;UNTRUSTED_NAME&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|DO_NOT_RENDER_SESSION_TOKEN|private-display/);
  assert.match(html, /Browser sign-in alone does not confirm/); assert.equal(response.headers.get('cache-control'), 'no-store');
});

for (const file of ['app/sign-in/route.js', 'app/connected/route.js']) {
  test('session lookup failures render a non-secret 503: ' + file, async () => {
    for (const getSession of [async () => { throw new Error('postgresql://SECRET_PASSWORD@host'); }, async () => new Response('SECRET_DB_DETAIL', { status: 500 })]) {
      const route = await loadAuthRoute(file, { getSession });
      const response = await route.GET(new Request('https://getrepot.com/sign-in')); const html = await response.text();
      assert.equal(response.status, 503); assert.match(html, /auth_unavailable/); assert.doesNotMatch(html, /SECRET_|postgresql:/);
    }
  });
}

test('callback bridge preserves state, code and session cookie handling for Better Auth to verify', async () => {
  let upstreamRequest;
  const headers = new Headers({ location: '/sign-in?error=email_not_found' });
  headers.append('set-cookie', 'test-state=; Max-Age=0; Path=/');
  const upstream = new Response(null, { status: 302, headers });
  const route = await loadAuthRoute('app/auth/callback/route.js', { handler: async req => { upstreamRequest = req; return upstream; } });
  const request = new Request('https://getrepot.com/auth/callback?code=synthetic-code&state=synthetic-state', { headers: { cookie: 'synthetic-cookie=value' } });
  const response = await route.GET(request);
  assert.equal(response, upstream);
  assert.equal(upstreamRequest.url, 'https://getrepot.com/api/auth/callback/github?code=synthetic-code&state=synthetic-state');
  assert.equal(upstreamRequest.headers.get('cookie'), 'synthetic-cookie=value');
});
