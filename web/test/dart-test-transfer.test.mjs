/** @file Real native discovery/relocation/structural validation using authored snapshots. Dart SDK execution is separate. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverDartTests,transplantDartTests,rewriteDartUris} from '../lib/dart-test-transfer.mjs';
import {reviewProposal,snapshot} from '../lib/core-base.mjs';
import {dartFixture} from './fixtures/dart-transfer-fixture.mjs';
import {dartDirectives} from '../lib/source-graph.mjs';

/** Run actual structural review followed by the native adapter; no provider/adapter mocks here. */
function run(f) {
  const plan=discoverDartTests(f.source,f.destination,f.roots,f.landing);
  const base=reviewProposal(f.proposal,f.source,f.destination,f.context);
  return {plan,...transplantDartTests(base.changes,f.source,f.destination,plan,f.context)};
}
/** Replace fixture content and recompute the actual immutable snapshot fingerprint. */
function edit(repo,p,content) {
  const files=repo.files.filter(f=>f.path!==p);if(content!==null)files.push({path:p,content});
  return snapshot({name:repo.name,revision:repo.revision,files});
}
/** Compare every non-URI byte, not merely assertion counts or substring presence. */
function mask(text) {
  let value=text;for(const r of dartDirectives({content:text}).directives.toReversed())value=value.slice(0,r.start)+'<URI>'+value.slice(r.end);return value;
}

