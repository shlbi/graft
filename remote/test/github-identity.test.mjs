/**
 * @file Executable no-email GitHub identity and auth-configuration regressions.
 * Uses synthetic HTTP responses and injected external auth modules, not real
 * GitHub tokens, Better Auth persistence, or production session creation.
 * Run: node --experimental-vm-modules --test remote/test/github-identity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { githubIdentity } from '../github-identity.mjs';

const TOKEN = 'synthetic-user-token';
const profile = { id: 12345, login: 'octocat', type: 'User', email: null };

/** Execute the actual identity adapter with a synthetic /user HTTP response. */
async function resolveProfile(value = profile) {
  const calls = [];
  const result = await githubIdentity({ accessToken: TOKEN }, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(value);
  } });
  return { result, calls };
}

/** Evaluate the real auth configuration, replacing packages/env/db, never the provider implementation. */
async function authConfiguration() {
  const context = vm.createContext({});
  const configurations = [], pluginOptions = {};
  const pool = { synthetic: true };
  const values = {
    'better-auth': { betterAuth: config => { configurations.push(config); return { options: config }; } },
    'better-auth/plugins': { jwt: options => { pluginOptions.jwt = options; return { id: 'jwt' }; } },
    '@better-auth/mcp': { mcp: options => { pluginOptions.mcp = options; return { id: 'mcp' }; } },
    '@better-auth/cimd': { cimd: options => { pluginOptions.cimd = options; return { id: 'cimd' }; } },
    '@better-auth/cimd/node': { fetchClientMetadataResource: () => { throw new Error('Unexpected network'); } },
    './db.mjs': { db: () => pool },
    './env.mjs': {
      authBaseUrl: () => 'https://getrepot.com', resource: () => 'https://mcp.getrepot.com/mcp',
      env: name => ({ BETTER_AUTH_SECRET: 'test-auth-secret', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-client-secret' })[name]
    },
    './github-identity.mjs': { githubIdentity }
  };
  const source = await readFile(new URL('../auth.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(values, specifier), 'Unexpected dependency: ' + specifier);
    const exports = values[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const instance = module.namespace.getAuth();
  assert.equal(module.namespace.getAuth(), instance);
  assert.equal(configurations.length, 1);
  return { config: configurations[0], pluginOptions, pool };
}

test('a private-email GitHub profile authenticates identity without an email request', async () => {
  const { result, calls } = await resolveProfile();
  assert.deepEqual(result, {
    user: { id: '12345', name: 'octocat', email: 'github-12345@users.repot.invalid', emailVerified: false },
    data: { id: '12345', login: 'octocat' }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  const { options } = calls[0];
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers.authorization, 'Bearer ' + TOKEN);
  assert.ok(options.signal instanceof AbortSignal);
});

test('an absent email is supported too; no placeholder account is accepted without an ID', async () => {
  const { email, ...withoutEmail } = profile;
  const { result } = await resolveProfile(withoutEmail);
  assert.equal(result.user.id, '12345');
  assert.equal(result.user.emailVerified, false);
});

test('public email and provider extras never enter the mapped user or provider data', async () => {
  const { result } = await resolveProfile({ ...profile, email: 'PRIVATE_ADDRESS@example.com',
    name: 'PRIVATE_FULL_NAME', email_verified: true, location: 'PRIVATE_LOCATION', arbitrary: 'PRIVATE_EXTRA' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|example.com|email_verified/);
  assert.equal(result.user.emailVerified, false);
  assert.deepEqual(Object.keys(result.data).sort(), ['id', 'login']);
});

test('a GitHub rename or email change keeps the same subject and internal ID', async () => {
  const a = (await resolveProfile()).result;
  const b = (await resolveProfile({ ...profile, login: 'renamed', email: 'changed@example.com' })).result;
  assert.equal(a.data.id, b.data.id);
  assert.equal(a.user.email, b.user.email);
  assert.notEqual(a.user.name, b.user.name);
});

test('different GitHub subjects cannot collide through matching handles or email addresses', async () => {
  const a = (await resolveProfile()).result;
  const b = (await resolveProfile({ ...profile, id: 67890 })).result;
  assert.notEqual(a.data.id, b.data.id);
  assert.notEqual(a.user.email, b.user.email);
});

for (const id of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, true, {}, '', '01', '1e3', '-1', 'abc', '1/../../2', '9'.repeat(21)]) {
  test('malformed or unsafe GitHub subject is rejected: ' + String(id), async () => {
    assert.equal((await resolveProfile({ ...profile, id })).result, null);
  });
}

test('canonical numeric/string subjects map identically and large decimal strings keep precision', async () => {
  assert.deepEqual((await resolveProfile({ ...profile, id: '12345' })).result, (await resolveProfile()).result);
  const large = (await resolveProfile({ ...profile, id: '9007199254740993' })).result;
  assert.equal(large.data.id, '9007199254740993');
  assert.equal(large.user.email, 'github-9007199254740993@users.repot.invalid');
});

for (const value of [null, [], {}, { ...profile, type: 'Organization' }, { ...profile, type: 'Bot' },
  { ...profile, login: '' }, { ...profile, login: '<script>name</script>' }, { ...profile, login: 'bad\nname' }]) {
  test('invalid/non-user profile fails closed: ' + JSON.stringify(value), async () => {
    assert.equal((await resolveProfile(value)).result, null);
  });
}

test('managed-user handles are valid display names, not identity keys', async () => {
  assert.equal((await resolveProfile({ ...profile, login: 'user_enterprise' })).result.user.name, 'user_enterprise');
});

for (const status of [301, 401, 403, 429, 500]) {
  test('GitHub HTTP ' + status + ' returns no identity and does not follow a supplied location', async () => {
    let calls = 0;
    const result = await githubIdentity({ accessToken: TOKEN }, { fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'error');
      return new Response('PRIVATE_PROVIDER_DETAIL', { status, headers: { location: 'https://evil.invalid/user' } });
    } });
    assert.equal(result, null); assert.equal(calls, 1);
  });
}

test('network failure and invalid UTF-8/JSON return no identity', async () => {
  for (const response of [() => { throw new Error('PRIVATE_TOKEN=' + TOKEN); },
    () => new Response('{bad-json'), () => new Response(new Uint8Array([255, 254]))]) {
    assert.equal(await githubIdentity({ accessToken: TOKEN }, { fetchImpl: response }), null);
  }
});

test('oversized body is cancelled using actual bytes even with a false Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  const result = await githubIdentity({ accessToken: TOKEN }, { fetchImpl: async () => new Response(body, { headers: { 'content-length': '1' } }) });
  assert.equal(result, null); assert.equal(cancelled, true);
});

test('valid JSON split across response chunks works and still discards public email', async () => {
  const json = new TextEncoder().encode(JSON.stringify(profile));
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(json.slice(0, 9)); controller.enqueue(json.slice(9)); controller.close();
  } });
  const result = await githubIdentity({ accessToken: TOKEN }, { fetchImpl: async () => new Response(body) });
  assert.equal(result.data.id, '12345');
});

