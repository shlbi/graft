/**
 * @file Session-checked MCP consent screen. Each form carries the exact verified
 * signed authorization query, including client state, PKCE and resource values.
 * This page never grants consent on GET or keeps a shared last-request cookie.
 */
import { getAuth } from '../../remote/auth.mjs';
import { authPage, escapeHtml, readBrowserSession } from '../../remote/auth-ui.mjs';
import { OAuthFlowError, oauthHiddenInput, oauthProblem, readOAuthRequest } from '../../remote/oauth-flow.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verify request and session before showing the real client/scope request and both decisions. */
export async function GET(request) {
  try {
    const auth = getAuth();
    const flow = await readOAuthRequest(new URL(request.url).search, auth);
    if (!flow) throw new OAuthFlowError();
    const state = await readBrowserSession(request, options => auth.api.getSession(options));
    if (!state.signedIn) {
      // Keep the provider's request through login rather than dropping it at /sign-in.
      state.headers.set('location', '/sign-in?' + flow.query);
      return new Response(null, { status: 303, headers: state.headers });
    }
    const scopes = flow.scopes.map(scope => `<li><code>${escapeHtml(scope)}</code></li>`).join('');
    const claims = flow.params.get('claims');
    // The claims request is signature-checked and escaped, not evaluated as HTML.
    const claimsNote = claims ? `<details><summary>Requested identity claims</summary><pre>${escapeHtml(claims)}</pre></details>` : '';
    const hidden = oauthHiddenInput(flow);
    const form = (accept, label, style) => `<form data-oauth-consent method="post" action="/consent/decision">${hidden}<input type="hidden" name="accept" value="${accept}"><button class="button ${style}" type="submit">${label}</button></form>`;
    return authPage('Authorize Repot', `<p class="eyebrow">REPOT / MCP CONSENT</p><h2>Let this agent<br><em>use Repot?</em></h2><p>Requesting client: <code>${escapeHtml(flow.clientId)}</code></p><p>Returns to <code>${escapeHtml(flow.redirect.origin)}</code>.</p><details open><summary>Requested permissions</summary><ul>${scopes || '<li>No additional scopes requested.</li>'}</ul>${claimsNote}</details><p class="muted">Repot can inspect repositories you authorized through the GitHub App. AI drafting shares selected code with Repot's configured model only after an explicit tool request. Publication creates a separate branch and draft pull request; Repot never auto-merges.</p><div class="hero-actions">${form('true', 'Authorize ↗︎', 'primary')}${form('false', 'Deny', 'secondary')}</div><p id="oauth-status" role="status" aria-live="polite"></p><script type="module" src="/oauth-consent.mjs"></script>`, { headers: state.headers });
  } catch (error) { return oauthProblem(request, { unavailable: !(error instanceof OAuthFlowError) }); }
}
