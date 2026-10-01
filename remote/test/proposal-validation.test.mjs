/**
 * @file Execute shared schema/structural-validation boundaries, not generated code.
 * Source/destination are synthetic pinned snapshots. Model, GitHub and test-runner
 * integration are not exercised. Every rejection is a real local validator result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewProposal, ProposalValidationError} from '../../web/lib/core-base.mjs';
import {PROPOSAL_LIMITS, proposalSchemaFor} from '../../web/lib/proposal-contract.mjs';
import {validationDiagnostic, repairFeedback, repairProgress} from '../draft-repair.mjs';
import {validProposal, source, destination, context, responseFor} from './repair-fixture.mjs';
import {loadTestAI} from './repair-load-ai.mjs';

/** Run the production structural validator with deterministic fixture inputs. */
const validate = p => reviewProposal(p, source, destination, context);
/** Match the exact typed rule without leaking generated content into diagnostics. */
const rule = code => e => e instanceof ProposalValidationError && e.code === code;

for(const [field,limit,code] of [['summary',1500,'proposal_summary'],['reason',600,'proposal_reason']]) {
  test(`${field} boundary agrees with the output schema and returns a specific diagnostic`,()=>{
    const p=validProposal(),target=field==='summary'?p:p.changes[0];target[field]='x'.repeat(limit);
    assert.equal(validate(p).verification.structure,'passed');target[field]+='x';
    assert.throws(()=>validate(p),rule(code));
    const schema=proposalSchemaFor(['src/json.js']);
    const pattern=field==='summary'?schema.properties.summary.pattern:schema.properties.changes.items.properties.reason.pattern;
    assert.ok(new RegExp(pattern).test('x'.repeat(limit)));assert.ok(!new RegExp(pattern).test('x'.repeat(limit+1)));
  });
}
for(const [field,code] of [['risks','proposal_risks'],['suggestedChecks','proposal_checks']]){
  test(`${field} enforces shared list and string bounds`,()=>{
    const p=validProposal();p[field]=Array(12).fill('x'.repeat(600));validate(p);
    p[field].push('x');assert.throws(()=>validate(p),rule(code));
    p[field]=[''];assert.throws(()=>validate(p),rule(code));
    p[field]=['x'.repeat(601)];assert.throws(()=>validate(p),rule(code));
    assert.equal(proposalSchemaFor().properties[field].maxItems,PROPOSAL_LIMITS.listItems);
  });
}

const invalid = [
  ['proposal_envelope',p=>({...p,untrusted:'EXTRA'})],
  ['proposal_change_count',p=>({...p,changes:Array(11).fill(p.changes[0])})],
  ['proposal_change_fields',p=>{p.changes[0].extra=true;return p;}],
  ['proposal_source_refs',p=>{p.changes[0].sourcePaths=['unread.js'];return p;}],
  ['proposal_duplicate_path',p=>{p.changes.push({...p.changes[0]});return p;}],
  ['proposal_add_collision',p=>{p.changes[0].path='src/app.js';return p;}],
  ['proposal_empty_file',p=>{p.changes[0].content='';return p;}],
  ['proposal_noop_update',p=>{Object.assign(p.changes[0],{path:'src/app.js',action:'update',content:destination.files[0].content});return p;}],
  ['proposal_path_collision',p=>{p.changes[0].path='src/app.js/child.js';return p;}],
  ['proposal_uninspected_update',p=>{p.changes[0].action='update';return p;}],
  ['proposal_content_type',p=>{p.changes[0].content=123;return p;}],
  ['proposal_unsafe_path',p=>{p.changes[0].path='../escape.js';return p;}],
  ['proposal_unsafe_content',p=>{p.changes[0].content='\0';return p;}]
];
for(const [code,mutate] of invalid) test('specific structural rejection: '+code,()=>{
  assert.throws(()=>validate(mutate(validProposal())),error=>{
    assert.ok(rule(code)(error));assert.equal(error.status,422);
    assert.ok(!JSON.stringify(validationDiagnostic(error)).includes('EXTRA'));
    return true;
  });
});

test('file and total limits measure UTF-8 bytes, not JavaScript string length',()=>{
  const p=validProposal();p.changes[0].content='漢'.repeat(20000);validate(p);
  p.changes[0].content+='x';assert.throws(()=>validate(p),rule('proposal_file_size'));
  p.changes[0].content='x'.repeat(60000);p.changes.push({...p.changes[0],path:'src/second.js'});validate(p);
  p.changes.push({...p.changes[0],path:'src/third.js',content:'x'});assert.throws(()=>validate(p),rule('proposal_patch_size'));
});

test('source citations are constrained to inspected paths before generation',async()=>{
  const api=await loadTestAI(),payload=api.buildProposalRequest({source,destination,context});
  const refs=payload.text.format.schema.properties.changes.items.properties.sourcePaths;
  assert.deepEqual(refs.items.enum,context.source.map(f=>f.path));assert.equal(refs.minItems,1);assert.equal(refs.maxItems,12);
  const input=JSON.parse(payload.input);assert.deepEqual(input.validationConstraints.editableDestinationPaths,context.destination.map(f=>f.path));
  assert.equal(payload.store,false);assert.equal(payload.tools,undefined);assert.equal(payload.max_output_tokens,12000);
});

test('a later sensitive file outranks an earlier repairable cosmetic error',async()=>{
  const api=await loadTestAI(),p=validProposal();p.changes[0].reason='x'.repeat(601);
  p.changes.push({...p.changes[0],path:'later.js',reason:'valid',content:'sk-'+'a'.repeat(30)});
  assert.throws(()=>api.reviewFromAIResponse(responseFor(p),{source,destination,context}),rule('proposal_unsafe_content'));
});

test('repair history is bounded and raw provider envelopes are never persisted',()=>{
  const e=new ProposalValidationError('proposal_reason',0);e.proposal={text:'x'.repeat(PROPOSAL_LIMITS.repairContextBytes+1)};
  assert.equal(repairFeedback(e).previousProposal,null);
  assert.equal(validationDiagnostic({code:'proposal_reason',message:'PRIVATE'}).code,'validator_error');
  for(const attempts of [-1,4,1.5,'1']) assert.throws(()=>repairProgress({request:{maxRepairAttempts:2},generation:{attempts}}));
});