for(const flutter of [true,false])test(`relocates ${flutter?'Flutter':'Dart'} transitive feature tests, helper and package URIs`,()=>{
  const f=dartFixture({flutter}),r=run(f);
  assert.equal(r.report.status,'included');assert.equal(r.report.discovered,2);assert.equal(r.changes.length,5);
  assert.deepEqual(r.plan.support,['test/support/cart_helper.dart']);
  assert.deepEqual(r.plan.featurePaths,['lib/cart.dart','lib/price.dart']);
  assert.ok(!r.changes.some(c=>c.path.includes('unrelated')));
  assert.match(r.changes.find(c=>c.path==='test/support/cart_helper.dart').content,/package:store\/features\/basket.dart/);
  assert.match(r.changes.find(c=>c.path==='test/price_test.dart').content,/\.\.\/lib\/features\/price.dart/);
  for(const place of r.report.placements){const before=f.source.files.find(x=>x.path===place.sourcePath).content,after=r.changes.find(x=>x.path===place.destinationPath).content;assert.equal(mask(before),mask(after));assert.match(place.preservedBodySha256,/^[a-f0-9]{64}$/);}
  assert.equal(r.report.verification.transferredTests,'not_run');
});
test('nested monorepo packages retain destination-root test layout and correct package names',()=>{
  const f=dartFixture({sourceRoot:'packages/donor',destinationRoot:'apps/phone'}),r=run(f);assert.equal(r.report.status,'included');
  assert.ok(r.report.placements.every(p=>p.destinationPath.startsWith('apps/phone/test/')));
  assert.match(r.changes.find(c=>c.path.endsWith('/support/cart_helper.dart')).content,/package:store\/features\/basket.dart/);
});
test('destination collisions choose a deterministic whole-bundle namespace without overwriting a test',()=>{
  const f=dartFixture({collision:true}),r=run(f),again=run(f);
  assert.equal(r.report.status,'included');assert.deepEqual(r,again);
  assert.ok(r.report.placements.every(p=>/^test\/repot_[a-f0-9]{12}\//.test(p.destinationPath)));
  assert.ok(!r.changes.some(c=>c.path==='test/cart_test.dart'));
  assert.match(r.changes.find(c=>c.path.endsWith('/price_test.dart')).content,/\.\.\/\.\.\/lib\/features\/price.dart/);
});
test('an unresolved generated import produces targeted repair metadata, not a publishable native review',()=>{
  const f=dartFixture();f.proposal.changes[0].content="import 'missing.dart';\nint cartTotal(int x)=>priceFor(x);\n";
  const r=run(f);assert.equal(r.report.status,'blocked');assert.equal(r.report.proposalRepairCode,'proposal_dart_import');assert.equal(r.changes.length,2);
});
test('missing implementation mapping is repairable without inventing a second source implementation',()=>{
  const f=dartFixture();f.proposal.changes.pop();const r=run(f);assert.equal(r.report.status,'blocked');assert.ok(r.report.blockers.some(b=>b.startsWith('dart_implementation_mapping_required')));assert.ok(r.report.proposalRepairCode);
});
test('production imports still referring to the donor package cannot pass review',()=>{
  const f=dartFixture();f.proposal.changes[0].content="import 'package:donor/price.dart';\nint cartTotal(int x)=>priceFor(x);\n";
  assert.equal(run(f).report.proposalRepairCode,'proposal_dart_import');
});
for(const config of ['dart_test.yaml','test/flutter_test_config.dart','pubspec_overrides.yaml','build.yaml'])test('custom configuration is visible and never overwritten: '+config,()=>{
  const f=dartFixture();f.source=edit(f.source,config,'# custom configuration\n');f.context.source=f.source.files;
  const r=run(f);assert.equal(r.report.status,'blocked');assert.ok(r.report.blockers.some(b=>b.includes(config)));assert.equal(r.report.proposalRepairCode,undefined);assert.equal(r.changes.length,2);
});
test('missing runner dependency stops relocation, even if production source compiled structurally',()=>{
  const f=dartFixture();f.destination=edit(f.destination,'pubspec.yaml','name: store\n');f.context.destination=f.destination.files;
  const r=run(f);assert.equal(r.report.status,'blocked');assert.ok(r.report.blockers.some(b=>b.startsWith('dart_dependency_not_declared')));
});
test('the generator cannot modify tests, helpers or pubspec to make a transfer pass',()=>{
  for(const p of ['test/new_test.dart','test/support/helper.dart','pubspec.yaml']){
    const f=dartFixture();f.proposal.changes.push({path:p,action:p==='pubspec.yaml'?'update':'add',content:'// do not accept\n',reason:'pretend to test',sourcePaths:['lib/cart.dart']});
    assert.ok(run(f).report.blockers.some(b=>b.startsWith('dart_model_must_not_modify_tests_or_runner')));
  }
});
test('a partial snapshot cannot claim every native test was inspected',()=>{
  const f=dartFixture();f.source={...f.source,inventory:[...f.source.inventory,'test/unread_test.dart']};
  const r=run(f);assert.equal(r.report.status,'blocked');assert.ok(r.report.blockers.some(b=>b.startsWith('dart_snapshot_incomplete')));
});
test('test source outside the selected model context remains a blocker',()=>{
  const f=dartFixture();f.context={...f.context,source:f.context.source.filter(x=>!x.path.startsWith('test/'))};
  assert.ok(run(f).report.blockers.some(b=>b.startsWith('dart_context_missing')));
});
for(const content of ["import '../lib/cart.dart';\npart 'generated.g.dart';\n", "import '../lib/cart.dart';\nvoid main(){matchesGoldenFile('golden.png');}\n", "import '../lib/cart.dart';\nvoid main(){File('fixture.json');}\n"])
  test('unsupported parts and runtime resources are not silently dropped: '+JSON.stringify(content),()=>{
    const f=dartFixture();f.source=edit(f.source,'test/cart_test.dart',content);f.context.source=f.source.files;
    const r=run(f);assert.equal(r.report.status,'blocked');assert.equal(r.report.proposalRepairCode,undefined);
  });
test('conditional imports require platform verification rather than choosing one branch',()=>{
  const f=dartFixture();f.source=edit(f.source,'lib/cart.dart',"import 'price.dart' if (dart.library.io) 'price_io.dart';\nint cartTotal(int x)=>priceFor(x);\n");f.source=edit(f.source,'lib/price_io.dart','int priceFor(int x)=>x*12;\n');f.context.source=f.source.files;
  assert.ok(run(f).report.blockers.some(b=>b.startsWith('dart_conditional_library')));
});
test('known integration_test sources require a device adapter; no passing device result is fabricated',()=>{
  const f=dartFixture();f.source=edit(f.source,'integration_test/cart_test.dart',"import 'package:donor/cart.dart';\nvoid main(){}\n");f.context.source=f.source.files;
  assert.ok(run(f).report.blockers.some(b=>b.startsWith('dart_device_test_adapter_required')));
});
test('unrelated nested packages cannot donate helper files or block the selected package',()=>{
  const f=dartFixture();f.source=edit(f.source,'other/pubspec.yaml','name: other\n');f.source=edit(f.source,'other/test/unknown_test.dart',"import 'missing.dart';");f.context.source=f.source.files;
  assert.equal(run(f).report.status,'included');
});
test('cross-language or ambiguous destination selection remains explicit',()=>{
  const f=dartFixture();f.destination=edit(f.destination,'Main.kt','class Main');f.landing=['Main.kt'];
  assert.ok(run(f).report.blockers.includes('dart_package_selection_required'));
  assert.equal(discoverDartTests(f.source,f.destination,['src/js.js'],['Main.kt']),null);
});
test('URI editing rejects overlapping ranges, changed preimages and interpolated output',()=>{
  const text="import 'a.dart';";
  for(const edits of [[{start:8,end:14,before:'wrong',value:'b.dart'}],[{start:8,end:14,before:'a.dart',value:'${bad}'}],[{start:8,end:14,before:'a.dart',value:'b.dart'},{start:8,end:14,before:'a.dart',value:'c.dart'}]])assert.throws(()=>rewriteDartUris(text,edits));
});
test('every diagnostic is structural and no SDK/test runtime is marked passed',()=>{
  const r=run(dartFixture());assert.ok(Object.values(r.report.verification).every(x=>x==='not_run'));assert.equal(r.report.framework.runtimeVerification,'not_run');
});

test('new conditional platform code is not mislabeled a supported ordinary library transfer',()=>{
  const f=dartFixture();f.proposal.changes[0].content="import 'price.dart' if (dart.library.io) 'price.dart';\nint cartTotal(int units)=>priceFor(units);\n";
  const r=run(f);assert.equal(r.report.status,'blocked');assert.match(r.report.blockers.join(' '),/dart_generated_conditional_platform_directive/);assert.equal(r.report.proposalRepairCode,undefined);
});
test('a new native channel cannot bypass the separate platform-setup gate',()=>{
  const f=dartFixture();f.proposal.changes[0].content="import 'price.dart';\nfinal channel=MethodChannel('cart');\nint cartTotal(int units)=>priceFor(units);\n";
  const r=run(f);assert.equal(r.report.status,'blocked');assert.match(r.report.blockers.join(' '),/dart_generated_resource_or_platform_setup_required/);assert.equal(r.report.proposalRepairCode,undefined);
});
test('test helper dependencies cannot pull scripts outside lib into an ordinary library transfer',()=>{
  const f=dartFixture();f.source=edit(f.source,'bin/script.dart','const scriptValue=3;\n');
  f.source=edit(f.source,'test/support/cart_helper.dart',"import 'package:donor/cart.dart' as cart;\nimport '../../bin/script.dart';\nint readCart(int units)=>cart.cartTotal(units);\n");
  f.context.source=f.source.files;
  const r=run(f);assert.equal(r.report.status,'blocked');assert.match(r.report.blockers.join(' '),/dart_source_must_be_library/);
});
