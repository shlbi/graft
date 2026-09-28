import {toNextJsHandler} from 'better-auth/next-js';
import {getAuth} from '../../../../remote/auth.mjs';
export const runtime='nodejs';export const dynamic='force-dynamic';
const handlers=()=>toNextJsHandler(getAuth());
export async function GET(request){return handlers().GET(request);}
export async function POST(request){return handlers().POST(request);}
