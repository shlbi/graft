import {readFile} from 'node:fs/promises';import {resolve} from 'node:path';
export async function GET(){return new Response(await readFile(resolve(process.cwd(),'public/index.html')),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'public, max-age=300'}});}
