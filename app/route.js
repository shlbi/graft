/**
 * @file Root Next.js route that serves the Repot public application shell.
 *
 * Security-sensitive route: keep authentication, redirects, and response caching explicit.
 */
import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
/**
 * @function GET
 * Handles this HTTP method for the route and returns a bounded Next.js Response.
 * Security: preserve authentication and redirect validation before changing request handling.
 */
export async function GET(){return new Response(await readFile(resolve(process.cwd(),'public/index.html')),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'public, max-age=300'}});}
