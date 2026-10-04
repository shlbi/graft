/** @file Executes the real core/structural validator with only the legacy test adapter substituted. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as base from '../lib/core-base.mjs';
import * as projects from '../lib/project-profile.mjs';
/** Load authored core code; the legacy JS test adapter remains a synthetic boundary in this focused suite. */
async function core() {
  const context=vm.createContext({Buffer});
  const testAdapter={discoverTests:()=>({tests:[],requiredSource:[],requiredDestination:[]}),references:()=>[],isTestPath:()=>false,isTestSupport:()=>false,isTestConfig:()=>false,
    transplantTests:changes=>({changes,report:{status:'none_found',blockers:[]}})};
  const deps={'./core-base.mjs':base,'./project-profile.mjs':projects,'./test-transfer.mjs':testAdapter};
  const code=new vm.SourceTextModule(await readFile(new URL('../lib/core.mjs',import.meta.url),'utf8'),{context});
  await code.link(name=>new vm.SyntheticModule(Object.keys(deps[name]),function(){for(const[k,v]of Object.entries(deps[name]))this.setExport(k,v);},{context}));
  await code.evaluate();return code.namespace;
}
/** Create bounded synthetic snapshots accepted by the real structural validator. */
function snapshots(language='dart',withTests=true) {
  const files=[{path:'lib/cart.'+language,content:'// cart total\n'}];
  if(withTests)files.push({path:'test/cart_test.'+language,content:'// cart assertions\n'});
  files.push({path:'pubspec.yaml',content:'name: source_app\ndependencies:\n  flutter:\n    sdk: flutter\n'});
  return [base.snapshot({name:'source',files}),base.snapshot({name:'destination',files:[{path:'lib/main.'+language,content:'// entry\n'}]})];
}
test('actual analyze response includes manifest-backed profiles and Dart feature context',async()=>{const c=await core(),[s,d]=snapshots();const a=c.analyze(s,d,'cart total');assert.equal(a.projects.source.components[0].kind,'flutter');assert.ok(a.context.source.some(f=>f.path==='lib/cart.dart'));});
test('undiscovered native tests block publication instead of claiming no tests',async()=>{const c=await core(),[s,d]=snapshots();const a=c.analyze(s,d,'cart');const r=c.reviewProposal({summary:'cart',changes:[{path:'lib/cart.dart',action:'add',content:'// adapted cart\n',reason:'transfer',sourcePaths:['lib/cart.dart']}],risks:[],suggestedChecks:[]},s,d,a.context);assert.equal(r.exportable,false);assert.equal(r.patch,null);assert.match(r.testTransfer.blockers.join(' '),/No tests were silently dropped/);});
test('ordinary JS proposals retain existing structural success and not_run evidence',async()=>{const c=await core(),[s,d]=snapshots('js',false);const a=c.analyze(s,d,'cart');const r=c.reviewProposal({summary:'cart',changes:[{path:'lib/cart.js',action:'add',content:'export const cart=1;\n',reason:'transfer',sourcePaths:['lib/cart.js']}],risks:[],suggestedChecks:[]},s,d,a.context);assert.equal(r.exportable,true);assert.equal(r.verification.tests,'not_run');});
