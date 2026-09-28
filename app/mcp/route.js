import {requireMcpAuth} from '@better-auth/mcp';
import {getAuth} from '../../remote/auth.mjs';
import {mcpHandler} from '../../remote/mcp.mjs';
import {resource} from '../../remote/env.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';export const maxDuration=60;
function bearer(request){const value=request.headers.get('authorization')||'';return value.startsWith('Bearer ')?value.slice(7):'';}
export async function POST(request){
  const protectedPost=requireMcpAuth(getAuth(),(req,claims)=>{
    const scopes=typeof claims.scope==='string'?claims.scope.split(/\s+/).filter(Boolean):[];
    return mcpHandler.fetch(req,{authInfo:{token:bearer(req),clientId:String(claims.client_id||''),scopes,extra:{userId:String(claims.sub||'')}}});
  },{resource:resource(),requiredScopes:['repot:read','repot:write'],challengeScopes:['repot:read','repot:write']});
  return protectedPost(request);
}
export async function GET(request){
  const host=(request.headers.get('host')||'').split(':')[0].toLowerCase();
  if(host==='mcp.getrepot.com')return new Response(null,{status:405,headers:{Allow:'POST'}});
  const {readFile}=await import('node:fs/promises');const {resolve}=await import('node:path');
  return new Response(await readFile(resolve(process.cwd(),'public/mcp/index.html')),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'public, max-age=300'}});
}
