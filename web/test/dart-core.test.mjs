/**
 * @file Actual analysis, AI-envelope parsing, test relocation and Git patch acceptance for
 * authored fixtures. No SDK/provider/validator doubles here. Dart compilation is not run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {analyze,reviewProposal,snapshot,ProposalValidationError} from '../lib/core.mjs';
import {buildProposalRequest,reviewFromAIResponse} from '../lib/ai.mjs';
import {dartFixture} from './fixtures/dart-transfer-fixture.mjs';
import {dartDirectives} from '../lib/source-graph.mjs';

/** Stand in only for completed provider output; these proposal bytes are authored test input. */
const responseFor=proposal=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(proposal)}]}]});
/** Use the same selected entrypoints, model builder and validator as the hosted service. */
function draft(f) {
  const analysis=analyze(f.source,f.destination,'cart pricing',f.context.selection);
  const payload=buildProposalRequest({...f,context:analysis.context});
  const review=reviewFromAIResponse(responseFor(f.proposal),{...f,context:analysis.context});
  return {analysis,payload,review};
}
/** Replace a fixture file and recompute the immutable snapshot, keeping unknown inventory explicit. */
function edit(repo,p,content) {
  return snapshot({name:repo.name,revision:repo.revision,files:[...repo.files.filter(f=>f.path!==p),{path:p,content}]});
}
/** Compare exact bytes outside import URI ranges, including comments, literals and assertions. */
function mask(text) {
  let result=text;
  for(const r of dartDirectives({content:text}).directives.toReversed())result=result.slice(0,r.start)+'<URI>'+result.slice(r.end);
  return result;
}
/** A bounded local Git invocation on newly created synthetic fixture files only. No remote or hooks. */
function git(dir,args,input) {
  const result=spawnSync('git',args,{cwd:dir,encoding:'utf8',input,timeout:10000,
    env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return result.stdout;
}
for(const options of [{flutter:true},{flutter:false},{sourceRoot:'packages/donor',destinationRoot:'apps/mobile'},{collision:true}]) {
  test('actual production pipeline assembles a complete native review: '+JSON.stringify(options),()=>{
    const f=dartFixture(options),before=JSON.stringify([f.source,f.destination]),{analysis,payload,review}=draft(f);
    assert.equal(analysis.testPlan.adapter,'dart');assert.equal(analysis.integrationPlan.contextCoverage.complete,true);
    assert.equal(review.exportable,true);assert.equal(review.testTransfer.discovered,2);assert.equal(review.changes.length,5);
    assert.equal(payload.model,'gpt-6.1-sol');assert.equal(payload.reasoning.effort,'medium');
    assert.equal(JSON.parse(payload.input).testPlan.adapter,'dart');assert.match(payload.instructions,/Dart unit\/widget tests/);
    assert.equal(JSON.stringify([f.source,f.destination]),before);
    for(const placement of review.testTransfer.placements) {
      assert.equal(mask(f.source.files.find(x=>x.path===placement.sourcePath).content),mask(review.changes.find(x=>x.path===placement.destinationPath).content));
    }
    assert.deepEqual(review.verification,{structure:'passed',build:'not_run',tests:'not_run',integration:'not_run'});
  });
}
test('the final patch applies using real Git and preserves all existing destination files',async()=>{
  const f=dartFixture({collision:true}),{review}=draft(f),dir=await mkdtemp(path.join(os.tmpdir(),'repot-authored-dart-'));
  try {
    for(const file of f.destination.files) {const target=path.join(dir,file.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.content);}
    git(dir,['-c','init.defaultBranch=main','init','-q']);git(dir,['add','--all']);
    git(dir,['apply','--check','--index'],review.patch);git(dir,['apply','--index'],review.patch);
    for(const file of f.destination.files)assert.equal(await readFile(path.join(dir,file.path),'utf8'),file.content);
    for(const c of review.changes)assert.equal(await readFile(path.join(dir,c.path),'utf8'),c.content);
    assert.equal(git(dir,['diff','--cached','--name-only']).trim().split('\n').length,f.destination.files.length+review.changes.length);
  } finally {await rm(dir,{recursive:true,force:true});}
});
for(const failure of ['bad-import','missing-library']) {
  test('native implementation failures enter the existing typed repair loop: '+failure,()=>{
    const f=dartFixture();
    if(failure==='bad-import')f.proposal.changes[0].content="import 'absent.dart';\nint cartTotal(int units)=>priceFor(units);\n";
    else f.proposal.changes.pop();
    assert.throws(()=>draft(f),error=>{
      assert.ok(error instanceof ProposalValidationError);assert.equal(error.diagnostic.repairable,true);
      assert.equal(error.diagnostic.code,failure==='bad-import'?'proposal_dart_import':'proposal_dart_mapping');
      if(failure==='bad-import')assert.equal(error.diagnostic.changeIndex,0);
      assert.deepEqual(error.proposal,f.proposal);return true;
    });
  });
}
test('forged provider-side test plans cannot hide required source tests',()=>{
  const f=dartFixture(),a=analyze(f.source,f.destination,'cart pricing',f.context.selection);
  a.context.testPlan={adapter:'dart',tests:[],requiredSource:[],issues:[]};
  const r=reviewProposal(f.proposal,f.source,f.destination,a.context);
  assert.equal(r.testTransfer.discovered,2);assert.equal(r.changes.length,5);
});
test('custom runner configuration remains unexportable, not a reason to remove tests',()=>{
  const f=dartFixture();f.source=edit(f.source,'dart_test.yaml','concurrency: 1\n');
  const {review}=draft(f);assert.equal(review.exportable,false);assert.equal(review.patch,null);
  assert.match(review.testTransfer.blockers.join(' '),/dart_custom_test_or_build_configuration/);
});
test('model-authored tests cannot weaken or replace native assertions',()=>{
  const f=dartFixture();f.proposal.changes.push({path:'test/cart_test.dart',action:'add',content:'void main() {}\n',reason:'Fake test',sourcePaths:['lib/cart.dart']});
  const {review}=draft(f);assert.equal(review.exportable,false);assert.equal(review.patch,null);
  assert.match(review.testTransfer.blockers.join(' '),/dart_model_must_not_modify_tests_or_runner/);
});
test('sensitive generated content is still rejected before native repair feedback',()=>{
  const f=dartFixture();f.proposal.changes[0].content='// '+'ghp_'+'x'.repeat(30);
  assert.throws(()=>draft(f),e=>e instanceof ProposalValidationError&&e.diagnostic.code==='proposal_unsafe_content'&&e.diagnostic.repairable===false);
});
test('widget-test assertion text and aliases survive relocation without claiming a rendered widget',()=>{
  const f=dartFixture();
  f.source=edit(f.source,'lib/cart.dart',"import 'package:flutter/widgets.dart';\nWidget cartLabel()=>const Directionality(textDirection:TextDirection.ltr,child:Text('Cart'));\nint cartTotal(int units)=>units*12;\n");
  f.source=edit(f.source,'test/cart_test.dart',"import 'package:flutter_test/flutter_test.dart';\nimport 'package:donor/cart.dart';\nvoid main(){testWidgets('cart label',(tester) async {await tester.pumpWidget(cartLabel());expect(find.text('Cart'),findsOneWidget);});}\n");
  f.proposal.changes=[{path:'lib/features/basket.dart',action:'add',content:"import 'package:flutter/widgets.dart';\nWidget cartLabel()=>const Directionality(textDirection:TextDirection.ltr,child:Text('Cart'));\nint cartTotal(int units)=>units*12;\n",reason:'Preserve widget API',sourcePaths:['lib/cart.dart']}];
  const {review}=draft(f);assert.equal(review.exportable,true);assert.equal(review.testTransfer.discovered,1);
  assert.equal(mask(review.changes.find(c=>c.path==='test/cart_test.dart').content),mask(f.source.files.find(c=>c.path==='test/cart_test.dart').content));
  assert.equal(review.verification.integration,'not_run');
});
test('the unchanged JS adapter still relocates node:test imports with the real TypeScript parser',()=>{
  const s=snapshot({name:'sample/source',files:[
    {path:'src/sum.js',content:'export const sum = (a,b) => a+b;\n'},
    {path:'test/sum.test.js',content:"import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from '../src/sum.js';\ntest('sum',()=>assert.equal(sum(2,3),5));\n"}
  ]}),d=snapshot({name:'sample/dest',files:[
    {path:'src/app.js',content:'export const ready = true;\n'},
    {path:'test/smoke.test.js',content:"import test from 'node:test';\ntest('smoke',()=>{});\n"}
  ]});
  const a=analyze(s,d,'sum',{sourcePaths:['src/sum.js'],destinationPaths:['src/app.js']});
  const proposal={summary:'sum',changes:[{path:'lib/math.js',action:'add',content:'export const sum = (a,b) => a+b;\n',reason:'adapt sum',sourcePaths:['src/sum.js']}],risks:[],suggestedChecks:[]};
  const r=reviewProposal(proposal,s,d,a.context);
  assert.notEqual(a.testPlan.adapter,'dart');assert.equal(r.exportable,true,r.testTransfer.blockers.join(' '));
  assert.match(r.changes.find(c=>c.path==='test/sum.test.js').content,/\.\.\/lib\/math.js/);
});

test('fixture materialization never overwrites an existing directory or claims SDK execution',async()=>{
  const {materializeDartFixture}=await import('../../scripts/materialize-dart-fixture.mjs');
  const parent=await mkdtemp(path.join(os.tmpdir(),'repot-native-fixture-output-'));
  try {
    const dir=path.join(parent,'fixture'),result=await materializeDartFixture(dir);
    assert.equal(result.sdk,'not_run');assert.equal(result.changedFiles.length,5);
    assert.equal(await readFile(path.join(dir,'source/lib/price.dart'),'utf8'),'int priceFor(int units) => units * 12;\n');
    assert.equal(await readFile(path.join(dir,'destination-after/README.md'),'utf8'),'UNRELATED_DESTINATION_SENTINEL\n');
    await assert.rejects(materializeDartFixture(dir),error=>error.code==='EEXIST');
    const review=JSON.parse(await readFile(path.join(dir,'review.json'),'utf8'));
    assert.equal(review.verification.tests,'not_run');assert.equal(review.proposal,'synthetic; no AI request');
  } finally {await rm(parent,{recursive:true,force:true});}
});
