/**
 * @file Browser sign-in page with explicit callback errors and session-aware navigation.
 * No query parameter can mark a user signed in; Better Auth must verify the cookie.
 */
import { getAuth } from '../../remote/auth.mjs';
import { authPage, authUnavailablePage, errorAlert, escapeHtml, readBrowserSession, safeNextPath, signInError } from '../../remote/auth-ui.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Display a sanitized callback error or send an already-signed-in user to a safe destination. */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const next = safeNextPath(params.get('next'));
  const error = signInError(params);
  let state;
  try { state = await readBrowserSession(request, options => getAuth().api.getSession(options)); }
  catch { return authUnavailablePage(); }
  // A failed new authorization must remain visible even when an old session exists.
  if (state.signedIn && !error) {
    state.headers.set('location', next);
    return new Response(null, { status: 303, headers: state.headers });
  }
  const existingSessionNote = state.signedIn ? '<p class="muted">You still have an existing Repot session, but this new authorization attempt failed. <a href="/connected">View your current connection.</a></p>' : '';
  return authPage('Connect Repot', `<p class="eyebrow">REPOT / AUTHORIZATION</p><h2>Connect your<br><em>GitHub account.</em></h2>${errorAlert(error)}${existingSessionNote}<p class="muted">Sign in with your GitHub account. No email address is required. Browser sign-in and permission for your MCP client are separate steps; neither performs a code transfer.</p><form method="post" action="/auth/github"><input type="hidden" name="next" value="${escapeHtml(next)}"><button class="button primary" type="submit">Continue with GitHub ↗︎</button></form>`, { headers: state.headers });
}
