/**
 * @file Foreground AI compatibility and shared proposal-validation regressions.
 * Hosted orchestration timing is now covered by draft-jobs.test.mjs, not the removed synchronous tool.
 * Run with --experimental-vm-modules. The provider and deterministic engine are synthetic boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const proposal={summary:'Timer',changes:[{path:'timer.js',action:'add',content:'export const timer = 1;',sourcePaths:['timer.js'],reason:'test'}],risks:[],suggestedChecks:[]};
const input={source:{name:'source'},destination:{name:'dest',inventory:[]},context:{feature:'timer',source:[],destination:[],testPlan:{}},consent:true,apiKey:'TEST_KEY'};
/** Load actual adapter code against a closed, synthetic engine/network boundary. */
async function adapter(fetchImpl,review=object=>({...object,verification:{tests:'not_run'}})) {
  class Fault extends Error {constructor(message,status){super(message);this.status=status;}}
  const exports={ './core.mjs':{Fault,requireThat:(v,m,s)=>{if(!v)throw new Fault(m,s);},reviewProposal:review}, './github.mjs':{boundedJSON:r=>r.json()}};
  const context=vm.createContext({fetch:fetchImpl,AbortSignal,AbortController,DOMException,Response,Date,setTimeout:(...a)=>setTimeout(...a),clearTimeout:(...a)=>clearTimeout(...a)});
  const mod=new vm.SourceTextModule(await readFile(new URL('../../web/lib/ai.mjs',import.meta.url),'utf8'),{context});
  await mod.link(spec=>{assert.ok(exports[spec]);return new vm.SyntheticModule(Object.keys(exports[spec]),function(){for(const[k,v]of Object.entries(exports[spec]))this.setExport(k,v);},{context});});
  await mod.evaluate();return mod.namespace;
}
/** Flush pending stages with no wall-clock sleep. */
async function flush(){for(let i=0;i<50;i++)await Promise.resolve();}
/** A fake model that finishes only when the virtual timer advances, and observes abort. */
function delayed(ms,calls){return(_url,opts)=>new Promise((resolve,reject)=>{calls.push(opts);const timer=setTimeout(()=>resolve(Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(proposal)}]}]})),ms);opts.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(opts.signal.reason);},{once:true});});}

test('legacy foreground callers retain the 90-second timeout',async t=>{t.mock.timers.enable({apis:['setTimeout']});const calls=[],api=await adapter(delayed(95000,calls));const pending=assert.rejects(api.proposeWithAI(input),e=>e.code==='ai_timeout');await flush();t.mock.timers.tick(90000);await pending;assert.equal(calls.length,1);assert.equal(calls[0].signal.aborted,true);});
test('foreground body-read timeout remains active after headers',async t=>{t.mock.timers.enable({apis:['setTimeout']});const api=await adapter(async(_url,opts)=>new Response(new ReadableStream({start(c){opts.signal.addEventListener('abort',()=>c.error(opts.signal.reason),{once:true});}})));const pending=assert.rejects(api.proposeWithAI({...input,timeoutMs:180000}),e=>e.code==='ai_timeout');await flush();t.mock.timers.tick(180000);await pending;});
test('foreground cancellation still aborts the provider and does not retry',async()=>{const calls=[],api=await adapter(delayed(999999,calls)),c=new AbortController();const pending=assert.rejects(api.proposeWithAI({...input,signal:c.signal}));await flush();c.abort();await pending;assert.equal(calls.length,1);assert.equal(calls[0].signal.aborted,true);});
test('shared request retains model, reasoning, schema, no tools and false storage',async()=>{const api=await adapter(()=>assert.fail('network'));const body=api.buildProposalRequest(input);assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'medium');assert.equal(body.store,false);assert.equal(body.max_output_tokens,12000);assert.equal(body.text.format.strict,true);assert.equal(body.tools,undefined);assert.equal(body.background,undefined);assert.match(body.instructions,/never change source tests/);assert.match(body.instructions,/untrusted data/);assert.deepEqual(JSON.parse(body.input).source.files,[]);});
for(const body of [{status:'incomplete'},{status:'completed',output:[{content:[{type:'refusal'}]}]},{status:'completed',output:[{content:[{type:'output_text',text:'not-json'}]}]},{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({...proposal,changes:[]})}]}]}])test('invalid/refused/incomplete output cannot reach review postprocessor',async()=>{let calls=0;const api=await adapter(()=>{},()=>{calls++;});assert.throws(()=>api.reviewFromAIResponse(body,input));assert.equal(calls,0);});
test('shared review calls the deterministic postprocessor exactly once and retains not_run',async()=>{let calls=0;const api=await adapter(()=>{},p=>{calls++;assert.equal(JSON.stringify(p),JSON.stringify(proposal));return{...p,verification:{tests:'not_run'}};});const r=api.reviewFromAIResponse({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(proposal)}]}],usage:{input_tokens:10,output_tokens:5}},input);assert.equal(calls,1);assert.equal(r.verification.tests,'not_run');assert.equal(r.usage.inputTokens,10);});
