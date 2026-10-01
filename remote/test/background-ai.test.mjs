/** @file Real background transport functions with synthetic HTTP responses; no paid provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundAI} from '../background-ai.mjs';

/** Make a provider with request recording and a fake key that must not escape in errors. */
function fixture(responses) {
  const calls=[];
  return {calls,api:createBackgroundAI({apiKey:'PRIVATE_TEST_KEY',fetchImpl:async(url,options)=>{calls.push({url,options});const r=responses.shift();if(r instanceof Error)throw r;return r;}})};
}

test('background start sends explicit store:false and returns before generated output is available',async()=>{const f=fixture([Response.json({id:'resp_fake',status:'queued'})]);const result=await f.api.start({model:'gpt-6.1-sol',reasoning:{effort:'medium'},input:'synthetic-code',store:true},true);assert.equal(result.status,'queued');assert.equal(f.calls.length,1);const call=f.calls[0];assert.equal(call.url,'https://api.openai.com/v1/responses');assert.equal(call.options.redirect,'error');assert.deepEqual(JSON.parse(call.options.body),{model:'gpt-6.1-sol',reasoning:{effort:'medium'},input:'synthetic-code',store:false,background:true});assert.ok(call.options.signal instanceof AbortSignal);});
test('background storage consent is checked before network',async()=>{const f=fixture([]);await assert.rejects(f.api.start({input:'private'},false),e=>e.code==='background_consent_required');assert.equal(f.calls.length,0);});
test('poll uses only saved response ID and does not resend any source context',async()=>{const f=fixture([Response.json({id:'resp_fake',status:'in_progress'})]);await f.api.retrieve('resp_fake');assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[0].options.body,undefined);assert.equal(f.calls[0].url,'https://api.openai.com/v1/responses/resp_fake');});
for(const id of ['https://evil.example','resp_../secrets','resp_fake?x=1','resp_fake#frag','resp_bad/id',''])test('provider URL injection rejected: '+id,async()=>{const f=fixture([]);await assert.rejects(f.api.retrieve(id));assert.equal(f.calls.length,0);});
test('a mismatched provider response ID is rejected',async()=>{const f=fixture([Response.json({id:'resp_other',status:'completed'})]);await assert.rejects(f.api.retrieve('resp_fake'),e=>e.code==='provider_failed');});
for(const response of [new Error('PRIVATE NETWORK DETAIL'),new Response('{broken'),Response.json({status:'queued'}),new Response('PRIVATE BODY',{status:500})])test('ambiguous starts are never retried or treated as definitely unbilled',async()=>{const f=fixture([response]);await assert.rejects(f.api.start({},true),e=>e.code==='submission_unknown'&&!e.message.includes('PRIVATE'));assert.equal(f.calls.length,1);});
test('HTTP rejection is sanitized and is not retried',async()=>{const f=fixture([new Response('PRIVATE INVALID KEY',{status:401})]);await assert.rejects(f.api.start({},true),e=>e.code==='provider_rejected'&&!e.message.includes('PRIVATE'));assert.equal(f.calls.length,1);});
test('provider expiration is explicit, never a fresh generation',async()=>{const f=fixture([new Response('gone',{status:404})]);await assert.rejects(f.api.retrieve('resp_fake'),e=>e.code==='response_unavailable');assert.equal(f.calls.length,1);});
test('oversized and malformed UTF8 bodies fail closed',async()=>{for(const response of [new Response('x'.repeat(500001)),new Response(new Uint8Array([0xff]))]){const f=fixture([response]);await assert.rejects(f.api.retrieve('resp_fake'));assert.equal(f.calls.length,1);}});
test('terminal cleanup deletes only the exact response',async()=>{const f=fixture([Response.json({deleted:true})]);await f.api.cleanup('resp_fake');assert.equal(f.calls[0].options.method,'DELETE');assert.equal(f.calls.length,1);});
test('cancellation attempts cancel then delete; failures are not hidden as successful deletion',async()=>{const f=fixture([new Response('already complete',{status:400}),Response.json({deleted:true})]);await f.api.cleanup('resp_fake',true);assert.equal(f.calls.length,2);assert.ok(f.calls[0].url.endsWith('/resp_fake/cancel'));assert.equal(f.calls[1].options.method,'DELETE');const bad=fixture([new Response('PRIVATE',{status:503})]);await assert.rejects(bad.api.cleanup('resp_fake'));});
test('already deleted provider response is an idempotent cleanup success',async()=>{const f=fixture([new Response(null,{status:404})]);await f.api.cleanup('resp_fake');});
