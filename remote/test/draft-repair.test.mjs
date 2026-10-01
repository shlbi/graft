/** @file Bounded recovery/race/approval tests. Real orchestration+structural validator; provider and durable I/O are doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftJobError } from '../draft-job-errors.mjs';
import { canRepair, repairFeedback, repairProgress } from '../draft-repair.mjs';
import { ProposalValidationError } from '../../web/lib/core-base.mjs';
import { repairFixture, validProposal, responseFor, begin, finish, request } from './repair-fixture.mjs';

/** Make a correctable proposal without modifying the feature itself. */
function badReason() { const p = validProposal(); p.changes[0].reason = 'x'.repeat(601); return p; }

test('one rejected proposal repairs inside the SAME job and preserves pinned input', async () => {
  const f = await repairFixture([responseFor(badReason()), responseFor(validProposal())]);
  const id = await begin(f), adjusting = await f.service().status('alice', id);
  assert.equal(adjusting.stage, 'adjusting_integration'); assert.equal(adjusting.error, undefined);
  assert.equal(adjusting.validation.code, 'proposal_reason'); assert.equal(adjusting.continueAutomatically, true);
  assert.equal(adjusting.nextTool, 'repot_draft_status'); assert.match(adjusting.notice, /no new user approval/);
  assert.equal(f.requests.length, 1); assert.equal(f.reviews.size, 0);
  const result = await finish(f, id);
  assert.equal(result.status, 'completed'); assert.equal(result.jobId, id); assert.equal(result.requestKey, request.requestKey);
  assert.equal(f.requests.length, 2); assert.equal(f.charges, 2); assert.equal(f.preparations, 1); assert.equal(f.reviews.size, 1);
  const [first, second] = f.requests.map(p => JSON.parse(p.input));
  assert.equal(first.feature, second.feature); assert.deepEqual(first.source, second.source); assert.deepEqual(first.destination, second.destination);
  assert.equal(second.repairFeedback.diagnostic.code, 'proposal_reason'); assert.equal(second.repairFeedback.previousProposal.changes[0].reason.length, 601);
  assert.equal(f.reviews.get(result.reviewId).generation.repairsUsed, 1);
  assert.equal(f.reviews.get(result.reviewId).verification.tests, 'not_run');
  assert.equal(f.jobs.get(id).payload, null); assert.equal(result.error, undefined);
});

test('initial plus two repairs is a HARD ceiling, not an endless loop', async () => {
  const f = await repairFixture([responseFor(badReason())]), id = await begin(f);
  const result = await finish(f, id);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'proposal_reason');
  assert.equal(f.requests.length, 3); assert.equal(f.charges, 3); assert.equal(f.reviews.size, 0);
  for (let i = 0; i < 5; i++) assert.equal((await f.service().status('alice', id)).error.code, 'proposal_reason');
  assert.equal(f.requests.length, 3); assert.equal(f.jobs.get(id).payload, null);
  assert.equal(f.jobs.get(id).error_code, 'proposal_reason'); assert.equal(f.jobs.get(id).response_id, null);
});

test('third attempt can complete after two different validation failures', async () => {
  const second = validProposal(); second.changes[0].sourcePaths = ['invented.js'];
  const f = await repairFixture([responseFor(badReason()), responseFor(second), responseFor(validProposal())]);
  const result = await finish(f, await begin(f));
  assert.equal(result.status, 'completed'); const generation = f.reviews.get(result.reviewId).generation;
  assert.equal(generation.attempts, 3); assert.equal(generation.maxAttempts, 3);
  assert.deepEqual(generation.validationHistory.map(d => d.code), ['proposal_reason','proposal_source_refs']);
});

for (const maxRepairAttempts of [0, 1]) test(`upfront budget ${maxRepairAttempts} is honored without increasing it`, async () => {
  const f = await repairFixture([responseFor(badReason())]), id = await begin(f, { maxRepairAttempts });
  assert.equal((await finish(f, id)).status, 'failed'); assert.equal(f.requests.length, maxRepairAttempts + 1);
  await assert.rejects(f.service().start('alice', { ...request, maxRepairAttempts: 2 }), e => e.code === 'request_key_conflict');
});

for (const maxRepairAttempts of [-1, 3, 1.5, '2', null]) test('invalid budget is not accepted: ' + JSON.stringify(maxRepairAttempts), async () => {
  const f = await repairFixture([]);
  await assert.rejects(f.service().start('alice', { ...request, maxRepairAttempts }), e => e.code === 'invalid_request');
  assert.equal(f.jobs.size, 0); assert.equal(f.requests.length, 0);
});

