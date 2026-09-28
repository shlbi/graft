import {getAuth} from '../../../remote/auth.mjs';
export const runtime='nodejs';
export async function POST(request){const form=await request.formData();return getAuth().api.oauth2Consent({body:{accept:form.get('accept')==='true'},headers:request.headers,asResponse:true});}
