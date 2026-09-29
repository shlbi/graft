/**
 * @file Authentication route used by the Repot GitHub and MCP authorization flow.
 *
 * Security-sensitive route: keep authentication, redirects, and response caching explicit.
 */
import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';
/**
 * @function GET
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function GET(request){
  const url=new URL(request.url);url.pathname='/api/auth/callback/github';
  return getAuth().handler(new Request(url,{method:'GET',headers:request.headers}));
}