test('old jobs without repair consent retain a one-attempt budget', async () => {
  const f = await repairFixture([responseFor(badReason())]), { jobId } = await f.service().start('alice', request);
  const row = f.jobs.get(jobId), value = JSON.parse(row.payload); delete value.request.maxRepairAttempts; row.payload = JSON.stringify(value);
  await f.service().status('alice', jobId); await f.service().status('alice', jobId);
  assert.equal((await finish(f, jobId)).error.code, 'proposal_reason'); assert.equal(f.requests.length, 1);
});

test('already failed legacy jobs are never resurrected after deployment', async () => {
  const f = await repairFixture([]), { jobId } = await f.service().start('alice', request);
  Object.assign(f.jobs.get(jobId), { state: 'failed', payload: null, error_code: 'invalid_proposal' });
  assert.equal((await f.service().status('alice', jobId)).status, 'failed'); assert.equal(f.requests.length, 0);
});

test('daily quota also applies to repairs; no second POST when exhausted', async () => {
  const f = await repairFixture([responseFor(badReason())]); f.quota = 1;
  const result = await finish(f, await begin(f));
  assert.equal(result.error.code, 'draft_limit'); assert.equal(f.requests.length, 1); assert.equal(f.charges, 1);
});

test('simultaneous polls cannot schedule or submit duplicate repairs', async () => {
  const f = await repairFixture([responseFor(badReason()), responseFor(validProposal())]), id = await begin(f);
  await Promise.all([f.service().status('alice', id), f.service().status('alice', id)]);
  await Promise.all([f.service().status('alice', id), f.service().status('alice', id)]);
  await Promise.all([f.service().status('alice', id), f.service().status('alice', id)]);
  const result = await finish(f, id); assert.equal(result.status, 'completed'); assert.equal(f.requests.length, 2); assert.equal(f.charges, 2);
});

test('cancel a queued repair before cleanup/submission; no extra charge', async () => {
  const f = await repairFixture([responseFor(badReason())]), id = await begin(f);
  await f.service().status('alice', id); const result = await f.service().cancel('alice', id);
  assert.equal(result.status, 'cancelled'); assert.equal(f.requests.length, 1); assert.equal(f.reviews.size, 0);
});

test('cancel races repair scheduling and prevents a later submission', async () => {
  const f = await repairFixture([responseFor(badReason())]), id = await begin(f), old = f.store.queueRepair;
  f.store.queueRepair = async (...a) => { await f.store.requestCancel('alice', id); return old(...a); };
  await f.service().status('alice', id); assert.equal((await finish(f, id)).status, 'cancelled'); assert.equal(f.requests.length, 1);
});

test('old provider response is cleaned before a replacement can be submitted', async () => {
  const f = await repairFixture([responseFor(badReason()), responseFor(validProposal())]), id = await begin(f);
  await f.service().status('alice', id); f.cleanupError = new Error('SECRET_DELETE_ERROR');
  await assert.rejects(f.service().status('alice', id), e => e.code === 'service_unavailable'); assert.equal(f.requests.length, 1);
  assert.equal(f.jobs.get(id).response_id, 'resp_attempt_1'); assert.equal(f.jobs.get(id).cleanup_pending, true);
  f.cleanupError = null; assert.equal((await finish(f, id)).status, 'completed'); assert.equal(f.requests.length, 2);
});

test('ambiguous repair submission NEVER starts a fourth or duplicate provider request', async () => {
  const f = await repairFixture([responseFor(badReason())]), id = await begin(f);
  await f.service().status('alice', id); await f.service().status('alice', id);
  f.submitError = new DraftJobError('submission_unknown');
  const result = await finish(f, id); assert.equal(result.error.code, 'submission_unknown'); assert.equal(f.requests.length, 2);
  await f.service().status('alice', id); assert.equal(f.requests.length, 2);
});

test('a lost database acknowledgement of repair provider ID retries only the DB write', async () => {
  const f = await repairFixture([responseFor(badReason()), responseFor(validProposal())]), id = await begin(f), old = f.store.running;
  let count = 0; f.store.running = async (...a) => { const row = await old(...a); if (++count === 1) throw new Error('Lost ack'); return row; };
  assert.equal((await finish(f, id)).status, 'completed'); assert.equal(f.requests.length, 2); assert.equal(count, 2);
});

