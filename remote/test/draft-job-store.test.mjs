/** @file Execute real PostgreSQL store methods against a recording driver double. Real constraints are tested separately on Neon. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftJobStore} from '../draft-job-store.mjs';

/** Predetermine driver results, retaining exact parameterized statements and transaction ordering. */
function fixture(results) {
  const calls=[],sealed=[];let releases=0;
  const client={async query(text,values){calls.push({text,values});if(/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text))return{rows:[]};const next=results.shift();if(next instanceof Error)throw next;return{rows:next??[]};},release(){releases++;}};
  const store=createDraftJobStore({pool:{connect:async()=>client},seal:value=>{sealed.push(value);return'OPAQUE_CIPHERTEXT';},open:value=>JSON.parse(value),draftLimit:20});
  return{store,calls,sealed,get releases(){return releases;}};
}

test('create encrypts request content and binds idempotency to the owner inside a short transaction',async()=>{const f=fixture([[],[],[{active:0,recent:0}],[{id:'newjob'}]]);await f.store.create('owner','same-key-001','a'.repeat(64),{feature:'PRIVATE_CODE'});const insert=f.calls.find(c=>c.text.startsWith('INSERT INTO public.repot_draft_job'));assert.equal(insert.values[4],'OPAQUE_CIPHERTEXT');assert.equal(insert.values[1],'owner');assert.ok(!JSON.stringify(f.calls).includes('PRIVATE_CODE'));assert.equal(f.sealed[0].request.feature,'PRIVATE_CODE');assert.equal(f.calls.at(-1).text,'COMMIT');assert.equal(f.releases,1);});
test('an existing request key returns prior job before another insert',async()=>{const f=fixture([[],[{id:'existing',request_hash:'same'}]]);assert.equal((await f.store.create('owner','same-key-001','same',{})).id,'existing');assert.ok(!f.calls.some(c=>c.text.startsWith('INSERT')));});
test('key conflict rolls back and always releases the connection',async()=>{const f=fixture([[],[{request_hash:'other'}]]);await assert.rejects(f.store.create('owner','same-key-001','requested',{}),e=>e.code==='request_key_conflict');assert.equal(f.calls.at(-1).text,'ROLLBACK');assert.equal(f.releases,1);});
test('active-job cap rejects before insertion',async()=>{const f=fixture([[],[],[{active:3,recent:3}]]);await assert.rejects(f.store.create('owner','same-key-001','requested',{}),e=>e.code==='too_many_jobs');assert.ok(!f.calls.some(c=>c.text.startsWith('INSERT')));});
test('queries for job ownership bind BOTH job and authenticated user',async()=>{const f=fixture([[{id:'job'}]]);await f.store.get('owner','job');const select=f.calls.find(c=>c.text.startsWith('SELECT'));assert.match(select.text,/id=\$1 AND user_id=\$2/);assert.deepEqual(select.values,['job','owner']);});
test('quota failure cannot mark submission intent or consume another allowance',async()=>{const claimed={id:'job',user_id:'owner',lease_token:'lease',state:'prepared',cancel_requested:false,payload:JSON.stringify({version:1,request:{maxRepairAttempts:2}})};const f=fixture([[claimed],[],[{drafts:20}]]);await assert.rejects(f.store.beginSubmission(claimed),e=>e.code==='draft_limit');assert.ok(!f.calls.some(c=>c.text.startsWith('UPDATE')));assert.equal(f.calls.at(-1).text,'ROLLBACK');});
test('lease mismatch prevents any state update',async()=>{const f=fixture([[{lease_token:'different'}]]);await assert.rejects(f.store.prepared({user_id:'owner',id:'job',lease_token:'old'},{}));assert.ok(!f.calls.some(c=>c.text.startsWith('UPDATE')));});
test('review insertion and completed job reference share one commit and encrypted review bytes',async()=>{const claimed={id:'job',user_id:'owner',lease_token:'lease',state:'running'};const f=fixture([[claimed],[],[{state:'completed'}]]);await f.store.complete(claimed,{source:{meta:{name:'a/source'}},destination:{meta:{name:'b/dest'},snapshot:{revision:'a'.repeat(40)}}},{patch:'PRIVATE_PATCH'});const writes=f.calls.filter(c=>/^(INSERT|UPDATE)/.test(c.text));assert.equal(writes.length,2);assert.match(writes[0].text,/INSERT INTO public.repot_review/);assert.equal(writes[0].values[5],'OPAQUE_CIPHERTEXT');assert.match(writes[1].text,/state='completed'/);assert.equal(writes[0].values[0],writes[1].values[2]);assert.ok(!JSON.stringify(f.calls).includes('PRIVATE_PATCH'));assert.equal(f.calls.at(-1).text,'COMMIT');});
test('a cancellation observed inside finalization writes no review',async()=>{const claimed={id:'job',user_id:'owner',lease_token:'lease',state:'running',cancel_requested:true};const f=fixture([[claimed]]);await f.store.complete(claimed,{},{});assert.ok(!f.calls.some(c=>/^(INSERT|UPDATE)/.test(c.text)));});

