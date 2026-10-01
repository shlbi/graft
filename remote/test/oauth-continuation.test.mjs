/**
 * @file Executable regressions for signed MCP continuation through login/consent.
 * Uses real route/helper bodies, real HMAC and synthetic Better Auth responses.
 * No production state, GitHub call, paid model call or real MCP token is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { readOAuthRequest, selectOAuthQuery, checkedHandoff, OAUTH_QUERY_LIMIT } from '../oauth-flow.mjs';
import { PUBLIC_ASSETS } from '../../web/connected/public-assets.mjs';
import nextConfig from '../../next.config.mjs';

const root = new URL('../../', import.meta.url);
const origin = 'https://getrepot.com';
const callback = 'https://chatgpt.com/synthetic-connector-callback';
const secret = 'test-only-signed-query-secret-not-a-production-key';
const baseAuth = { options: { baseURL: origin }, $context: Promise.resolve({ secret }) };
const allowed = new Set(['remote/auth-ui.mjs', 'remote/oauth-flow.mjs']);

/** Independent WebCrypto fixture signer for the inspected v1.7.6 HMAC format. */
async function signature(params, signingKey = secret) {
  const sorted = [...params].sort(([a,av],[b,bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  const key = await crypto.webcrypto.subtle.importKey('raw', new TextEncoder().encode(signingKey), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return Buffer.from(await crypto.webcrypto.subtle.sign('HMAC',key,new TextEncoder().encode(new URLSearchParams(sorted).toString()))).toString('base64');
}

/** Build a synthetic provider-signed authorization request, never an actual callback code. */
async function signedQuery(changes = {}) {
  const q = new URLSearchParams({ response_type:'code', client_id:'test-chatgpt-client', redirect_uri:callback,
    scope:'openid profile offline_access repot:read repot:write', state:'test-state+with/slash=&unicode✓',
    code_challenge:'test-pkce-challenge', code_challenge_method:'S256', resource:'https://mcp.getrepot.com/mcp',
    ba_iat:String(Date.now()), exp:String(Math.floor(Date.now()/1000)+300), ...changes });
  // Tests include repeated resources to catch accidental Object.fromEntries collapse.
  q.append('resource','https://resource.example/second');
  for (const name of [...new Set([...q.keys(),'ba_param'])].sort()) q.append('ba_param',name);
  q.append('sig',await signature(q));
  return q.toString();
}

/** Make a request-scoped API substitute; cookies/user data are unmistakably synthetic. */
function fakeAuth(overrides = {}) {
  return { ...baseAuth, api: {
    getSession: async () => Response.json({user:{id:'test-user',name:'Test user'},session:{id:'test-session',userId:'test-user',expiresAt:new Date(Date.now()+60000)}}),
    signInSocial: async () => Response.json({redirect:true,url:'https://github.com/login/oauth/authorize?state=synthetic-provider-state'}),
    oauth2Consent: async () => {throw new Error('Unexpected authorization');},
    ...overrides
  }};
}

/** Load actual route files while replacing only production Better Auth with a bounded stub. */
async function route(file, auth = fakeAuth()) {
  const context = vm.createContext({ URL, URLSearchParams, Headers, Request, Response, Date, TextDecoder, TextEncoder });
  const cache = new Map();
  const authURL = new URL('remote/auth.mjs', root).href;
  const authModule = new vm.SyntheticModule(['getAuth'], function(){this.setExport('getAuth',()=>auth);}, {context,identifier:authURL});
  cache.set(authURL,authModule);
  /** Recursively link only our inspected helpers and standard Node modules. */
  async function load(url) {
    if (cache.has(url)) return cache.get(url);
    if (url === 'node:crypto' || url === 'node:buffer') {
      const exports = url === 'node:crypto' ? { createHmac:crypto.createHmac,timingSafeEqual:crypto.timingSafeEqual } : { Buffer };
      const module = new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context,identifier:url});
      cache.set(url,module);return module;
    }
    const relative = url.slice(root.href.length);
    assert.ok(relative === file || allowed.has(relative), 'Unapproved import: '+relative);
    const module = new vm.SourceTextModule(await readFile(new URL(url),'utf8'),{context,identifier:url});
    cache.set(url,module);
    await module.link((specifier,ref)=>load(specifier.startsWith('node:')?specifier:new URL(specifier,ref.identifier).href));
    return module;
  }
  const module=await load(new URL(file,root).href);await module.evaluate();return module.namespace;
}

/** Decode authored hidden values as a browser would when constructing a form body. */
function hidden(html, name) {
  const match=html.match(new RegExp('name="'+name+'" value="([^"]*)"'));
  return match?.[1].replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
}

/** Send a same-origin native or enhanced form with explicit boolean consent. */
function formRequest(path, fields, json = true, headers = {}) {
  return new Request(origin+path,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',origin,
    'sec-fetch-site':'same-origin',cookie:'test-cookie=synthetic',accept:json?'application/json':'text/html',...headers},body:new URLSearchParams(fields)});
}

