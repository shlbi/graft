/**
 * @file Local stdio Repot MCP development module (local-repo.mjs). The hosted remote MCP is the production product; this code remains a reference and local fallback.
 *
 * Safety note: local repository access must remain confined to explicit roots, and writes stay opt-in.
 */
import { lstat, readdir, readFile, realpath, writeFile, mkdir, unlink } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { eligiblePath, LIMITS, looksSensitive } from '../web/lib/policy.mjs';
import { snapshot, Fault } from '../web/lib/core-base.mjs';
const SKIP_DIR = /^(?:\.git|\.github|node_modules|vendor|dist|build|target|coverage|\.next|\.venv|venv|__pycache__)$/i;
/**
 * @function within
 * Implements within for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
const within = (root, target) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * @function assertNoSymlinkParents
 * Implements assert no symlink parents for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
async function assertNoSymlinkParents(root, target) {
  const rel=relative(root,target);
  let cursor=root;
  for(const part of rel.split(sep).slice(0,-1)){
    cursor=resolve(cursor,part);
    const st=await lstat(cursor).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if(st?.isSymbolicLink()) throw new Fault(`Refusing to write through symlinked directory: ${relative(root,cursor).split(sep).join('/')}`);
    if(st&&!st.isDirectory()) throw new Fault(`Write parent is not a directory: ${relative(root,cursor).split(sep).join('/')}`);
  }
}

/**
 * @function normalizeRoots
 * Implements normalize roots for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
export async function normalizeRoots(values) {
  if (!Array.isArray(values) || !values.length) throw new Fault('Repot MCP needs at least one --allow-root directory.');
  const roots=[];
  for(const value of values){
    const p=await realpath(resolve(value)), st=await lstat(p);
    if(!st.isDirectory()) throw new Fault(`Allowed root is not a directory: ${value}`);
    roots.push(p);
  }
  return [...new Set(roots)];
}
/**
 * @function resolveAllowedRepository
 * Implements resolve allowed repository for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
export async function resolveAllowedRepository(input, roots) {
  if(typeof input!=='string'||!input.trim()||input.length>1000) throw new Fault('Repository path is required.');
  const repo=await realpath(resolve(input)), st=await lstat(repo);
  if(!st.isDirectory()) throw new Fault('Repository path must be a directory.');
  if(!roots.some(root=>within(root,repo))) throw new Fault('Repository is outside Repot MCP allowed roots.',403);
  return repo;
}
/**
 * @function snapshotLocalRepository
 * Implements snapshot local repository for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
export async function snapshotLocalRepository(input, roots) {
  const repo=await resolveAllowedRepository(input,roots), inventory=[], files=[]; let total=0;
  /**
   * @function walk
   * Implements walk for the local MCP workflow.
   * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
   */
  async function walk(dir){
    const entries=await readdir(dir,{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isSymbolicLink()) continue;
      if(entry.isDirectory()&&SKIP_DIR.test(entry.name)) continue;
      const abs=resolve(dir,entry.name), rel=relative(repo,abs).split(sep).join('/');
      if(entry.isDirectory()){await walk(abs);continue;}
      if(!entry.isFile()||!eligiblePath(rel)) continue;
      inventory.push(rel);
      if(inventory.length>LIMITS.files) throw new Fault(`Repository has more than ${LIMITS.files} eligible files. Point Repot at a feature-focused directory.`);
      const st=await lstat(abs);
      if(st.size>LIMITS.fileBytes) throw new Fault(`Eligible file exceeds ${LIMITS.fileBytes} bytes: ${rel}`);
      const bytes=await readFile(abs); let content;
      try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Fault(`Eligible file is not UTF-8 text: ${rel}`);}
      if(looksSensitive(content)) throw new Fault(`Sensitive-looking content detected in ${rel}; remove it from the selected scope.`);
      total+=bytes.length;
      if(total>LIMITS.snapshotBytes) throw new Fault(`Repository exceeds the ${LIMITS.snapshotBytes}-byte MCP snapshot limit. Point Repot at a feature-focused directory.`);
      files.push({path:rel,content});
    }
  }
  await walk(repo);
  return {root:repo,snapshot:snapshot({name:basename(repo),files,inventory})};
}
/**
 * @function applyReviewedChanges
 * Implements apply reviewed changes for the local MCP workflow.
 * Safety: preserve allowed-root confinement, stale-review checks, and the default read-only posture.
 */
export async function applyReviewedChanges({destinationRoot, review, expectedFingerprint, roots}) {
  const current=await snapshotLocalRepository(destinationRoot,roots);
  if(current.snapshot.fingerprint!==expectedFingerprint) throw new Fault('Destination changed since this review was created. Draft again before applying.',409);
  if(!review?.exportable||!Array.isArray(review.changes)||!review.changes.length) throw new Fault('Review is not exportable.',409);
  const staged=[];
  for(const change of review.changes){
    if(!eligiblePath(change.path)||!['add','update'].includes(change.action)) throw new Fault(`Unsafe reviewed change: ${change.path}`);
    const target=resolve(current.root,...change.path.split('/'));
    if(!within(current.root,target)) throw new Fault(`Change escapes destination: ${change.path}`);
    await assertNoSymlinkParents(current.root,target);
    const existing=await lstat(target).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if(existing?.isSymbolicLink()) throw new Fault(`Refusing to write through symlink: ${change.path}`);
    if(change.action==='add'&&existing) throw new Fault(`Add target now exists: ${change.path}`,409);
    if(change.action==='update'){
      if(!existing?.isFile()) throw new Fault(`Update target is missing: ${change.path}`,409);
      const before=await readFile(target,'utf8');
      const actual=createHash('sha256').update(before).digest('hex');
      if(actual!==change.baseHash) throw new Fault(`Update target changed since review: ${change.path}`,409);
    }
    staged.push({target,content:change.content,path:change.path});
  }
  const applied=[];
  try{
    for(const item of staged){
      const existing=await lstat(item.target).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
      const before=existing?await readFile(item.target,'utf8'):null;
      await mkdir(dirname(item.target),{recursive:true});
      await writeFile(item.target,item.content,{encoding:'utf8',flag:existing?'w':'wx'});
      applied.push({...item,before});
    }
  }catch(error){
    for(const item of applied.reverse()){
      if(item.before===null) await unlink(item.target).catch(()=>{});
      else await writeFile(item.target,item.before,{encoding:'utf8',flag:'w'}).catch(()=>{});
    }
    throw new Fault('Repot could not apply the complete review; written files were rolled back.',500);
  }
  return staged.map(x=>x.path);
}