test('another user cannot repair, cancel or view job diagnostics', async () => {
  const f = await repairFixture([responseFor(badReason())]), id = await begin(f);
  for (const method of ['status','cancel']) await assert.rejects(f.service()[method]('bob', id), e => e.code === 'job_not_found');
  assert.equal(f.requests.length, 1);
});

for (const error of [new TypeError('SECRET_VALIDATOR_STACK'), null, { code: 'proposal_reason', message: 'SECRET_TOKEN' }]) test('unknown validator exception stops as validator_error: ' + typeof error, async () => {
  const f = await repairFixture([responseFor(validProposal())]), id = await begin(f); f.reviewOverride = () => { throw error; };
  const result = await finish(f, id); assert.equal(result.error.code, 'validator_error'); assert.equal(f.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
});

for (const kind of ['refusal','unsafe-path','sensitive','insufficient-context','uninspected-update']) test('nonrepairable failure stops without weakening validation: ' + kind, async () => {
  const p = validProposal(); let response;
  if (kind === 'unsafe-path') p.changes[0].path = '../escape.js';
  if (kind === 'sensitive') p.changes[0].content = 'const key = "sk-' + 'a'.repeat(30) + '";';
  if (kind === 'insufficient-context') p.changes = [];
  if (kind === 'uninspected-update') { p.changes[0].action = 'update'; p.changes[0].path = 'src/unseen.js'; }
  response = kind === 'refusal' ? { status:'completed', output:[{ content:[{ type:'refusal', refusal:'private reason' }] }] } : responseFor(p);
  const f = await repairFixture([response]), result = await finish(f, await begin(f));
  assert.equal(result.status, 'failed'); assert.equal(f.requests.length, 1); assert.equal(f.reviews.size, 0);
  assert.doesNotMatch(JSON.stringify(result), /sk-|private reason/);
});

test('test-transfer blockers still produce an unexportable review, not a weakened replacement', async () => {
  const f = await repairFixture([responseFor(validProposal())]), id = await begin(f);
  f.reviewOverride = () => ({ exportable:false, patch:null, changes:[], testTransfer:{status:'blocked'}, verification:{tests:'not_run'} });
  const result = await finish(f, id); assert.equal(f.reviews.get(result.reviewId).exportable, false); assert.equal(f.requests.length, 1);
});

test('no unsafe proposal is retained as repair feedback even if error fields are altered', () => {
  const error = new ProposalValidationError('proposal_reason'); error.proposal = { secret: 'sk-' + 'a'.repeat(30) };
  assert.equal(repairFeedback(error).previousProposal, null);
  assert.equal(canRepair({ request: { maxRepairAttempts: 2 }, generation: { attempts: 1 } }, Error('unknown')), false);
  assert.throws(() => repairProgress({ request:{maxRepairAttempts:2}, generation:{attempts:4} }));
});


test('legacy retry hash recovers the old job without silently enabling repairs', async () => {
  const f = await repairFixture([responseFor(validProposal())]);
  const {jobId} = await f.service().start('alice', request);
  const row = f.jobs.get(jobId), value = JSON.parse(row.payload);
  delete value.request.maxRepairAttempts;
  row.payload = JSON.stringify(value);
  row.request_hash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(value.request)).digest('hex');
  const recovered = await f.service().start('alice', request);
  assert.equal(recovered.jobId,jobId);assert.equal(recovered.generation.maxAttempts,1);
  assert.equal(f.jobs.size,1);assert.equal(f.requests.length,0);
});

test('a saved repair budget cannot be changed by retrying its requestKey', async () => {
  const f = await repairFixture([responseFor(validProposal())]);
  await f.service().start('alice',{...request,maxRepairAttempts:0});
  await assert.rejects(f.service().start('alice',{...request,maxRepairAttempts:2}), e => e.code==='request_key_conflict');
  assert.equal(f.requests.length,0);
});

test('exhaustion is explicit without retaining failed source context or losing the actual rule', async () => {
  const bad=validProposal();bad.changes[0].reason='x'.repeat(601);
  const f=await repairFixture([responseFor(bad)]),id=await begin(f);
  const result=await finish(f,id);
  assert.equal(result.repairBudgetExhausted,true);assert.equal(result.error.code,'proposal_reason');
  assert.equal(f.jobs.get(id).payload,null);assert.equal(f.requests.length,3);
});
