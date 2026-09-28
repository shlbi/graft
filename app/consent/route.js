import {getAuth} from '../../remote/auth.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';

export async function GET(request){
  const auth=getAuth();
  const session=await auth.api.getSession({headers:request.headers});
  if(!session)return Response.redirect(new URL('/sign-in',request.url),302);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Repot</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"></head><body><div class="page-frame"><header class="masthead"><a class="wordmark" href="/" aria-label="Repot home"><img class="wordmark-logo" src="/assets/repot-mark-c7217cca.png" width="64" height="64" alt=""><span class="wordmark-text">epot</span></a></header><main class="closing"><p class="eyebrow">REPOT / MCP CONSENT</p><h2>Let this agent<br><em>use Repot?</em></h2><p class="muted">Repot can inspect repositories you authorized through the GitHub App. AI drafting sends only Repot-selected bounded code context to Repot's configured model. Publishing requires a separate explicit tool call and creates a new <code>repot/*</code> branch plus a draft pull request. Repot never auto-merges.</p><div class="hero-actions"><form method="post" action="/consent/decision"><input type="hidden" name="accept" value="true"><button class="button primary" type="submit">Authorize ↗︎</button></form><form method="post" action="/consent/decision"><input type="hidden" name="accept" value="false"><button class="button secondary" type="submit">Deny</button></form></div></main></div></body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}