/** Emulate only the upstream library's signed-query check and OAuth handoff, not real token issuance. */
function consentAPI(calls) {
  return async options => {
    calls.push(options);
    const flow=await readOAuthRequest(options.body.oauth_query,baseAuth);
    assert.ok(flow,'library must receive original signed query');
    const url=new URL(flow.redirect);url.searchParams.set('state',flow.params.get('state'));url.searchParams.set('iss',origin+'/api/auth');
    url.searchParams.set(options.body.accept?'code':'error',options.body.accept?'SYNTHETIC_CODE':'access_denied');
    const response=Response.json({redirect:true,url:url.href});
    response.headers.append('set-cookie','test-refresh=one; HttpOnly; Secure; Path=/');
    response.headers.append('set-cookie','test-expiry=two; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/');
    return response;
  };
}

test('selects signed fields, preserving repeated resources and special state, while excluding unrelated UI parameters', async()=>{
  const query=await signedQuery();const decorated=query+'&next=%2Fconnected&ui_theme=dark';
  const flow=await readOAuthRequest(decorated,baseAuth);
  assert.equal(flow.query,query);assert.equal(flow.params.getAll('resource').length,2);
  assert.equal(flow.params.get('state'),'test-state+with/slash=&unicode✓');
  assert.equal(selectOAuthQuery('?next=%2Fmcp%2F'),null);
});

for (const field of ['client_id','redirect_uri','state','code_challenge','scope','resource','exp','ba_iat','ba_param']) {
  test('rejects a tampered signed '+field,async()=>{
    const q=new URLSearchParams(await signedQuery());q.set(field,'attacker-change');
    await assert.rejects(readOAuthRequest(q.toString(),baseAuth));
  });
}
for (const field of ['sig','exp','state','client_id','scope','redirect_uri','code_challenge']) {
  test('rejects ambiguous duplicate '+field,async()=>{
    const q=new URLSearchParams(await signedQuery());q.append(field,q.get(field));
    await assert.rejects(readOAuthRequest(q.toString(),baseAuth));
  });
}
for (const query of ['', '?next=/connected']) test('standalone login accepts no MCP query: '+JSON.stringify(query),async()=>assert.equal(await readOAuthRequest(query,baseAuth),null));
for (const query of ['client_id=test','sig=bad','oauth_query=wrapped','x'.repeat(OAUTH_QUERY_LIMIT+1)]) test('malformed/oversized continuation rejected: '+query.slice(0,30),async()=>assert.rejects(readOAuthRequest(query,baseAuth)));

test('expired queries and signatures from another key are rejected',async()=>{
  await assert.rejects(readOAuthRequest(await signedQuery({exp:'1'}),baseAuth));
  const q=new URLSearchParams(await signedQuery());q.delete('sig');q.set('sig',await signature(q,'another-test-key'));
  await assert.rejects(readOAuthRequest(q.toString(),baseAuth));
});

test('logged-out MCP sign-in form retains the signed query and passes it into signInSocial',async()=>{
  const query=await signedQuery();let options;
  const auth=fakeAuth({getSession:async()=>Response.json(null),signInSocial:async value=>{options=value;return Response.json({redirect:true,url:'https://github.com/login/oauth/authorize?state=provider-state'});}});
  const page=await route('app/sign-in/route.js',auth);
  const response=await page.GET(new Request(origin+'/sign-in?'+query+'&next=%2Fwrong-ui-destination'));
  const html=await response.text();assert.equal(response.status,200);assert.equal(hidden(html,'oauth_query'),query);
  const start=await route('app/auth/github/route.js',auth);
  const redirect=await start.POST(formRequest('/auth/github',{next:hidden(html,'next'),oauth_query:hidden(html,'oauth_query')}));
  assert.equal(redirect.status,302);assert.equal(options.body.oauth_query,query);assert.equal(options.body.provider,'github');
  assert.equal(options.headers.get('cookie'),'test-cookie=synthetic');
});

test('normal browser login still omits oauth_query and uses the session-verified success page',async()=>{
  let options;const auth=fakeAuth({signInSocial:async value=>{options=value;return Response.json({redirect:true,url:'https://github.com/login/oauth/authorize'});}});
  const start=await route('app/auth/github/route.js',auth);
  assert.equal((await start.POST(formRequest('/auth/github',{}))).status,302);
  assert.equal(options.body.callbackURL,'/connected');assert.equal(options.body.oauth_query,undefined);
});

