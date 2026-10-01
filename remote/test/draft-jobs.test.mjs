/** @file Executable resumable-job tests with durable-store/provider doubles. No real network, billing or GitHub writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftJobs, draftRequest, draftJobStatus } from '../draft-jobs.mjs';
import { DraftJobError, publicJobError } from '../draft-job-errors.mjs';

const args = { sourceRepo:'SHLBI/focusflow',destinationRepo:'shlbi/test',feature:'Pomodoro timer with pause and resume',requestKey:'pomodoro-test-001',allowAI:true,allowBackgroundProcessing:true };
const prepared = { source:{meta:{name:'shlbi/focusflow'},snapshot:{revision:'a'.repeat(40)}},destination:{meta:{name:'shlbi/test'},snapshot:{revision:'b'.repeat(40)}},context:{feature:args.feature} };

/** Simulate durable storage across service instances, lease ownership and transactional review creation. */
function fixture() {
  let time = 1000000, seq = 0, submits = 0, polls = 0, charges = 0, prepareCalls = 0;
  let pollResult = {id:'resp_synthetic',status:'in_progress'};
  const jobs = new Map(), reviews = new Map(), cleanups = [];
  let failPrepare = false, failSubmit = null, failPoll = null, failReview = false, failCleanup = false;
  let holdPrepare = null;
  const copy = value => structuredClone(value);
  const get = (user, id) => { const r=jobs.get(id); if(!r||r.user_id!==user) throw new DraftJobError('job_not_found'); return r; };
  const lease = claimed => {const r=get(claimed.user_id,claimed.id);if(r.lease_token!==claimed.lease_token)throw new DraftJobError('service_unavailable');return r;};
  const terminal = row => ['completed','failed','cancelled'].includes(row.state);
  const store = {
    async create(user,key,hash,request) {const prior=[...jobs.values()].find(r=>r.user_id===user&&r.request_key===key);if(prior){if(prior.request_hash!==hash)throw new DraftJobError('request_key_conflict');return copy(prior);}
      const r={id:String(++seq).padStart(32,'0'),user_id:user,request_key:key,request_hash:hash,state:'queued',payload:JSON.stringify({version:1,request}),cancel_requested:false,charged:false,cleanup_pending:false,expires_at:new Date(time+3600000)};jobs.set(r.id,r);return copy(r);},
    async get(user,id){return copy(get(user,id));},
    async claim(user,id){const r=get(user,id);if(terminal(r)||r.lease_token)return null;r.lease_token='lease-'+(++seq);return copy(r);},
    context(r){return JSON.parse(r.payload);},
    async prepared(c,v){const r=lease(c);if(!r.cancel_requested){r.state='prepared';r.payload=JSON.stringify(v);}return copy(r);},
    async beginSubmission(c){const r=lease(c);if(r.cancel_requested||r.state!=='prepared')return null;charges++;r.charged=true;r.state='submitting';r.provider_started_at=new Date(time);return copy(r);},
    async running(c,id){const r=lease(c);r.response_id=id;r.state='running';return copy(r);},
    async complete(c,v,review){const r=lease(c);if(r.cancel_requested||r.state!=='running')return copy(r);r.review_id='review-'+(++seq);reviews.set(r.review_id,copy({v,review}));r.state='completed';r.payload=null;r.cleanup_pending=true;return copy(r);},
    async finish(c,state,error_code=null){const r=lease(c);if(terminal(r))return copy(r);Object.assign(r,{state,error_code,payload:null,cleanup_pending:Boolean(r.response_id)});return copy(r);},
    async requestCancel(user,id){const r=get(user,id);if(!terminal(r))r.cancel_requested=true;return copy(r);},
    async release(c){const r=get(c.user_id,c.id);if(r.lease_token===c.lease_token)r.lease_token=null;},
    async cleaned(user,id){const r=get(user,id);r.cleanup_pending=false;r.response_id=null;}
  };
  const provider={async start(payload,consent){submits++;assert.equal(consent,true);assert.equal(payload.feature,args.feature);if(failSubmit)throw failSubmit;return {id:'resp_synthetic',status:'queued'};},
    async retrieve(id){polls++;assert.equal(id,'resp_synthetic');if(failPoll)throw failPoll;return copy(pollResult);},
    async cleanup(id,cancel){cleanups.push({id,cancel});if(failCleanup)throw Error('PRIVATE_PROVIDER_BODY');}};
  const service=()=>createDraftJobs({store,provider,now:()=>time,
    prepare:async(request,user,signal)=>{prepareCalls++;assert.equal(user,'alice');assert.equal(request.feature,args.feature);if(holdPrepare)await holdPrepare;signal.throwIfAborted();if(failPrepare)throw Error('PRIVATE_REPO_CODE');return copy(prepared);},
    buildRequest:value=>({feature:value.request.feature}),reviewResponse:()=>{if(failReview)throw Error('PRIVATE_GENERATION');return {exportable:true,verification:{tests:'not_run'},changes:[{path:'pomodoro.js'}]};}});
  return {service,store,jobs,reviews,cleanups,get submits(){return submits;},get polls(){return polls;},get charges(){return charges;},get prepareCalls(){return prepareCalls;},
    tick:ms=>{time+=ms;},complete:()=>{pollResult={id:'resp_synthetic',status:'completed'};},
    failPrepare:()=>{failPrepare=true;},failSubmit:e=>{failSubmit=e;},failPoll:e=>{failPoll=e;},failReview:()=>{failReview=true;},failCleanup:()=>{failCleanup=true;},holdPrepare:p=>{holdPrepare=p;}};
}

