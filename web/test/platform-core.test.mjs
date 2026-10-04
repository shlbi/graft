/** @file Actual project/core/structural/test-adapter regressions; no injected parser or validation doubles. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze,reviewProposal,snapshot} from '../lib/core.mjs';

/** Create bounded synthetic snapshots accepted by the real structural validator. */
function snapshots(language='dart',withTests=true) {
  const files=[{path:'lib/cart.'+language,content:'// cart total\n'}];
  if(withTests)files.push({path:'test/cart_test.'+language,content:'// cart assertions\n'});
  files.push({path:'pubspec.yaml',content:'name: source_app\ndependencies:\n  flutter:\n    sdk: flutter\n'});
  return [snapshot({name:'source',files}),snapshot({name:'destination',files:[{path:'lib/main.'+language,content:'// entry\n'}]})];
}
test('actual analyze response includes manifest-backed profiles and Dart feature context',()=>{
  const [s,d]=snapshots(),a=analyze(s,d,'cart total');
  assert.equal(a.projects.source.components[0].kind,'flutter');assert.ok(a.context.source.some(f=>f.path==='lib/cart.dart'));
});
test('native tests without a known destination Dart package cannot be silently exported',()=>{
  const [s,d]=snapshots(),a=analyze(s,d,'cart');
  const r=reviewProposal({summary:'cart',changes:[{path:'lib/cart.dart',action:'add',content:'// adapted cart\n',reason:'transfer',sourcePaths:['lib/cart.dart']}],risks:[],suggestedChecks:[]},s,d,a.context);
  assert.equal(r.exportable,false);assert.equal(r.patch,null);assert.match(r.testTransfer.blockers.join(' '),/dart_package_selection_required/);
});
test('ordinary JS proposals retain existing structural success and not_run evidence',()=>{
  const [s,d]=snapshots('js',false),a=analyze(s,d,'cart');
  const r=reviewProposal({summary:'cart',changes:[{path:'lib/cart.js',action:'add',content:'export const cart=1;\n',reason:'transfer',sourcePaths:['lib/cart.js']}],risks:[],suggestedChecks:[]},s,d,a.context);
  assert.equal(r.exportable,true);assert.equal(r.verification.tests,'not_run');
});
