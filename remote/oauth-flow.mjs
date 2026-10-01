/**
 * @file Server-side transport for Better Auth 1.7.6's signed OAuth continuation.
 * Carries the original MCP client request through our HTML forms, never a global
 * variable or a shared "last client" cookie. Better Auth still validates the
 * signature, client, redirect registration, PKCE, session and scopes at decision.
 *
 * 1.7.6 does not export verifyOAuthQueryParams. This small compatibility verifier
 * follows that pinned release's signed-query.ts and utils/index.ts contract:
 * ba_param selection, lexical key/value canonicalization, HMAC-SHA256/base64,
 * and exp in seconds. See docs/OAUTH-CONTINUATION.md before dependency upgrades.
 * This module verifies existing requests; it never signs new authorizations.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { authPage, escapeHtml } from './auth-ui.mjs';

export const OAUTH_QUERY_LIMIT = 16384;
const FORM_LIMIT = OAUTH_QUERY_LIMIT * 4;
const FORM_ERROR = 'This connection request is missing, expired, or invalid. Return to your MCP client and click Connect again. Your GitHub sign-in does not need to be repeated unless requested.';

/** A fixed, non-secret error that can be rendered without exposing query data. */
export class OAuthFlowError extends Error {
  constructor() { super(FORM_ERROR); this.name = 'OAuthFlowError'; }
}

/** Resolve the configured server origin, never an untrusted Host/forwarded header. */
export function oauthOrigin(auth) {
  return new URL(auth.options?.baseURL || 'https://getrepot.com').origin;
}

/**
 * Select only fields named in the provider-signed ba_param manifest. Preserve
 * repeated resources and custom signed fields; ignore unrelated UI query fields.
 * A normal browser sign-in has no OAuth fields and returns null. A partial OAuth
 * request must fail rather than silently fall back to an unrelated browser login.
 */
export function selectOAuthQuery(search) {
  if (typeof search !== 'string' || search.length > OAUTH_QUERY_LIMIT) throw new OAuthFlowError();
  const input = new URLSearchParams(search);
  const markers = ['sig', 'ba_param', 'client_id', 'redirect_uri', 'code_challenge', 'oauth_query'];
  if (!markers.some(key => input.has(key))) return null;
  if (input.getAll('sig').length !== 1 || !input.get('sig')) throw new OAuthFlowError();
  const names = new Set(input.getAll('ba_param'));
  if (!names.has('ba_param') || names.size > 64) throw new OAuthFlowError();
  const selected = new URLSearchParams();
  for (const [key, value] of input) {
    if (key === 'sig' || key === 'ba_param' || names.has(key)) selected.append(key, value);
  }
  for (const key of ['client_id', 'redirect_uri', 'response_type', 'exp', 'ba_iat']) {
    if (!names.has(key) || selected.getAll(key).length !== 1 || !selected.get(key)) throw new OAuthFlowError();
  }
  for (const key of ['state', 'scope', 'claims', 'prompt', 'code_challenge', 'code_challenge_method', 'max_age']) {
    if (selected.getAll(key).length > 1) throw new OAuthFlowError();
  }
  return selected.toString();
}

/** Accept HTTPS callbacks, or HTTP loopback for local MCP clients; reject credentials and fragments. */
function callbackURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new OAuthFlowError(); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new OAuthFlowError();
  return url;
}

/**
 * Check the pinned library's signature/expiry contract before rendering consent.
 * Returns the selected serialized query unchanged for Better Auth to verify again.
 * Reads the same resolved secret as Better Auth (including versioned secrets).
 */
export async function readOAuthRequest(search, auth, now = Date.now()) {
  const query = selectOAuthQuery(search);
  if (query === null) return null;
  const params = new URLSearchParams(query);
  const signature = params.get('sig');
  const expiration = Number(params.get('exp'));
  const issuedAt = Number(params.get('ba_iat'));
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature) || !Number.isSafeInteger(expiration) || expiration * 1000 <= now ||
      !Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > now + 30000 || params.get('response_type') !== 'code') throw new OAuthFlowError();
  const unsigned = new URLSearchParams(params);
  unsigned.delete('sig');
  const entries = [...unsigned].sort((a, b) => {
    for (const i of [0, 1]) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
    return 0;
  });
  const { secret } = await auth.$context;
  if (typeof secret !== 'string' || !secret) throw new Error('OAuth validation unavailable');
  const expected = createHmac('sha256', secret).update(new URLSearchParams(entries).toString()).digest('base64');
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new OAuthFlowError();
  const redirect = callbackURL(params.get('redirect_uri'));
  return { query, params, redirect, clientId: params.get('client_id'), scopes: (params.get('scope') || '').split(' ').filter(Boolean) };
}

