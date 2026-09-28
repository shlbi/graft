import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';
export async function GET(request){
  const url=new URL(request.url);url.pathname='/api/auth/callback/github';
  return getAuth().handler(new Request(url,{method:'GET',headers:request.headers}));
}
