// Actual frontend code + explicit DOM/HTTP doubles. Not live GitHub or AI execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.attributes = {}; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ''; this.dataset = {}; }
  append(...n) { this.children.push(...n); } replaceChildren(...n) { this.children = n; }
  get firstChild() { return this.children[0]; }
  addEventListener(type, cb) { (this.events[type] ||= []).push(cb); }
  dispatchEvent(e) { for (const cb of this.events[e.type] || []) cb(e); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  setAttribute(k,v) { this.attributes[k] = String(v); } getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; if (k === 'href') delete this.href; }
  focus() {} remove() {} scrollIntoView() {}
  set innerHTML(_) { throw new Error('Never render untrusted repository text as HTML'); }
}
async function settle(fn) { for (let n=0;n<200;n++) { if(fn())return; await new Promise(r=>setImmediate(r)); } assert.fail('Controller did not settle'); }
async function harness({signedIn=true,writes=true,ai=true,offline=false,htmlFallback=false,malformed=false}={}) {
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8'),code=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
  const ids=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
  const tabs=['implementation','tests','support'].map(x=>{const e=new Element('button');e.dataset.layer=x;return e;});
  const calls=[],downloads=[],created=[];let expiry=false,block=false;
  const job={id:'a'.repeat(43),state:'review_ready',feature:'CSV <script>evil</script>',digest:'abc',message:'Draft ready',
    review:{exportable:true,patch:'authored patch\n',changes:[{action:'add',path:'src/csv.js',content:'<img src=x onerror=evil()>',reason:'Test fixture',before:null}],testTransfer:{placements:[{sourcePath:'test/csv.js',destinationPath:'tests/csv.js'}],blockers:[]},risks:[]}};
  class ObjectURL extends URL {static createObjectURL(b){downloads.push(b);return 'blob:test';}static revokeObjectURL(){}}
  const api = async(path,opts)=>{calls.push({path,opts});if(offline)throw new Error('Network unavailable');let data,status=200;
    if(expiry){status=401;data={error:'Expired',code:'session'};}
    else if(path==='/api/session'){status=signedIn?200:401;data=malformed?{}:signedIn?{user:{id:1,login:'alice'},csrf:'test-csrf',writesEnabled:writes,aiConfigured:ai,userDailyDraftLimit:3}:{error:'Sign in',code:'session'};}
    else if(path==='/api/repos')data={repositories:[{id:10,name:'demo/source',writable:false},{id:20,name:'demo/destination',writable:true,private:true}]};
    else if(path==='/api/jobs'&&opts.method==='GET')data={jobs:[job]};
    else if(path==='/api/jobs'){if(block){status=429;data={error:'Allowance reached'};}else data=job;}
    else if(path.endsWith('/publish')){job.delivery={url:'https://github.com/demo/destination/pull/1'};job.state='delivered';data=job.delivery;}
    else if(path.endsWith('/cancel')){job.state='cancelled';data=job;}
    else if(path.startsWith('/api/jobs/'))data=job;
    else data={signedOut:true,note:'GitHub data stays.'};
    return {ok:status<400,status,json:async()=>{if(htmlFallback)throw new SyntaxError('HTML returned');return structuredClone(data);}};
  };
  vm.runInNewContext(code,{document:{getElementById:x=>ids[x],querySelectorAll:()=>tabs,createElement:tag=>{const n=new Element(tag);created.push(n);return n;},body:new Element('body')},URL:ObjectURL,Blob,clearTimeout(){},setTimeout(){return 1;},confirm:()=>true,fetch:api});
  await settle(()=>offline||htmlFallback||malformed||!signedIn?ids.account.children.length:ids.jobs.children.length);
  return {ids,calls,job,created,downloads,tabs,expire(){expiry=true;},blockDraft(){block=true;}};
}
async function review(h){h.ids.jobs.children[0].click();await settle(()=>h.ids['review-title'].textContent===h.job.feature);}
function fill(h){h.ids.source.value='10';h.ids.destination.value='20';h.ids.feature.value='Move the CSV export';h.ids.consent.checked=true;h.ids.feature.dispatchEvent({type:'input'});}
function submit(h){h.ids['transfer-form'].dispatchEvent({type:'submit',preventDefault(){}});}
test('unauthenticated bootstrap keeps a read-only workspace and offers real sign-in',async()=>{const h=await harness({signedIn:false});assert.equal(h.ids.composer.disabled,true);assert.equal(h.ids.workspace.hidden,false);assert.equal(h.ids.welcome.hidden,false);assert.equal(h.calls.length,1);assert.equal(h.ids.connect.href,'/auth/github');});
test('read-only destination and unconfigured drafting remain disabled',async()=>{const h=await harness({ai:false});assert.equal(h.ids.destination.children[0].disabled,true);assert.equal(h.ids.destination.children[1].disabled,false);fill(h);assert.equal(h.ids['create-draft'].disabled,true);});
test('both publication acknowledgements are required; exact CSRF/digest is sent',async()=>{const h=await harness();await review(h);assert.equal(h.ids.publish.disabled,true);h.ids.acknowledge.checked=true;h.ids.acknowledge.dispatchEvent({type:'change'});assert.equal(h.ids.publish.disabled,true);h.ids.workflows.checked=true;h.ids.workflows.dispatchEvent({type:'change'});assert.equal(h.ids.publish.disabled,false);h.ids.publish.click();await settle(()=>h.calls.some(c=>c.path.endsWith('/publish')));const p=h.calls.find(c=>c.path.endsWith('/publish'));assert.equal(p.opts.headers['x-csrf-token'],'test-csrf');assert.deepEqual(JSON.parse(p.opts.body),{digest:'abc',acknowledgeUnverified:true,acknowledgeWorkflows:true});});
test('code remains text and patch download retains exact bytes under the new name',async()=>{const h=await harness();await review(h);assert.ok(h.created.some(n=>n.tagName==='pre'&&n.textContent==='<img src=x onerror=evil()>'));assert.ok(!h.created.some(n=>n.tagName==='script'||n.tagName==='img'));h.ids.download.click();assert.equal(await h.downloads[0].text(),'authored patch\n');assert.ok(h.created.some(n=>n.download==='repot.patch'));});
test('operator writes off is never bypassed by acknowledgements',async()=>{const h=await harness({writes:false});await review(h);h.ids.acknowledge.checked=true;h.ids.workflows.checked=true;h.ids.workflows.dispatchEvent({type:'change'});assert.equal(h.ids.publish.disabled,true);h.ids.publish.click();assert.ok(!h.calls.some(c=>c.path.endsWith('/publish')));});
for(const mode of ['offline','htmlFallback','malformed'])test(`${mode} response exposes unavailable-backend state without enabling actions`,async()=>{const h=await harness({[mode]:true});assert.equal(h.ids['connection-state'].textContent,'FRONTEND PREVIEW');assert.equal(h.ids.composer.disabled,true);assert.equal(h.ids.connect.getAttribute('aria-disabled'),'true');fill(h);submit(h);assert.equal(h.calls.length,1);assert.equal(h.ids['delete-data'].disabled,true);});
test('feature, distinct repositories and consent are required before submitting',async()=>{const h=await harness();fill(h);assert.equal(h.ids['create-draft'].disabled,false);h.ids.destination.value='10';h.ids.destination.dispatchEvent({type:'change'});assert.equal(h.ids['create-draft'].disabled,true);submit(h);assert.ok(!h.calls.some(c=>c.path==='/api/jobs'&&c.opts.method==='POST'));h.ids.destination.value='20';h.ids.consent.checked=false;h.ids.consent.dispatchEvent({type:'change'});assert.equal(h.ids['create-draft'].disabled,true);});
test('a valid form preserves the existing request contract',async()=>{const h=await harness();fill(h);submit(h);await settle(()=>h.calls.some(c=>c.path==='/api/jobs'&&c.opts.method==='POST'));const c=h.calls.find(c=>c.path==='/api/jobs'&&c.opts.method==='POST');assert.deepEqual(JSON.parse(c.opts.body),{sourceId:10,destinationId:20,feature:'Move the CSV export',consentAI:true});});
test('rate-limit errors are visible, without automatic paid-request retries',async()=>{const h=await harness();h.blockDraft();fill(h);submit(h);await settle(()=>h.ids.status.textContent==='Allowance reached');assert.equal(h.calls.filter(c=>c.path==='/api/jobs'&&c.opts.method==='POST').length,1);});
test('session expiry clears private review text, links, repo names and feature inputs',async()=>{const h=await harness();await review(h);fill(h);h.expire();h.ids.refresh.click();await settle(()=>h.ids.composer.disabled);assert.equal(h.ids['review-title'].textContent,'Every change, considered.');assert.equal(h.ids.feature.value,'');assert.equal(h.ids.source.children.length,1);assert.equal(h.ids.source.firstChild.value,'');assert.equal(h.ids.publish.disabled,true);assert.equal(h.ids['pr-link'].href,undefined);});
test('blocked review cannot download a patch or publish',async()=>{const h=await harness();h.job.state='blocked';h.job.review.exportable=false;h.job.review.patch=null;await review(h);h.ids.acknowledge.checked=true;h.ids.workflows.checked=true;h.ids.workflows.dispatchEvent({type:'change'});assert.equal(h.ids.publish.disabled,true);assert.equal(h.ids.download.disabled,true);});
test('untrusted delivery URLs never become clickable',async()=>{const h=await harness();h.job.delivery={url:'javascript:alert(1)'};await review(h);assert.equal(h.ids['pr-link'].hidden,true);assert.equal(h.ids['pr-link'].href,undefined);});
test('anatomy tabs update labeled illustrative files, not execution statuses',async()=>{const h=await harness({signedIn:false});h.tabs[1].click();assert.equal(h.ids['anatomy-source'].textContent,'test/csv.test.ts');assert.equal(h.tabs[1].getAttribute('aria-pressed'),'true');assert.equal(h.tabs[0].getAttribute('aria-pressed'),'false');h.tabs[2].click();assert.equal(h.ids['anatomy-destination'].textContent,'tests/export/fixtures/rows.json');assert.equal(h.calls.length,1);});
test('selecting a different review clears previous publication consent',async()=>{const h=await harness();await review(h);h.ids.acknowledge.checked=true;h.ids.workflows.checked=true;h.ids.jobs.children[0].click();await settle(()=>!h.ids.acknowledge.checked);assert.equal(h.ids.workflows.checked,false);assert.equal(h.ids.publish.disabled,true);});
test('cancel and account deletion retain existing server endpoints',async()=>{const h=await harness();await review(h);h.ids.cancel.click();await settle(()=>h.calls.some(c=>c.path.endsWith('/cancel')));h.ids['delete-data'].click();await settle(()=>h.calls.some(c=>c.path==='/api/account/delete'));assert.ok(h.calls.filter(c=>c.opts.method==='POST').every(c=>c.opts.headers['x-csrf-token']==='test-csrf'));});