test('a signed MCP login is not discarded when a session exists or prompt=login requires reauthentication',async()=>{
  const page=await route('app/sign-in/route.js');const query=await signedQuery({prompt:'login consent'});
  const response=await page.GET(new Request(origin+'/sign-in?'+query));
  assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);
  assert.equal(hidden(await response.text(),'oauth_query'),query);
});

test('unauthenticated consent carries the same signed request through the sign-in redirect',async()=>{
  const page=await route('app/consent/route.js',fakeAuth({getSession:async()=>Response.json(null)}));const query=await signedQuery();
  const response=await page.GET(new Request(origin+'/consent?'+query));
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/sign-in?'+query);
});

test('consent verifies the signature before rendering client/scopes and includes query in both decision forms',async()=>{
  const page=await route('app/consent/route.js');const query=await signedQuery({client_id:'client-<script>sentinel</script>',claims:'{"userinfo":{"name":null}}'});
  const response=await page.GET(new Request(origin+'/consent?'+query));const html=await response.text();
  assert.equal(response.status,200);assert.equal((html.match(/name="oauth_query"/g)||[]).length,2);
  assert.equal(hidden(html,'oauth_query'),query);assert.ok(html.includes('client-&lt;script&gt;sentinel&lt;/script&gt;'));
  assert.match(html,/repot:read/);assert.match(html,/repot:write/);assert.match(html,/Requested identity claims/);
  assert.doesNotMatch(html,/<script>sentinel|unsafe-inline/);assert.match(html,/src="\/oauth-consent.mjs"/);
  assert.equal(response.headers.get('cache-control'),'no-store');
});

for (const search of ['', '?client_id=untrusted', '?sig=bad&client_id=untrusted']) {
  test('consent GET without a valid signed request has no actionable buttons: '+search,async()=>{
    const page=await route('app/consent/route.js');const response=await page.GET(new Request(origin+'/consent'+search));const html=await response.text();
    assert.equal(response.status,400);assert.doesNotMatch(html,/<form|name="accept"|untrusted/);
  });
}

for (const decision of ['true','false']) test('consent '+decision+' returns a checked client handoff with original state and separate cookies',async()=>{
  const calls=[];const auth=fakeAuth({oauth2Consent:consentAPI(calls)});const handler=await route('app/consent/decision/route.js',auth);const query=await signedQuery();
  const response=await handler.POST(formRequest('/consent/decision',{accept:decision,oauth_query:query}));
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.redirect,true);
  const url=new URL(result.url);assert.equal(url.origin,'https://chatgpt.com');assert.equal(url.searchParams.get('state'),new URLSearchParams(query).get('state'));
  assert.equal(url.searchParams.get(decision==='true'?'code':'error'),decision==='true'?'SYNTHETIC_CODE':'access_denied');
  assert.equal(calls[0].body.accept,decision==='true');assert.equal(calls[0].body.oauth_query,query);assert.equal(calls[0].asResponse,true);
  assert.equal(response.headers.getSetCookie().length,2);assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('cache-control'),'no-store');
});

test('native form fallback shows a checked continuation link instead of JSON or a cross-origin form redirect',async()=>{
  const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:consentAPI([])}));
  const response=await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:await signedQuery()},false));
  const html=await response.text();assert.equal(response.status,200);assert.match(html,/Return to requesting app/);assert.match(html,/href="https:\/\/chatgpt.com\/synthetic-connector-callback\?/);
  assert.equal(response.headers.get('location'),null);assert.doesNotMatch(html,/MCP connected|access_token/);
});

for (const fields of [{accept:'true'},{oauth_query:'sig=bad'},{accept:'yes'},{accept:'false',oauth_query:''}]) test('invalid decision inputs cause no authorization mutation: '+JSON.stringify(fields),async()=>{
  let calls=0;const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:async()=>{calls++;throw new Error();}}));
  const response=await handler.POST(formRequest('/consent/decision',fields));assert.equal(response.status,400);assert.equal(calls,0);
});

test('expired, tampered, missing-signature and duplicate decision forms never reach Better Auth',async()=>{
  let calls=0;const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:async()=>{calls++;throw new Error();}}));
  for (const query of [await signedQuery({exp:'1'}),(await signedQuery()).replace('test-chatgpt-client','another-client'),'client_id=test']) {
    assert.equal((await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:query}))).status,400);
  }
  const q=await signedQuery();
  for(const fields of [[['accept','true'],['accept','false'],['oauth_query',q]],[['accept','true'],['oauth_query',q],['oauth_query',q]]]) {
    assert.equal((await handler.POST(formRequest('/consent/decision',fields))).status,400);
  }
  assert.equal(calls,0);
});