test('no missing or malformed token may cause an unauthenticated profile fetch', async () => {
  let calls = 0;
  for (const accessToken of [undefined, null, '', 12, 'bad\r\nheader', 'x'.repeat(4097)]) {
    assert.equal(await githubIdentity({ accessToken }, { fetchImpl: async () => { calls++; return Response.json(profile); } }), null);
  }
  assert.equal(calls, 0);
});

test('browser-supplied profile/user fields cannot replace the token-bound GitHub identity', async () => {
  const result = await githubIdentity({ accessToken: TOKEN, user: { id: 999, email: 'attacker@example.com' }, id: 999 },
    { fetchImpl: async () => Response.json(profile) });
  assert.equal(result.user.id, '12345');
  assert.doesNotMatch(JSON.stringify(result), /999|attacker/);
});

test('actual auth configuration selects the no-email hook and omits GitHub default scopes', async () => {
  const { config } = await authConfiguration();
  const github = config.socialProviders.github;
  assert.equal(github.getUserInfo, githubIdentity);
  assert.equal(github.disableDefaultScope, true);
  assert.equal(github.scope.length, 0);
  assert.equal(github.overrideUserInfoOnSignIn, true);
  assert.deepEqual(Object.keys(config.socialProviders), ['github']);
  assert.equal(github.redirectURI, 'https://getrepot.com/auth/callback');
});

test('email login, email change, sending email, and email-based account merging remain disabled', async () => {
  const { config } = await authConfiguration();
  assert.equal(config.emailAndPassword.enabled, false);
  assert.equal(config.emailVerification.sendOnSignUp, false);
  assert.equal(config.emailVerification.sendOnSignIn, false);
  assert.equal(config.user.changeEmail.enabled, false);
  assert.equal(config.account.accountLinking.enabled, false);
  assert.equal(config.emailVerification.sendVerificationEmail, undefined);
  assert.equal(config.emailAndPassword.sendResetPassword, undefined);
});

test('GitHub token validation, PKCE/state and MCP resource configuration are not replaced', async () => {
  const { config, pluginOptions, pool } = await authConfiguration();
  const github = config.socialProviders.github;
  for (const key of ['validateAuthorizationCode', 'createAuthorizationURL', 'verifyIdToken']) assert.equal(github[key], undefined);
  assert.equal(config.database, pool);
  assert.equal(config.secret, 'test-auth-secret');
  assert.equal(pluginOptions.mcp.resource, 'https://mcp.getrepot.com/mcp');
  assert.equal(pluginOptions.mcp.scopes.includes('email'), false);
  assert.deepEqual(Array.from(config.trustedOrigins), ['https://getrepot.com', 'https://mcp.getrepot.com']);
});