/** A server-owned job snapshot with encrypted metadata represented as JSON by this driver double. */
function preparedRow(attempts=0, maxRepairAttempts=2, extra={}) {
  return {id:'job',user_id:'owner',lease_token:'lease',state:'prepared',charged:attempts>0,cancel_requested:false,
    response_id:null,cleanup_pending:false,expires_at:new Date(Date.now()+60000),
    payload:JSON.stringify({version:1,request:{feature:'original',maxRepairAttempts},generation:{attempts}}),...extra};
}

test('initial and repair dispatch count and charge commit atomically with the same encrypted request',async()=>{
  for(const attempts of [0,1,2]){
    const claimed=preparedRow(attempts),f=fixture([[claimed],[],[{drafts:attempts}],[],[{state:'submitting'}]]);
    await f.store.beginSubmission(claimed);
    const writes=f.calls.filter(c=>c.text.startsWith('UPDATE'));
    assert.equal(writes.length,2);assert.match(writes[0].text,/drafts=drafts\+1/);
    assert.match(writes[1].text,/state='submitting'/);assert.equal(writes[1].values[2],'OPAQUE_CIPHERTEXT');
    assert.equal(f.sealed[0].generation.attempts,attempts+1);assert.equal(f.sealed[0].request.feature,'original');
    assert.equal(f.calls.at(-1).text,'COMMIT');
  }
});

test('exhausted attempt budget, expiry and uncleaned response stop before quota writes',async()=>{
  for(const claimed of [preparedRow(3),preparedRow(1,0),preparedRow(0,2,{expires_at:new Date(0)}),preparedRow(1,2,{response_id:'resp_old'}),preparedRow(1,2,{cleanup_pending:true})]){
    const f=fixture([[claimed]]);await assert.rejects(f.store.beginSubmission(claimed));
    assert.ok(!f.calls.some(c=>/^(INSERT|UPDATE)/.test(c.text)));assert.equal(f.calls.at(-1).text,'ROLLBACK');
  }
});

test('cancellation and changed lifecycle cannot consume an attempt',async()=>{
  for(const claimed of [preparedRow(1,2,{cancel_requested:true}),preparedRow(1,2,{state:'running'})]){
    const f=fixture([[claimed]]);assert.equal(await f.store.beginSubmission(claimed),null);
    assert.ok(!f.calls.some(c=>/^(INSERT|UPDATE)/.test(c.text)));
  }
});

test('failed dispatch transaction rolls back quota and counter together',async()=>{
  const claimed=preparedRow(1),f=fixture([[claimed],[],[{drafts:1}],[],Error('driver write failed')]);
  await assert.rejects(f.store.beginSubmission(claimed));
  assert.equal(f.calls.at(-1).text,'ROLLBACK');assert.equal(f.releases,1);
});

