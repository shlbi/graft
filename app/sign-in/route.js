/**
 * @file Authentication route used by the Repot GitHub and MCP authorization flow.
 *
 * Security-sensitive route: keep authentication, redirects, and response caching explicit.
 */
/**
 * @function GET
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function GET(request){
  const next=new URL(request.url).searchParams.get('next')||'';
  const safe=next.startsWith('/')&&!next.startsWith('//')?next:'/';
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Repot</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/brand.css"></head><body><div class="page-frame"><header class="masthead"><a class="wordmark" href="/" aria-label="Repot home"><img class="wordmark-logo" src="/assets/repot-mark-c7217cca.png" width="64" height="64" alt=""><span class="wordmark-text">epot</span></a></header><main class="closing"><p class="eyebrow">REPOT / AUTHORIZATION</p><h2>Connect your<br><em>GitHub account.</em></h2><p class="muted">Repot uses your GitHub App authorization to access only repositories the app is installed on. Your MCP client receives a Repot token, never your GitHub token.</p><form method="post" action="/auth/github"><input type="hidden" name="next" value="${safe.replaceAll('&','&amp;').replaceAll('"','&quot;')}"><button class="button primary" type="submit">Continue with GitHub ↗</button></form></main></div></body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}
