/**
 * @file Authentication route used by the Repot GitHub and MCP authorization flow.
 *
 * Security-sensitive route: keep authentication, redirects, and response caching explicit.
 */
import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';
/**
 * @function POST
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function POST(request){
  const form=await request.formData();const next=String(form.get('next')||'/');const callbackURL=next.startsWith('/')&&!next.startsWith('//')?next:'/';
  return getAuth().api.signInSocial({body:{provider:'github',callbackURL,errorCallbackURL:'/sign-in?error=github'},headers:request.headers,asResponse:true});
}
