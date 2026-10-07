import {BILLING_CSS} from '../../../remote/billing-http.mjs';
export function GET() { return new Response(BILLING_CSS,{headers:{'content-type':'text/css; charset=utf-8','cache-control':'public, max-age=3600'}}); }
