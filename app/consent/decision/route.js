/**
 * @file OAuth consent route that presents or records the user authorization decision for Repot MCP.
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
export async function POST(request){const form=await request.formData();return getAuth().api.oauth2Consent({body:{accept:form.get('accept')==='true'},headers:request.headers,asResponse:true});}
