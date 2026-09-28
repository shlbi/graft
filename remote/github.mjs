import {Readable,Transform} from 'node:stream';
import {createGunzip} from 'node:zlib';
import tar from 'tar-stream';
import {getAuth} from './auth.mjs';
import {db} from './db.mjs';
import {snapshot,Fault,requireThat} from '../web/lib/core-base.mjs';
import {eligiblePath,LIMITS,looksSensitive} from '../web/lib/policy.mjs';

const API='https://api.github.com';
const headers=token=>({accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'user-agent':'repot-mcp','x-github-api-version':'2026-03-10'});
function repoName(value){if(typeof value!=='string'||!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value))throw new Fault('Use a GitHub repository as owner/repo.');return value;}
async function gh(token,path,{method='GET',body,raw=false}={}){
  const response=await fetch(API+path,{method,headers:{...headers(token),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:raw?'follow':'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok){const text=await response.text().catch(()=> '');throw new Fault(`GitHub returned ${response.status}${text?' for this operation':''}.`,response.status===404?404:502);}
  if(raw)return response;
  if(response.status===204)return null;
  return response.json();
}
export async function githubTokenForUser(userId){
  const {rows}=await db().query('SELECT id FROM account WHERE "userId"=$1 AND "providerId"=$2 ORDER BY "updatedAt" DESC LIMIT 1',[userId,'github']);
  if(!rows[0])throw new Fault('Your Repot account is not linked to GitHub.',403);
  const token=await getAuth().api.getAccessToken({body:{accountId:rows[0].id,userId}});
  if(!token?.accessToken)throw new Fault('Repot could not obtain a current GitHub user token. Reconnect GitHub.',403);
  return token.accessToken;
}
export async function listRepositories(token){
  const installs=await gh(token,'/user/installations?per_page=100');
  const repos=[];
  for(const installation of installs.installations??[]){
    const page=await gh(token,`/user/installations/${installation.id}/repositories?per_page=100`);
    for(const r of page.repositories??[])repos.push({name:r.full_name,private:r.private,defaultBranch:r.default_branch,permissions:r.permissions??{},installationId:installation.id});
  }
  const unique=new Map(repos.map(r=>[r.name.toLowerCase(),r]));
  return [...unique.values()].sort((a,b)=>a.name.localeCompare(b.name)).slice(0,500);
}
export async function snapshotRepository(token,input){
  const name=repoName(input),meta=await gh(token,`/repos/${name}`);
  requireThat(typeof meta.default_branch==='string'&&meta.default_branch,'Repository has no default branch.',422);
  const commit=await gh(token,`/repos/${name}/commits/${encodeURIComponent(meta.default_branch)}`);
  requireThat(/^[a-f0-9]{40}$/.test(commit.sha),'GitHub returned an invalid revision.',502);
  const response=await gh(token,`/repos/${name}/tarball/${commit.sha}`,{raw:true});
  const length=Number(response.headers.get('content-length')||0);if(length>20_000_000)throw new Fault('Repository archive exceeds the 20 MB intake limit. Use a smaller repository.',413);
  const extract=tar.extract(),files=[],inventory=[];let total=0,compressed=0,failure;
  const limiter=new Transform({transform(chunk,_enc,cb){compressed+=chunk.length;if(compressed>20_000_000)return cb(new Fault('Repository archive exceeded the 20 MB intake limit.',413));cb(null,chunk);}});
  const done=new Promise((resolve,reject)=>{
    extract.on('entry',(header,stream,next)=>{
      const parts=header.name.split('/');parts.shift();const path=parts.join('/');
      if(header.type!=='file'||!path||!eligiblePath(path)){stream.resume();stream.on('end',next);return;}
      inventory.push(path);
      if(inventory.length>LIMITS.files){failure=new Fault(`Repository has more than ${LIMITS.files} eligible files. Repot currently requires a smaller repository.`,413);stream.resume();stream.on('end',next);return;}
      const chunks=[];let size=0;
      stream.on('data',chunk=>{size+=chunk.length;if(size<=LIMITS.fileBytes)chunks.push(chunk);});
      stream.on('end',()=>{if(failure)return next();if(size>LIMITS.fileBytes){failure=new Fault(`Eligible file exceeds ${LIMITS.fileBytes} bytes: ${path}`,413);return next();}const bytes=Buffer.concat(chunks);let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{failure=new Fault(`Eligible file is not UTF-8 text: ${path}`,422);return next();}if(looksSensitive(content)){failure=new Fault(`Sensitive-looking content detected in ${path}; narrow or clean the repository before using Repot.`,422);return next();}total+=bytes.length;if(total>LIMITS.snapshotBytes){failure=new Fault(`Repository exceeds Repot's ${LIMITS.snapshotBytes}-byte eligible-text limit.`,413);return next();}files.push({path,content});next();});
      stream.on('error',reject);
    });
    extract.on('finish',resolve);extract.on('error',reject);
  });
  Readable.fromWeb(response.body).pipe(limiter).pipe(createGunzip()).pipe(extract);
  await done;if(failure)throw failure;
  return{meta:{name,defaultBranch:meta.default_branch,private:meta.private,permissions:meta.permissions??{}},snapshot:snapshot({name,revision:commit.sha,files,inventory})};
}
export async function publishDraft(token,{reviewId,destinationRepo,destinationRevision,review}){
  const name=repoName(destinationRepo),meta=await gh(token,`/repos/${name}`);
  const baseBranch=meta.default_branch,base=await gh(token,`/repos/${name}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  if(base.object?.sha!==destinationRevision)throw new Fault('Destination default branch changed since this review. Draft again before publishing.',409);
  const baseCommit=await gh(token,`/repos/${name}/git/commits/${destinationRevision}`);
  const elements=[];
  for(const change of review.changes){
    const blob=await gh(token,`/repos/${name}/git/blobs`,{method:'POST',body:{content:change.content,encoding:'utf-8'}});
    elements.push({path:change.path,mode:'100644',type:'blob',sha:blob.sha});
  }
  const tree=await gh(token,`/repos/${name}/git/trees`,{method:'POST',body:{base_tree:baseCommit.tree.sha,tree:elements}});
  const commit=await gh(token,`/repos/${name}/git/commits`,{method:'POST',body:{message:`Repot: ${review.summary.slice(0,120)}`,tree:tree.sha,parents:[destinationRevision]}});
  const slug=reviewId.slice(0,10).toLowerCase(),branch=`repot/transfer-${slug}`;
  await gh(token,`/repos/${name}/git/refs`,{method:'POST',body:{ref:`refs/heads/${branch}`,sha:commit.sha}});
  try{
    const pr=await gh(token,`/repos/${name}/pulls`,{method:'POST',body:{title:`Repot: ${review.summary.slice(0,100)}`,head:branch,base:baseBranch,draft:true,body:`## Repot transfer\n\n${review.summary}\n\n### Verification\n- Structure: ${review.verification?.structure??'unknown'}\n- Build: not run\n- Tests: not run\n- Integration: not run\n\nReview this draft and run project checks before merging.\n`}});
    return{url:pr.html_url,branch,number:pr.number};
  }catch(error){
    await fetch(`${API}/repos/${name}/git/refs/heads/${encodeURIComponent(branch)}`,{method:'DELETE',headers:headers(token),signal:AbortSignal.timeout(15000)}).catch(()=>{});
    throw error;
  }
}
