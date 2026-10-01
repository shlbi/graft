/**
 * @file Session-verified browser sign-in confirmation; not a claim of MCP or repository acceptance.
 * Better Auth owns session validation. Only a display name is shown, never auth/provider tokens.
 */
import { getAuth } from '../../remote/auth.mjs';
import { authPage, authUnavailablePage, escapeHtml, readBrowserSession } from '../../remote/auth-ui.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Confirm an actual browser session or explain that login has not completed. */
export async function GET(request) {
  let state;
  try { state = await readBrowserSession(request, options => getAuth().api.getSession(options)); }
  catch { return authUnavailablePage(); }
  if (!state.signedIn) {
    state.headers.set('location', '/sign-in?error=session_missing');
    return new Response(null, { status: 303, headers: state.headers });
  }
  return authPage('Repot — Signed in', `<p class="eyebrow">REPOT / BROWSER SESSION VERIFIED</p><h2>You are<br><em>signed in.</em></h2><p class="muted">${state.displayName ? escapeHtml(state.displayName) + ', your' : 'Your'} Repot browser sign-in is complete.</p><p class="muted">If you started in an MCP client, return there to check its connection or restart its authorization. Browser sign-in alone does not confirm that the client has received a Repot token. No repository changes or transfer checks were performed.</p><div class="hero-actions"><a class="button primary" href="/mcp/">MCP connection instructions ↗︎</a><a class="button secondary" href="/">Back to Repot</a></div>`, { headers: state.headers });
}
