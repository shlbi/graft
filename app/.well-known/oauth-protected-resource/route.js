import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(request){const url=new URL(request.url);url.pathname='/api/auth/.well-known/oauth-protected-resource';return getAuth().handler(new Request(url,{headers:request.headers}));}
export async function OPTIONS(){return new Response(null,{status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET, OPTIONS'}});}
