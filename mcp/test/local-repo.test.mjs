import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRoots, snapshotLocalRepository, applyReviewedChanges } from '../local-repo.mjs';
import { createHash } from 'node:crypto';

async function fixture(){
  const base=await mkdtemp(join(tmpdir(),'repot-mcp-')), source=join(base,'source'), destination=join(base,'destination');
  await mkdir(join(source,'src'),{recursive:true});await mkdir(join(source,'test'),{recursive:true});await mkdir(join(destination,'src'),{recursive:true});
  await writeFile(join(source,'src','csv.js'),'export const csv = rows => rows.join("\\n");\n');
  await writeFile(join(source,'test','csv.test.js'),'import { csv } from "../src/csv.js";\n');
  await writeFile(join(destination,'src','app.js'),'export const app = true;\n');
  return{base,source,destination};
}
test('local snapshot is bounded, complete and ignores symlinks/generated directories',async()=>{
  const f=await fixture();try{
    await mkdir(join(f.source,'node_modules'));await writeFile(join(f.source,'node_modules','bad.js'),'secret');
    await symlink(join(f.source,'src','csv.js'),join(f.source,'src','alias.js'));
    const roots=await normalizeRoots([f.base]), got=await snapshotLocalRepository(f.source,roots);
    assert.deepEqual(got.snapshot.inventory,['src/csv.js','test/csv.test.js']);
    assert.equal(got.snapshot.coverage.completeTextSnapshot,true);
  }finally{await rm(f.base,{recursive:true,force:true});}
});
test('repository outside allowed roots is rejected',async()=>{
  const f=await fixture(), other=await mkdtemp(join(tmpdir(),'repot-outside-'));try{
    const roots=await normalizeRoots([f.base]);
    await assert.rejects(snapshotLocalRepository(other,roots),/outside Repot MCP allowed roots/);
  }finally{await rm(f.base,{recursive:true,force:true});await rm(other,{recursive:true,force:true});}
});
test('apply writes exact reviewed add/update files and refuses stale destination',async()=>{
  const f=await fixture();try{
    const roots=await normalizeRoots([f.base]), before=await snapshotLocalRepository(f.destination,roots);
    const old=await readFile(join(f.destination,'src','app.js'),'utf8');
    const review={exportable:true,changes:[
      {path:'src/app.js',action:'update',content:'export const app = false;\n',baseHash:createHash('sha256').update(old).digest('hex')},
      {path:'src/csv.js',action:'add',content:'export const csv = true;\n',baseHash:null}
    ]};
    const files=await applyReviewedChanges({destinationRoot:f.destination,review,expectedFingerprint:before.snapshot.fingerprint,roots});
    assert.deepEqual(files,['src/app.js','src/csv.js']);
    assert.equal(await readFile(join(f.destination,'src/csv.js'),'utf8'),'export const csv = true;\n');
    await assert.rejects(applyReviewedChanges({destinationRoot:f.destination,review,expectedFingerprint:before.snapshot.fingerprint,roots}),/Destination changed/);
  }finally{await rm(f.base,{recursive:true,force:true});}
});
test('sensitive-looking files fail closed rather than being silently sent to AI',async()=>{
  const f=await fixture();try{
    await writeFile(join(f.source,'src','secret.js'),'const api_key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";\n');
    const roots=await normalizeRoots([f.base]);
    await assert.rejects(snapshotLocalRepository(f.source,roots),/Sensitive-looking content/);
  }finally{await rm(f.base,{recursive:true,force:true});}
});
test('apply refuses a symlinked parent directory',async()=>{
  const f=await fixture(), outside=await mkdtemp(join(tmpdir(),'repot-symlink-out-'));try{
    const roots=await normalizeRoots([f.base]), before=await snapshotLocalRepository(f.destination,roots);
    await symlink(outside,join(f.destination,'linked'),'dir');
    const review={exportable:true,changes:[{path:'linked/escape.js',action:'add',content:'export const nope = true;\n',baseHash:null}]};
    await assert.rejects(applyReviewedChanges({destinationRoot:f.destination,review,expectedFingerprint:before.snapshot.fingerprint,roots}),/symlinked directory/);
  }finally{await rm(f.base,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
