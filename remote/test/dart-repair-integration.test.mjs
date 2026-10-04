/**
 * @file Hosted job lifecycle using the real analysis/AI parser/Dart test adapter.
 * The store and provider are explicit in-memory doubles. No database, paid AI call,
 * Dart compiler or customer repository execution is performed by these tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDraftJobs} from '../draft-jobs.mjs';
import {repairFixture,responseFor} from './repair-fixture.mjs';
import {analyze,snapshot} from '../../web/lib/core.mjs';
import {buildProposalRequest,reviewFromAIResponse} from '../../web/lib/ai.mjs';
import {dartFixture} from '../../web/test/fixtures/dart-transfer-fixture.mjs';

/** Wire actual native planning/review with bounded transport/store substitutes. */
async function nativeJob({alwaysInvalid=false,maxRepairAttempts=2,customConfig=false}={}) {
  const files=dartFixture(),bad=structuredClone(files.proposal);
  bad.changes[0].content="import 'missing.dart';\nint cartTotal(int units)=>priceFor(units);\n";
  if(customConfig)files.source=snapshot({name:files.source.name,revision:files.source.revision,files:[...files.source.files,{path:'dart_test.yaml',content:'concurrency: 1\n'}]});
  const fixture=await repairFixture([responseFor(alwaysInvalid?bad:customConfig?files.proposal:bad),responseFor(alwaysInvalid?bad:files.proposal)]);
  let prepared=0;
  /** Recreate the service per poll; no adapter state is kept in a server process. */
  function service() {return createDraftJobs({store:fixture.store,provider:fixture.provider,
    prepare:async request=>{prepared++;return {source:{meta:{name:files.source.name},snapshot:files.source},destination:{meta:{name:files.destination.name},snapshot:files.destination},context:analyze(files.source,files.destination,request.feature,request).context};},
    buildRequest:value=>buildProposalRequest({source:value.source.snapshot,destination:value.destination.snapshot,context:value.context,repair:value.repair??null}),
    reviewResponse:(response,value)=>reviewFromAIResponse(response,{source:value.source.snapshot,destination:value.destination.snapshot,context:value.context})
  });}
  const args={sourceRepo:files.source.name,destinationRepo:files.destination.name,feature:'cart pricing',requestKey:'native-cart-001',allowAI:true,allowBackgroundProcessing:true,maxRepairAttempts,...files.context.selection};
  const result=await service().start('alice',args);
  return {fixture,files,args,id:result.jobId,service,get prepared(){return prepared;}};
}
/** Stop a mistaken endless loop after 20 iterations rather than silently starting another job. */
async function finish(f) {
  const statuses=[];
  for(let i=0;i<20;i++) {
    const result=await f.service().status('alice',f.id);statuses.push(result);
    if(['completed','failed','cancelled'].includes(result.status))return {result,statuses};
  }
  throw new Error('Native fixture exceeded its finite poll budget');
}

test('one same-job native repair produces a review containing feature, transitive library, tests and helper',async()=>{
  const f=await nativeJob(),before=JSON.stringify([f.files.source,f.files.destination]),{result,statuses}=await finish(f);
  assert.equal(result.status,'completed');assert.equal(f.fixture.jobs.size,1);assert.equal(f.fixture.charges,2);assert.equal(f.prepared,1);
  assert.ok(statuses.every(s=>s.jobId===f.id));assert.ok(statuses.some(s=>s.stage==='adjusting_integration'&&s.continueAutomatically));
  assert.equal(f.fixture.reviews.size,1);const review=f.fixture.reviews.get(result.reviewId);
  assert.equal(review.exportable,true);assert.equal(review.testTransfer.discovered,2);assert.equal(review.changes.length,5);
  assert.equal(review.generation.attempts,2);assert.equal(review.generation.validationHistory[0].code,'proposal_dart_import');
  assert.equal(review.verification.tests,'not_run');
  const first=JSON.parse(f.fixture.requests[0].input),repair=JSON.parse(f.fixture.requests[1].input);
  assert.deepEqual(first.source,repair.source);assert.deepEqual(first.destination,repair.destination);assert.equal(first.feature,repair.feature);
  assert.equal(repair.repairFeedback.diagnostic.code,'proposal_dart_import');assert.deepEqual(repair.testPlan.tests,first.testPlan.tests);
  assert.equal(JSON.stringify([f.files.source,f.files.destination]),before);
});
test('new native rules respect the saved single-attempt budget',async()=>{
  const f=await nativeJob({maxRepairAttempts:0}),{result}=await finish(f);
  assert.equal(result.status,'failed');assert.equal(result.error.code,'proposal_dart_import');assert.equal(f.fixture.charges,1);assert.equal(f.fixture.reviews.size,0);
});
test('repeated invalid native output cannot exceed two repairs or switch the selected feature',async()=>{
  const f=await nativeJob({alwaysInvalid:true}),{result}=await finish(f);
  assert.equal(result.status,'failed');assert.equal(result.repairBudgetExhausted,true);assert.equal(f.fixture.charges,3);assert.equal(f.fixture.requests.length,3);
  assert.equal(f.fixture.reviews.size,0);assert.ok(f.fixture.requests.every(p=>JSON.parse(p.input).feature==='cart pricing'));
});
test('native setup limitations produce a blocked review without repeatedly billing a repair',async()=>{
  const f=await nativeJob({customConfig:true}),{result}=await finish(f);
  assert.equal(result.status,'completed');assert.equal(f.fixture.charges,1);
  const review=f.fixture.reviews.get(result.reviewId);assert.equal(review.exportable,false);assert.equal(review.patch,null);
  assert.match(review.testTransfer.blockers.join(' '),/dart_custom_test_or_build_configuration/);
});
test('cancellation between native attempts wins before a second provider submission',async()=>{
  const f=await nativeJob();let adjusting;
  for(let i=0;i<8;i++){adjusting=await f.service().status('alice',f.id);if(adjusting.stage==='adjusting_integration')break;}
  assert.equal(adjusting.stage,'adjusting_integration');
  const result=await f.service().cancel('alice',f.id);assert.equal(result.status,'cancelled');assert.equal(f.fixture.charges,1);assert.equal(f.fixture.reviews.size,0);
});
test('native scoped jobs retain duplicate-key and cross-owner protections',async()=>{
  const f=await nativeJob();assert.equal((await f.service().start('alice',f.args)).jobId,f.id);
  await assert.rejects(f.service().status('other-user',f.id),e=>e.code==='job_not_found');
  await assert.rejects(f.service().start('alice',{...f.args,sourcePaths:['lib/price.dart']}),e=>e.code==='request_key_conflict');
  assert.equal(f.fixture.requests.length,0);
});