for (const originHeader of ['https://attacker.example','null','']) test('foreign/missing Origin cannot grant consent: '+originHeader,async()=>{
  let calls=0;const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:async()=>{calls++;throw new Error();}}));
  const response=await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:await signedQuery()},true,{origin:originHeader,'sec-fetch-site':'cross-site'}));
  assert.equal(response.status,400);assert.equal(calls,0);
});

test('oversized form stops without reaching provider',async()=>{
  let calls=0;const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:async()=>{calls++;throw new Error();}}));
  assert.equal((await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:'x'.repeat(70000)}))).status,400);assert.equal(calls,0);
});

test('provider errors remain errors and never echo exception bodies or query secrets',async()=>{
  for(const upstream of [async()=>Response.json({error_description:'PRIVATE_TOKEN_BODY'},{status:401}),async()=>{throw new Error('postgresql://PRIVATE_DB_PASSWORD');},async()=>new Response('SECRET_NOT_JSON')]) {
    const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:upstream}));
    const response=await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:await signedQuery()}));const data=await response.text();
    assert.ok(response.status>=400);assert.doesNotMatch(data,/PRIVATE_|SECRET_|test-pkce|test-state|sig=/);
  }
});

for(const url of ['https://attacker.example/callback?code=leak','javascript:alert(1)','https://user:password@chatgpt.com/synthetic-connector-callback?code=x','https://chatgpt.com/wrong-path?code=x','https://chatgpt.com/synthetic-connector-callback?code=x&state=wrong']) test('rejects a mismatched result URL: '+url,async()=>{
  const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:async()=>Response.json({redirect:true,url})}));
  const response=await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:await signedQuery()}));assert.equal(response.status,400);
  assert.doesNotMatch(await response.text(),/leak|alert\(1\)|password|wrong-path/);
});

test('two client flows remain isolated when authorizations are interleaved',async()=>{
  const auth=fakeAuth({oauth2Consent:consentAPI([])}),handler=await route('app/consent/decision/route.js',auth);
  const a=await signedQuery({client_id:'client-a',state:'state-a'}),b=await signedQuery({client_id:'client-b',state:'state-b',redirect_uri:'https://second-client.example/callback'});
  const [responseB,responseA]=await Promise.all([handler.POST(formRequest('/consent/decision',{accept:'false',oauth_query:b})),handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:a}))]);
  const urlB=new URL((await responseB.json()).url),urlA=new URL((await responseA.json()).url);
  assert.equal(urlA.searchParams.get('state'),'state-a');assert.equal(urlA.hostname,'chatgpt.com');
  assert.equal(urlB.searchParams.get('state'),'state-b');assert.equal(urlB.hostname,'second-client.example');assert.equal(urlB.searchParams.get('error'),'access_denied');
});

test('registered loopback callbacks work without allowing arbitrary insecure HTTP',async()=>{
  const flow=await readOAuthRequest(await signedQuery({redirect_uri:'http://127.0.0.1:8091/callback',state:'local-state'}),baseAuth);
  assert.equal(await checkedHandoff('http://127.0.0.1:8091/callback?code=test&state=local-state',flow,baseAuth),'http://127.0.0.1:8091/callback?code=test&state=local-state');
  await assert.rejects(readOAuthRequest(await signedQuery({redirect_uri:'http://untrusted.example/callback'}),baseAuth));
});

test('consent client asset is allowlisted and the global CSP remains narrow',async()=>{
  assert.ok(PUBLIC_ASSETS.some(asset=>asset.route==='/oauth-consent.mjs'&&asset.file==='oauth-consent.mjs'));
  const rule=(await nextConfig.headers())[0].headers.find(header=>header.key==='Content-Security-Policy').value;
  assert.ok(rule.includes("form-action 'self' https://github.com"));assert.ok(!rule.includes('chatgpt.com')&&!rule.includes('unsafe-inline')&&!rule.includes('*'));
});


test('native no-referrer form with null Origin requires same-origin Fetch Metadata',async()=>{
  const handler=await route('app/consent/decision/route.js',fakeAuth({oauth2Consent:consentAPI([])}));
  const q=await signedQuery();
  const good=await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:q},false,{origin:'null','sec-fetch-site':'same-origin'}));
  assert.equal(good.status,200);
  for(const site of ['same-site','none','cross-site','']) {
    const bad=await handler.POST(formRequest('/consent/decision',{accept:'true',oauth_query:q},false,{origin:'null','sec-fetch-site':site}));
    assert.equal(bad.status,400);
  }
});
