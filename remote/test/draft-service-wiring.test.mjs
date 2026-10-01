/** @file Test production repair-feedback wiring with closed dependency doubles; no services or credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

test('production service forwards saved feedback and original snapshots to the shared builder',async()=>{
  let built,checked;
  const deps={
    './db.mjs':{db:()=>({})},'./crypto.mjs':{seal:()=>{},open:()=>{}},
    './env.mjs':{env:()=> 'TEST_ONLY_KEY',intEnv:(_name,defaultValue)=>defaultValue},
    './github.mjs':{githubTokenForUser:()=>{throw Error('Unexpected network');},snapshotRepository:()=>{}},
    '../web/lib/core.mjs':{analyze:()=>{}},'../web/lib/core-base.mjs':{featureText:v=>v},
    '../web/lib/ai.mjs':{buildProposalRequest:args=>{built=args;return args;},reviewFromAIResponse:(_response,args)=>{checked=args;return args;}},
    './draft-job-store.mjs':{createDraftJobStore:()=>({})},'./background-ai.mjs':{createBackgroundAI:()=>({})},
    './draft-jobs.mjs':{createDraftJobs:options=>options}
  };
  const context=vm.createContext({}),mod=new vm.SourceTextModule(await readFile(new URL('../draft-service.mjs',import.meta.url),'utf8'),{context});
  await mod.link(spec=>{assert.ok(Object.hasOwn(deps,spec));const values=deps[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});});
  await mod.evaluate();const service=mod.namespace.draftService();
  const value={source:{snapshot:{revision:'source-pinned'}},destination:{snapshot:{revision:'dest-pinned'}},context:{feature:'original'},repair:{diagnostic:{code:'proposal_reason'},previousProposal:{summary:'previous'}}};
  service.buildRequest(value);service.reviewResponse({},value);
  assert.equal(built.repair,value.repair);assert.equal(built.source,value.source.snapshot);assert.equal(built.context,value.context);
  assert.equal(checked.destination,value.destination.snapshot);assert.equal(checked.context,value.context);
});