/** Read a bounded same-origin URL-encoded form; reject duplicate security fields and foreign submissions. */
export async function readOAuthForm(request, auth) {
  const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  // no-referrer can make native form Origin null. Accept that case only with
  // browser-controlled Fetch Metadata proving a same-origin submission. A null
  // Origin by itself, a missing Origin, or any foreign origin still fails.
  const privateSameOriginForm = origin === 'null' && site === 'same-origin';
  if (site === 'cross-site' || (origin !== oauthOrigin(auth) && !privateSameOriginForm)) throw new OAuthFlowError();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new OAuthFlowError();
  if (Number(request.headers.get('content-length')) > FORM_LIMIT || !request.body) throw new OAuthFlowError();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FORM_LIMIT) { await reader.cancel(); throw new OAuthFlowError(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new OAuthFlowError(); }
  const form = new URLSearchParams(text);
  for (const key of ['oauth_query', 'accept', 'next']) if (form.getAll(key).length > 1) throw new OAuthFlowError();
  return form;
}

/** Render a fixed retry instruction, never library exception text, callback URLs, state, or codes. */
export function oauthProblem(request, { unavailable = false, headers = new Headers() } = {}) {
  const message = unavailable ? 'Repot cannot complete authorization right now. Return to your MCP client and start a fresh connection attempt shortly.' : FORM_ERROR;
  const status = unavailable ? 503 : 400;
  const code = unavailable ? 'authorization_unavailable' : 'invalid_oauth_request';
  headers = new Headers(headers);
  headers.set('cache-control', 'no-store'); headers.set('referrer-policy', 'no-referrer');
  headers.delete('location'); headers.delete('content-length'); headers.delete('etag');
  if (request.headers.get('accept')?.includes('application/json')) return Response.json({ error: code, message }, { status, headers });
  return authPage('Repot — Connection not completed', `<p class="eyebrow">REPOT / MCP CONNECTION</p><h2>Connection<br><em>not completed.</em></h2><p role="alert">${message}</p><p class="micro">Error code: ${code}</p><a class="button secondary" href="/mcp/">Connection instructions</a>`, { status, headers });
}

/** Create an escaped per-request hidden field; callers only pass a verified request. */
export function oauthHiddenInput(flow) {
  return flow ? `<input type="hidden" name="oauth_query" value="${escapeHtml(flow.query)}">` : '';
}

/**
 * Validate a library-generated handoff against this request's signed callback.
 * Never use a redirect_uri from a separate form field. Intermediate login/consent
 * screens must be same-origin and carry a new valid provider-signed request.
 */
export async function checkedHandoff(value, flow, auth) {
  if (typeof value !== 'string' || value.length > OAUTH_QUERY_LIMIT) throw new OAuthFlowError();
  let target;
  try { target = new URL(value, oauthOrigin(auth)); } catch { throw new OAuthFlowError(); }
  callbackURL(target.href);
  const expected = flow.redirect;
  if (target.origin === expected.origin && target.pathname === expected.pathname) {
    for (const key of new Set(expected.searchParams.keys())) {
      if (JSON.stringify(target.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key))) throw new OAuthFlowError();
    }
    const state = flow.params.get('state');
    if (state && (target.searchParams.getAll('state').length !== 1 || target.searchParams.get('state') !== state)) throw new OAuthFlowError();
    if (!(target.searchParams.get('code') || target.searchParams.get('error'))) throw new OAuthFlowError();
    return target.href;
  }
  if (target.origin === oauthOrigin(auth) && ['/sign-in', '/consent'].includes(target.pathname)) {
    if (!await readOAuthRequest(target.search, auth)) throw new OAuthFlowError();
    return target.href;
  }
  throw new OAuthFlowError();
}

/**
 * Convert only a checked provider result into browser continuation. Enhanced forms
 * fetch this same-origin JSON then navigate top-level, avoiding form-action's
 * cross-origin redirect restriction without weakening CSP. Native forms receive
 * an explicit return link with the same checked URL; neither path claims a token
 * exchange or MCP connection has completed. Preserve all Set-Cookie values.
 */
export async function consentHandoff(request, upstream, flow, auth) {
  const headers = new Headers(upstream.headers);
  let target;
  if (upstream.status >= 300 && upstream.status < 400) target = upstream.headers.get('location');
  else if (upstream.ok) {
    let data;
    try { data = await upstream.json(); } catch { throw new OAuthFlowError(); }
    if (data?.redirect !== true) throw new OAuthFlowError();
    target = data.url;
  } else return oauthProblem(request, { unavailable: upstream.status >= 500, headers });
  const url = await checkedHandoff(target, flow, auth);
  for (const name of ['location', 'content-length', 'content-type', 'etag']) headers.delete(name);
  headers.set('cache-control', 'no-store'); headers.set('referrer-policy', 'no-referrer');
  if (request.headers.get('accept')?.includes('application/json')) return Response.json({ redirect: true, url }, { headers });
  return authPage('Repot — Return to your app', `<p class="eyebrow">REPOT / MCP CONNECTION</p><h2>Return to<br><em>your app.</em></h2><p>Your authorization decision has been processed. Continue to the requesting app to finish connecting.</p><a class="button primary" href="${escapeHtml(url)}" rel="noreferrer">Return to requesting app</a>`, { headers });
}
