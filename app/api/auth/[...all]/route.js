/**
 * @file Better Auth catch-all route for Repot authentication and OAuth protocol endpoints.
 *
 * Security-sensitive route: keep authentication, redirects, and response caching explicit.
 */
import {toNextJsHandler} from 'better-auth/next-js';
import {getAuth} from '../../../../remote/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
const handlers=()=>toNextJsHandler(getAuth());
/**
 * @function GET
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function GET(request){return handlers().GET(request);}
/**
 * @function POST
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function POST(request){return handlers().POST(request);}
