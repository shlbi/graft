/**
 * @file OAuth discovery route used by remote MCP clients to locate Repot authorization metadata.
 *
 * Security-sensitive route: keep authentication, redirects, and response caching explicit.
 */
import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
/**
 * @function GET
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function GET(request){const url=new URL(request.url);url.pathname='/api/auth/.well-known/oauth-authorization-server';return getAuth().handler(new Request(url,{headers:request.headers}));}
/**
 * @function OPTIONS
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function OPTIONS(){return new Response(null,{status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, OPTIONS'}});}
