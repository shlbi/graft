/**
 * @file Browser sign-in page with explicit callback errors and session-aware navigation.
 * No query parameter can mark a user signed in; Better Auth must verify the cookie.
 */
import { getAuth } from '../../remote/auth.mjs';
import { authPage, authUnavailablePage, errorAlert, escapeHtml, readBrowserSession, safeNextPath, signInError } from '../../remote/auth-ui.mjs';
import { OAuthFlowError, oauthHiddenInput, oauthProblem, readOAuthRequest } from '../../remote/oauth-flow.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Display a sanitized callback error or send an already-signed-in user to a safe destination. */
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const next = safeNextPath(params.get('next'));
  const error = signInError(params);
  let state, flow;
  try {
    const auth = getAuth();
    flow = await readOAuthRequest(new URL(request.url).search, auth);
    state = await readBrowserSession(request, options => auth.api.getSession(options));
  }
  catch (error) { return error instanceof OAuthFlowError ? oauthProblem(request) : authUnavailablePage(); }
  // MCP login must retain its signed query, including forced-login/max-age policy.
  // Passing oauth_query to signInSocial lets Better Auth resume on its callback.
  // Only standalone browser sign-ins use the ordinary /connected destination.
  if (state.signedIn && !error && !flow) {
    state.headers.set('location', next);
    return new Response(null, { status: 303, headers: state.headers });
  }
  const existingSessionNote = state.signedIn && error ? '<p class="muted">You still have an existing Repot session, but this new authorization attempt failed. <a href="/connected">View your current connection.</a></p>' : '';
  return authPage('Connect Repot', `<p class="eyebrow">REPOT / AUTHORIZATION</p><h2>Connect your<br><em>GitHub account.</em></h2>${errorAlert(error)}${existingSessionNote}<p class="muted">Sign in with your GitHub account. No email address is required. Browser sign-in and permission for your MCP client are separate steps; neither performs a code transfer.</p><form method="post" action="/auth/github">${oauthHiddenInput(flow)}<input type="hidden" name="next" value="${escapeHtml(next)}"><button class="button primary" type="submit">Continue with GitHub ↗︎</button></form>`, { headers: state.headers });
}
