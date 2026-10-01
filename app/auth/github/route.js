/**
 * @file Authentication route used by the Repot GitHub and MCP authorization flow.
 *
 * Better Auth's server-side social sign-in API returns a structured OAuth handoff
 * ({ url, redirect: true }). This route turns that handoff into a real browser redirect
 * while preserving any Set-Cookie/state headers emitted by Better Auth.
 */
import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';

/**
 * @function githubRedirect
 * Validates Better Auth's provider URL before placing it in a Location header.
 * Security: only GitHub's HTTPS origin is accepted; malformed or unexpected provider
 * URLs fail closed instead of becoming an open redirect.
 */
function githubRedirect(value){
  let url;
  try{url=new URL(value);}catch{throw new Error('GitHub sign-in returned an invalid authorization URL.');}
  if(url.protocol!=='https:'||url.hostname!=='github.com'||url.pathname!=='/login/oauth/authorize'){
    throw new Error('GitHub sign-in returned an unexpected authorization destination.');
  }
  return url.toString();
}

/**
 * @function POST
 * Starts GitHub OAuth through Better Auth and converts its JSON handoff into an HTTP 302.
 * Cookies and OAuth correlation headers from Better Auth are copied to the redirect response.
 */
export async function POST(request){
  const form=await request.formData();
  const next=String(form.get('next')||'/');
  const callbackURL=next.startsWith('/')&&!next.startsWith('//')?next:'/';
  const upstream=await getAuth().api.signInSocial({
    body:{provider:'github',callbackURL,errorCallbackURL:'/sign-in?error=github'},
    headers:request.headers,
    asResponse:true
  });

  if(upstream.status>=300&&upstream.status<400)return upstream;

  let handoff;
  try{handoff=await upstream.clone().json();}catch{
    return upstream;
  }
  if(!upstream.ok||handoff?.redirect!==true||typeof handoff?.url!=='string')return upstream;

  const headers=new Headers(upstream.headers);
  headers.set('location',githubRedirect(handoff.url));
  headers.set('cache-control','no-store');
  headers.delete('content-type');
  headers.delete('content-length');
  return new Response(null,{status:302,headers});
}