test('repair feedback is encrypted; same owner, snapshots and old handle are preserved until cleanup',async()=>{
  const value={version:1,request:{feature:'original',maxRepairAttempts:2},generation:{attempts:1},source:{revision:'pinned'},destination:{revision:'pinned-destination'}};
  const claimed=preparedRow(1,2,{state:'running',response_id:'resp_old',payload:JSON.stringify(value)});
  const f=fixture([[claimed],[{state:'prepared'}]]);
  await f.store.queueRepair(claimed,{diagnostic:{code:'proposal_reason',changeIndex:0},previousProposal:{summary:'PRIVATE_PROPOSAL'}});
  const write=f.calls.find(c=>c.text.startsWith('UPDATE'));
  assert.equal(write.values[2],'OPAQUE_CIPHERTEXT');assert.equal(write.values[3],'proposal_reason');
  assert.match(write.text,/cleanup_pending=true/);assert.doesNotMatch(write.text,/response_id=NULL/);
  assert.deepEqual(f.sealed[0].source,value.source);assert.deepEqual(f.sealed[0].request,value.request);
  assert.equal(f.sealed[0].generation.attempts,1);assert.equal(f.sealed[0].generation.diagnostics[0].code,'proposal_reason');
  assert.ok(!JSON.stringify(f.calls).includes('PRIVATE_PROPOSAL'));
});

test('hard failure, exhaustion, expiry and stale lease cannot queue another repair',async()=>{
  const valid=preparedRow(1,2,{state:'running',response_id:'resp_old'});
  for(const [row,code] of [[valid,'proposal_unsafe_path'],[preparedRow(3,2,{state:'running',response_id:'resp_old'}),'proposal_reason'],[{...valid,expires_at:new Date(0)},'proposal_reason'],[{...valid,lease_token:'new-owner'},'proposal_reason']]){
    const f=fixture([[row]]);await assert.rejects(f.store.queueRepair({...row,lease_token:'lease'},{diagnostic:{code},previousProposal:null}));
    assert.ok(!f.calls.some(c=>c.text.startsWith('UPDATE')));
  }
});

test('repair cleanup only clears the old ID under the same owner and lease',async()=>{
  const claimed=preparedRow(1,2,{response_id:'resp_old',cleanup_pending:true}),f=fixture([[claimed],[{state:'prepared'}]]);
  await f.store.repairCleaned(claimed);
  const write=f.calls.find(c=>c.text.startsWith('UPDATE'));assert.match(write.text,/response_id=NULL/);
  assert.deepEqual(write.values,['job','owner']);assert.match(write.text,/provider_started_at=NULL/);
  for(const changed of [{...claimed,response_id:'resp_new'},{...claimed,state:'running'}]){
    const reject=fixture([[changed]]);await assert.rejects(reject.store.repairCleaned(claimed));
    assert.ok(!reject.calls.some(c=>c.text.startsWith('UPDATE')));
  }
});

test('terminal failure retains only the specific safe reason while dropping discarded code',async()=>{
  const claimed=preparedRow(3,2,{state:'running',response_id:'resp_old'}),f=fixture([[claimed],[{state:'failed'}]]);
  await f.store.finish(claimed,'failed','proposal_source_refs');
  const write=f.calls.find(c=>c.text.startsWith('UPDATE'));assert.match(write.text,/payload=NULL/);
  assert.deepEqual(write.values,['job','owner','failed','proposal_source_refs']);
});

test('legacy key recovery never grants a new budget to an existing job',async()=>{
  const old={id:'old-job',request_hash:'legacy-hash',payload:'old-encrypted'};
  const f=fixture([[],[old]]);
  assert.deepEqual(await f.store.create('owner','key','new-hash',{maxRepairAttempts:2},'legacy-hash'),old);
  assert.equal(f.sealed.length,0);assert.ok(!f.calls.some(c=>/^(INSERT|UPDATE)/.test(c.text)));
});
