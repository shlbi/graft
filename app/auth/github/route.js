/**
 * @file Authentication route used by the Repot GitHub and MCP authorization flow.
 *
 * Better Auth's server-side social sign-in API returns a structured OAuth handoff
 * ({ url, redirect: true }). This route turns that handoff into a real browser redirect
 * while preserving any Set-Cookie/state headers emitted by Better Auth.
 */
import {getAuth} from '../../../remote/auth.mjs';
import {safeNextPath} from '../../../remote/auth-ui.mjs';
import { OAuthFlowError, oauthProblem, readOAuthForm, readOAuthRequest } from '../../../remote/oauth-flow.mjs';
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
  if(url.origin!=='https://github.com'||url.username||url.password||url.hash||url.pathname!=='/login/oauth/authorize'){
    throw new Error('GitHub sign-in returned an unexpected authorization destination.');
  }
  return url.toString();
}

/**
 * @function GET
 * Lets existing Connect GitHub links reach the sign-in form instead of a 405.
 * This navigation does not call Better Auth, issue cookies, or start OAuth;
 * the user must still submit the form's POST to begin authorization.
 */
export async function GET(request){
  const value=request ? new URL(request.url).searchParams.get('next') : null;
  const location=value===null ? '/sign-in' : '/sign-in?'+new URLSearchParams({next:safeNextPath(value)});
  return new Response(null,{status:303,headers:{location,'cache-control':'no-store'}});
}

/**
 * @function POST
 * Starts GitHub OAuth through Better Auth and converts its JSON handoff into an HTTP 302.
 * Cookies and OAuth correlation headers from Better Auth are copied to the redirect response.
 */
export async function POST(request){
  let form, flow;
  try {
    const auth=getAuth();
    form=await readOAuthForm(request,auth);
    flow=await readOAuthRequest(form.get('oauth_query')||'',auth);
  } catch (error) { return oauthProblem(request,{unavailable:!(error instanceof OAuthFlowError)}); }
  // Both new and returning users land on a session-verified page by default.
  const callbackURL=safeNextPath(form.get('next'));
  // Do not pre-fill error=github: Better Auth supplies its actual failure code.
  const upstream=await getAuth().api.signInSocial({
    // The provider verifies and saves this signed request in server-only OAuth state.
    // Do not replace it with callbackURL or recreate client state after GitHub returns.
    body:{provider:'github',callbackURL,newUserCallbackURL:callbackURL,errorCallbackURL:'/sign-in',...(flow?{oauth_query:flow.query}:{})},
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
