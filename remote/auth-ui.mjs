/**
 * @file Safe presentation and navigation helpers for Repot's browser sign-in flow.
 * No provider tokens, OAuth codes, state, or error descriptions are rendered here.
 * Query parameters are untrusted display hints; only Better Auth verifies sessions.
 */
const ORIGIN = 'https://getrepot.com';
export const SIGNED_IN_PATH = '/connected';
const ERRORS = Object.freeze({
  email_not_found: 'Repot does not require your email. This error indicates an older or misconfigured sign-in flow. Start a fresh attempt; if it repeats, the app owner must check the GitHub identity adapter.',
  email_not_verified: 'Repot signs in with your GitHub account, not email verification. Start a fresh attempt; if this repeats, the app owner must check the deployed GitHub-only auth configuration.',
  unable_to_get_user_info: 'Repot could not read your GitHub profile. The app owner should check its account permissions and GitHub availability, then retry. This message alone does not identify which upstream check failed.',
  state_not_found: 'This sign-in attempt expired or its verification cookie is missing. Start a new attempt in this browser and allow cookies for Repot.',
  state_mismatch: 'The sign-in verification did not match. Start a new attempt in the same browser instead of reusing a previous GitHub authorization link.',
  state_invalid: 'This sign-in attempt is no longer valid. Start a new attempt in the same browser.',
  invalid_code: 'GitHub could not complete the authorization-code exchange. Start a fresh sign-in attempt; if it repeats, the app owner must check the callback URL and GitHub App credentials.',
  invalid_callback_request: 'Repot received an invalid GitHub callback. Start a new sign-in attempt from this page.',
  no_code: 'GitHub did not return an authorization code. Start a new sign-in attempt and complete the authorization.',
  no_callback_url: 'The sign-in destination was missing. Start a new sign-in attempt from this page.',
  oauth_provider_not_found: 'GitHub sign-in is not configured correctly on Repot. The app owner must check the provider configuration.',
  unable_to_create_user: 'GitHub returned, but Repot could not create your account. The app owner must check the authentication database and its schema. Please do not change your keys to troubleshoot this message.',
  unable_to_create_session: 'Repot could not create a login session. The app owner must check authentication storage and configuration.',
  unable_to_link_account: 'Repot could not link this GitHub identity. The app owner must investigate the account-linking error; retrying cannot bypass that check.',
  account_not_linked: 'This GitHub identity is not linked to the existing Repot account. Use the original sign-in method or contact the app owner.',
  account_already_linked_to_different_user: 'This GitHub identity is already linked to another Repot account. Contact the app owner rather than creating a duplicate.',
  signup_disabled: 'New Repot account registration is currently disabled. Contact the app owner for access.',
  access_denied: 'GitHub authorization was declined or denied. Start again when you are ready to authorize Repot.',
  session_missing: 'The browser returned without a valid Repot session. Start a fresh sign-in attempt and allow cookies for Repot. If it repeats, report this error code to the app owner.',
  internal_server_error: 'Repot encountered an authentication error. The app owner must inspect the server-side failure.',
  auth_unavailable: 'Repot cannot check login sessions right now. No successful sign-in has been confirmed. Please try again shortly.',
  auth_failed: 'GitHub sign-in did not complete. Start a new attempt; if it repeats, report the error code shown here. Do not share OAuth links, codes, cookies, or secrets.'
});

/** Escape text and attribute values inserted into our server-rendered HTML. */
export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * Accept only bounded same-origin paths for the post-login destination.
 * Reject backslash/control encodings and auth-entry/callback loops. OAuth state
 * itself remains entirely owned and verified by Better Auth, not this helper.
 */
export function safeNextPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//')) return SIGNED_IN_PATH;
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return SIGNED_IN_PATH;
  try {
    const url = new URL(value, ORIGIN);
    const decoded = decodeURIComponent(url.pathname);
    if (url.origin !== ORIGIN || /[\\\u0000-\u0020\u007f]/.test(decoded) || decoded.startsWith('//')) return SIGNED_IN_PATH;
    const canonicalPath = new URL(decoded, ORIGIN).pathname.replace(/\/+$/, '');
    if (['/sign-in', '/auth/github', '/auth/callback', '/api/auth/error'].includes(canonicalPath) ||
        canonicalPath.startsWith('/api/auth/callback') || canonicalPath.startsWith('/api/auth/sign-in')) return SIGNED_IN_PATH;
    return url.pathname + url.search + url.hash;
  } catch { return SIGNED_IN_PATH; }
}

/**
 * Map only known callback error codes to fixed, actionable messages. Older OAuth
 * attempts may have error=github plus a second, real error; prefer the latter.
 * Never reflect arbitrary error_description, state, code, or provider URLs.
 */
export function signInError(params) {
  const errors = params.getAll('error');
  if (!errors.length) return null;
  const selected = errors.filter(code => code !== 'github');
  const last = selected.at(-1) ?? 'auth_failed';
  const code = Object.hasOwn(ERRORS, last) ? last : 'auth_failed';
  return { code, message: ERRORS[code] };
}

/** Render an allowlisted authentication failure as an accessible, non-secret alert. */
export function errorAlert(error) {
  if (!error) return '';
  return `<section class="notice" role="alert" aria-labelledby="auth-error-title"><h3 id="auth-error-title">GitHub sign-in did not finish</h3><p>${escapeHtml(error.message)}</p><p class="micro">Error code: <code>${escapeHtml(error.code)}</code></p></section>`;
}

/**
 * Verify the browser's session through Better Auth, forwarding response cookies
 * to the caller (including refresh/deletion cookies). Expose only display data,
 * never the session token or raw provider/session response in rendered HTML.
 */
export async function readBrowserSession(request, getSession) {
  const upstream = await getSession({ headers: request.headers, asResponse: true });
  if (!(upstream instanceof Response) || !upstream.ok) throw new Error('Session check unavailable');
  const data = await upstream.json();
  const headers = new Headers(upstream.headers);
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.delete('content-length');
  headers.delete('content-type');
  headers.delete('location');
  headers.delete('etag');
  const session = data?.session, user = data?.user;
  const valid = typeof session?.id === 'string' && !!session.id && typeof user?.id === 'string' && !!user.id &&
    session.userId === user.id && new Date(session.expiresAt).getTime() > Date.now();
  return { headers, signedIn: Boolean(valid), displayName: valid && typeof user.name === 'string' ? user.name.slice(0,200) : '' };
}

/** Build the shared, script-free auth shell. Body is authored HTML, not provider content. */
export function authPage(title, body, { status = 200, headers = new Headers() } = {}) {
  headers = new Headers(headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  headers.delete('content-length');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="icon" type="image/png" href="/assets/repot-favicon-c7217cca.png"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"></head><body><div class="page-frame"><header class="masthead"><a class="wordmark" href="/" aria-label="Repot home"><img class="wordmark-logo" src="/assets/repot-mark-c7217cca.png" width="64" height="64" alt="" aria-hidden="true"><span class="wordmark-text" aria-hidden="true">epot</span></a></header><main class="closing">${body}</main></div></body></html>`, { status, headers });
}

/** Render a generic 503 without exposing thrown configuration/database error details. */
export function authUnavailablePage() {
  return authPage('Repot — Sign-in unavailable', errorAlert({ code: 'auth_unavailable', message: ERRORS.auth_unavailable }), { status: 503 });
}
