/** @file Execute the real MCP registration/handlers with explicit SDK, DB and provider doubles. No real authentication or publication. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {publicJobError} from '../draft-job-errors.mjs';

/** Load only known imports so tests cannot accidentally call live services. */
async function fixture(review) {
  const events=[],shape=new Proxy({}, {get:()=>()=>shape});
  class Fault extends Error {constructor(message,status){super(message);this.status=status;}}
  class McpServer {constructor(){this.tools=new Map();} registerTool(n,c,fn){this.tools.set(n,{config:c,call:fn});} registerResource(){}}
  const jobService={start:async(u,a)=>{events.push(['start',u,a]);return{jobId:'job',status:'queued'};},status:async(u,id)=>{events.push(['status',u,id]);return{status:'running',jobId:id};},cancel:async(u,id)=>{events.push(['cancel',u,id]);return{status:'cancelled'};}};
  const imports={
    '@modelcontextprotocol/server':{McpServer,createMcpHandler:f=>({factory:f})},
    'zod/v4':{object:()=>shape,string:()=>shape,literal:()=>shape,number:()=>shape},
    '../web/lib/core.mjs':{analyze:()=>{throw Error('Unexpected engine');}},
    '../web/lib/core-base.mjs':{Fault},
    './github.mjs':{githubTokenForUser:async()=>{events.push(['github-token']);return'test';},listRepositories:()=>[],snapshotRepository:()=>{throw Error('Unexpected snapshot');},publishDraft:async()=>{events.push(['publish']);return{url:'synthetic-pr'};}},
    './reviews.mjs':{getReview:async()=>review,publishStoredReview:async(u,id,fn)=>fn(review),incrementUsage:async()=>events.push(['quota'])},
    './draft-service.mjs':{draftService:()=>jobService},'./draft-job-errors.mjs':{publicJobError}
  };
  const context=vm.createContext({URL,Request,Response,Headers});
  const module=new vm.SourceTextModule(await readFile(new URL('../mcp.mjs',import.meta.url),'utf8'),{context});
  await module.link(spec=>{assert.ok(imports[spec],spec);return new vm.SyntheticModule(Object.keys(imports[spec]),function(){for(const[k,v]of Object.entries(imports[spec]))this.setExport(k,v);},{context});});
  await module.evaluate();const server=module.namespace.createRepotServer({extra:{userId:'owner'}});
  return {tools:server.tools,events};
}
const output=r=>JSON.parse(r.content[0].text);
test('draft handler returns a job without reading repositories or waiting for an AI response',async()=>{const f=await fixture();const input={feature:'original-pomodoro'};const result=await f.tools.get('repot_draft').call(input);assert.equal(output(result).status,'queued');assert.equal(f.events.length,1);assert.equal(f.events[0][0],'start');assert.equal(f.events[0][1],'owner');assert.equal(f.events[0][2],input);});
test('status and cancellation use the authenticated owner and job ID',async()=>{const f=await fixture();await f.tools.get('repot_draft_status').call({jobId:'owned-job'});await f.tools.get('repot_draft_cancel').call({jobId:'owned-job'});assert.deepEqual(f.events,[['status','owner','owned-job'],['cancel','owner','owned-job']]);});
test('draft metadata requires separate background-storage consent and discourages feature substitution',async()=>{const f=await fixture();const description=f.tools.get('repot_draft').config.description;assert.match(description,/temporary|temporarily/);assert.match(description,/store:false/);assert.match(description,/requestKey/);assert.match(f.tools.get('repot_draft_status').config.description,/Do not change the feature/);});
for(const row of [null,{expired:true},{status:'ready',review:{exportable:false}},{status:'ready',review:{}}])test('missing/expired/blocked review cannot publish or consume a quota',async()=>{const f=await fixture(row);const result=await f.tools.get('repot_publish').call({reviewId:'not-a-job-id',confirmReviewed:true});assert.equal(result.isError,true);assert.equal(f.events.length,0);});
test('publication still requires explicit review confirmation',async()=>{const f=await fixture({status:'ready',review:{exportable:true}});const result=await f.tools.get('repot_publish').call({reviewId:'review-id',confirmReviewed:false});assert.equal(result.isError,true);assert.equal(f.events.length,0);});
test('review returns exportability and verification so an agent can inspect instead of guessing',async()=>{const f=await fixture({status:'ready',review:{exportable:false,changes:[],verification:{tests:'not_run'}}});const result=output(await f.tools.get('repot_review').call({reviewId:'review-id'}));assert.equal(result.exportable,false);assert.equal(result.verification.tests,'not_run');});

/** Check that budget consent is upfront, not requested again for each status poll. */
test('MCP explains bounded repair charges and preserves same-job continuation', async () => {
  const f = await fixture();
  const draft = f.tools.get('repot_draft').config.description;
  assert.match(draft, /default 2, maximum 2/);
  assert.match(draft, /Each model attempt consumes one draft allowance/);
  assert.match(f.tools.get('repot_draft_status').config.description, /continue the SAME job without asking for another approval/);
});
