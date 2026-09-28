import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';
export async function POST(request){
  const form=await request.formData();const next=String(form.get('next')||'/');const callbackURL=next.startsWith('/')&&!next.startsWith('//')?next:'/';
  return getAuth().api.signInSocial({body:{provider:'github',callbackURL,errorCallbackURL:'/sign-in?error=github'},headers:request.headers,asResponse:true});
}
