/**
 * @file Explicit approve/deny bridge for a single signed MCP authorization request.
 * Better Auth owns authorization, session checks, registration, codes and tokens.
 * Missing, duplicate, expired, tampered or cross-origin submissions fail closed.
 */
import { getAuth } from '../../../remote/auth.mjs';
import { OAuthFlowError, consentHandoff, oauthProblem, readOAuthForm, readOAuthRequest } from '../../../remote/oauth-flow.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Forward both the user's boolean decision and its verified query, then return only a checked handoff. */
export async function POST(request) {
  try {
    const auth = getAuth();
    const form = await readOAuthForm(request, auth);
    const decision = form.get('accept');
    if (decision !== 'true' && decision !== 'false') throw new OAuthFlowError();
    const flow = await readOAuthRequest(form.get('oauth_query') || '', auth);
    if (!flow) throw new OAuthFlowError();
    const upstream = await auth.api.oauth2Consent({
      body: { accept: decision === 'true', oauth_query: flow.query },
      headers: request.headers,
      asResponse: true
    });
    return await consentHandoff(request, upstream, flow, auth);
  } catch (error) { return oauthProblem(request, { unavailable: !(error instanceof OAuthFlowError) }); }
}
