import {verifyOAuthQueryParams} from '@better-auth/oauth-provider';
import {getAuth} from '../../remote/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
const esc=s=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export async function GET(request){
  const auth=getAuth(),query=new URL(request.url).search.slice(1),{secret}=await auth.$context;
  if(!(await verifyOAuthQueryParams(query,secret)))return new Response('Invalid or expired authorization request.',{status:400});
  const url=new URL(request.url),client=esc(url.searchParams.get('client_id')||'MCP client'),scope=esc(url.searchParams.get('scope')||'repot:read repot:write');
  const session=await auth.api.getSession({headers:request.headers});
  if(!session)return Response.redirect(new URL('/sign-in',request.url),302);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Repot</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"></head><body><div class="page-frame"><header class="masthead"><a class="wordmark" href="/" aria-label="Repot home"><img class="wordmark-logo" src="/assets/repot-mark-c7217cca.png" width="64" height="64" alt=""><span class="wordmark-text">epot</span></a></header><main class="closing"><p class="eyebrow">REPOT / MCP CONSENT</p><h2>Let this agent<br><em>use Repot?</em></h2><p class="muted">Client: <code>${client}</code></p><p class="muted">Requested access: <code>${scope}</code></p><p class="muted">Repot can inspect repositories you authorized through the GitHub App and, after an explicit publish tool call, create a new branch and draft pull request. It never auto-merges.</p><div class="hero-actions"><form method="post" action="/consent/decision"><input type="hidden" name="accept" value="true"><button class="button primary" type="submit">Authorize ↗</button></form><form method="post" action="/consent/decision"><input type="hidden" name="accept" value="false"><button class="button secondary" type="submit">Deny</button></form></div></main></div></body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}