/** Reach provider-running state through three separate short calls. */
async function running(f) {const started=await f.service().start('alice',args);await f.service().status('alice',started.jobId);await f.service().status('alice',started.jobId);return started.jobId;}

test('start returns a durable job ID before repository reads or model submission',async()=>{const f=fixture();const result=await f.service().start('alice',args);assert.equal(result.status,'queued');assert.equal(result.nextTool,'repot_draft_status');assert.equal(f.prepareCalls,0);assert.equal(f.submits,0);assert.equal(f.charges,0);assert.ok(!('reviewId'in result));});
test('repeat start with same key returns the same job without a duplicate or a charge',async()=>{const f=fixture();const a=await f.service().start('alice',args),b=await f.service().start('alice',args);assert.equal(a.jobId,b.jobId);assert.equal(f.jobs.size,1);assert.equal(f.submits,0);});
test('reusing a retry key for a substituted feature is rejected',async()=>{const f=fixture();await f.service().start('alice',args);await assert.rejects(f.service().start('alice',{...args,feature:'JSON export instead'}),e=>e.code==='request_key_conflict');assert.equal(f.submits,0);});
for(const ms of [61200,95000,150000,350000]) test(`generation lasting ${ms}ms is polled, not held inside one MCP request`,async()=>{const f=fixture(),id=await running(f);const pending=await f.service().status('alice',id);assert.equal(pending.status,'running');f.tick(ms);f.complete();const result=await f.service().status('alice',id);assert.equal(result.status,'completed');assert.equal(result.nextTool,'repot_review');assert.equal(f.charges,1);assert.equal(f.submits,1);assert.equal(f.reviews.size,1);assert.equal(f.jobs.get(id).payload,null);assert.ok(result.reviewId);});
test('fresh service instances resume the same durable job and already saved review',async()=>{const f=fixture(),id=await running(f);f.complete();const a=await f.service().status('alice',id),b=await f.service().status('alice',id);assert.equal(a.reviewId,b.reviewId);assert.equal(f.reviews.size,1);assert.equal(f.submits,1);});
test('simultaneous polls cannot perform two preparation or generation steps',async()=>{const f=fixture();let release;f.holdPrepare(new Promise(r=>release=r));const {jobId}=await f.service().start('alice',args);const a=f.service().status('alice',jobId);await new Promise(r=>setImmediate(r));const b=await f.service().status('alice',jobId);assert.equal(b.status,'queued');release();await a;assert.equal(f.prepareCalls,1);await Promise.all([f.service().status('alice',jobId),f.service().status('alice',jobId)]);assert.equal(f.submits,1);assert.equal(f.charges,1);});
test('a leased abandoned submission is not automatically sent again after recovery',async()=>{const f=fixture(),{jobId}=await f.service().start('alice',args);const r=f.jobs.get(jobId);r.state='submitting';r.charged=true;const result=await f.service().status('alice',jobId);assert.equal(result.error.code,'submission_unknown');assert.equal(f.submits,0);assert.equal(f.reviews.size,0);});
test('unknown provider dispatch acknowledgement is terminal and never auto-retried',async()=>{const f=fixture();f.failSubmit(new DraftJobError('submission_unknown'));const id=await running(f);const result=await f.service().status('alice',id);assert.equal(result.status,'failed');assert.equal(result.error.code,'submission_unknown');assert.equal(f.submits,1);assert.equal(f.charges,1);});
test('repository preparation failure does not spend a draft allowance',async()=>{const f=fixture();f.failPrepare();const {jobId}=await f.service().start('alice',args);const result=await f.service().status('alice',jobId);assert.equal(result.error.code,'preparation_failed');assert.equal(f.submits,0);assert.equal(f.charges,0);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));});
test('poll transport failure is resumable without another provider POST',async()=>{const f=fixture(),id=await running(f);f.failPoll(new DraftJobError('service_unavailable'));await assert.rejects(f.service().status('alice',id));assert.equal(f.jobs.get(id).state,'running');f.failPoll(null);f.complete();assert.equal((await f.service().status('alice',id)).status,'completed');assert.equal(f.submits,1);});
test('expired provider result fails instead of silently regenerating a smaller feature',async()=>{const f=fixture(),id=await running(f);f.tick(8*60000);const result=await f.service().status('alice',id);assert.equal(result.error.code,'response_unavailable');assert.equal(f.submits,1);assert.equal(f.polls,0);assert.equal(f.reviews.size,0);});
test('invalid generated proposal never creates a review',async()=>{const f=fixture(),id=await running(f);f.failReview();f.complete();const result=await f.service().status('alice',id);assert.equal(result.error.code,'invalid_proposal');assert.equal(f.reviews.size,0);assert.equal(f.jobs.get(id).payload,null);});
test('cancel queued job before any provider charge',async()=>{const f=fixture(),{jobId}=await f.service().start('alice',args);const result=await f.service().cancel('alice',jobId);assert.equal(result.status,'cancelled');assert.equal(f.submits,0);assert.equal(f.charges,0);});
test('cancel running job requests provider cancellation and never creates a review',async()=>{const f=fixture(),id=await running(f);const result=await f.service().cancel('alice',id);assert.equal(result.status,'cancelled');assert.deepEqual(f.cleanups,[{id:'resp_synthetic',cancel:true}]);assert.equal(f.reviews.size,0);});
test('cancellation while preparation is leased cannot race into a charge',async()=>{const f=fixture();let release;f.holdPrepare(new Promise(r=>release=r));const {jobId}=await f.service().start('alice',args);const pending=f.service().status('alice',jobId);await new Promise(r=>setImmediate(r));await f.service().cancel('alice',jobId);release();await pending;const result=await f.service().status('alice',jobId);assert.equal(result.status,'cancelled');assert.equal(f.charges,0);});
test('cancellation after completion does not destroy or duplicate the review',async()=>{const f=fixture(),id=await running(f);f.complete();const result=await f.service().status('alice',id);const later=await f.service().cancel('alice',id);assert.equal(later.status,'completed');assert.equal(result.reviewId,later.reviewId);assert.equal(f.reviews.size,1);});
test('cleanup failure remains visible, not a false deletion claim',async()=>{const f=fixture(),id=await running(f);f.failCleanup();f.complete();const result=await f.service().status('alice',id);assert.equal(result.status,'completed');assert.equal(result.providerCleanupPending,true);assert.ok(!JSON.stringify(result).includes('PRIVATE_'));});
test('another user cannot poll, cancel, or retrieve provider IDs',async()=>{const f=fixture(),id=await running(f);for(const fn of ['status','cancel'])await assert.rejects(f.service()[fn]('bob',id),e=>e.code==='job_not_found');assert.equal(f.polls,0);assert.equal(f.cleanups.length,0);});
test('status output strips snapshots, provider IDs, encryption data and lease fields',()=>{const result=draftJobStatus({id:'job',state:'running',request_key:'key',response_id:'SECRET_RESPONSE',payload:'SECRET_CODE',lease_token:'SECRET_LEASE'});assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.nextTool,'repot_draft_status');});
for(const bad of [{allowAI:false},{allowBackgroundProcessing:false},{requestKey:'short'},{destinationRepo:'SHLBI/FOCUSFLOW'},{sourceRepo:'shlbi/..'},{feature:'a'}])test('invalid or unconsented request is blocked: '+JSON.stringify(bad),()=>{assert.throws(()=>draftRequest({...args,...bad}),DraftJobError);});
test('public errors do not expose raw exception or database contents',()=>{for(const e of [Error('SECRET_SQL'),{code:'evil',message:'SECRET_TOKEN'},{code:'42P01',message:'SECRET_SCHEMA'}])assert.ok(!JSON.stringify(publicJobError(e)).includes('SECRET'));assert.equal(publicJobError({code:'42P01'}).error.code,'setup_required');});

test('lost database acknowledgement of the provider ID is recovered without a second AI request',async()=>{const f=fixture();const original=f.store.running;let count=0;f.store.running=async(...a)=>{const row=await original(...a);if(++count===1)throw Error('lost DB acknowledgement');return row;};const id=await running(f);assert.equal(f.jobs.get(id).state,'running');assert.equal(f.submits,1);assert.equal(f.charges,1);f.complete();assert.equal((await f.service().status('alice',id)).status,'completed');});
