const $ = selector => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const state = { reviewId: null, review: null, token: null, maxBytes: 0, expires: 0, file: null, busy: false };
const sampleText = 'Graft moves behavior, not infrastructure.\nThe destination owns storage and processing.\nReview. Approve. Verify. Repeat.\n';

function status(text, kind = '') { $('#statusPill').textContent = text; $('#statusPill').className = `pill ${kind}`; }
function metric(value, label) { const node = el('div', 'metric'); node.append(el('strong', '', String(value)), el('span', '', label)); return node; }
function nodeCard(item) { const card = el('div', `node ${item.kind}`); card.append(el('code', '', item.path), el('small', '', item.kind.replaceAll('-', ' '))); return card; }
function renderGraph(review) {
  const source = el('div', 'lane'); const destination = el('div', 'lane'); const bridge = el('div', 'connector');
  for (const [lane, side, title, sub] of [[source,'source','SOURCE FEATURE','copy boundary'],[destination,'destination','DESTINATION APP','reuse infrastructure']]) {
    const heading = el('div','lane-title'); heading.append(el('span','',title),el('span','',sub)); lane.append(heading);
    review.graph.nodes.filter(node => node.side === side).forEach(node => lane.append(nodeCard(node)));
  }
  const relations = el('div','relations'); relations.append(el('small','','DISCOVERED IMPORT EDGES'));
  review.graph.edges.filter(edge => ['dependency','boundary'].includes(edge.kind)).forEach(edge => relations.append(el('code','',`${edge.from.replace('source:','')} → ${edge.to.replace('source:','')}`)));
  source.append(relations); bridge.append(el('span','','BOUNDARY'),el('b','','⇢'),el('span','','REMAP'));
  $('#graph').replaceChildren(source,bridge,destination);
}
function renderReview(review) {
  state.review = review;
  $('#metrics').replaceChildren(metric(review.dependencies.files.length,'feature modules'),metric(review.dependencies.adapterBoundaries.length,'adapter boundaries'),metric(review.mappings.length,'capability grafts'),metric(review.touchedTargets.length,'destination paths'));
  renderGraph(review); $('#mappings').replaceChildren();
  for (const mapping of review.mappings) {
    const card=el('div','mapping'), route=el('div','route'); card.append(el('span','tag',mapping.kind));
    route.append(el('code','',`${mapping.source}\n${review.bindings.find(binding=>binding.sourceCapability===mapping.source)?.sourceModule ?? ''}`),el('span','arrow','→'),el('code','',`${mapping.destination}\n${mapping.destinationModule}`));
    card.append(route); $('#mappings').append(card);
  }
  $('#changes').replaceChildren(); $('#diff').replaceChildren();
  for (const operation of review.copies) { const card=el('div','change'); card.append(el('span','tag','create'),el('strong','',operation.targetPath),el('code','',`from ${operation.sourcePath}`)); $('#changes').append(card); }
  for (const patch of review.integrations) {
    const card=el('div','change'); card.append(el('span','tag','integrate'),el('strong','',patch.targetPath),el('code','',`exact marker · ${patch.id}`)); $('#changes').append(card);
    for (const [label,code] of [['BEFORE',patch.before],['AFTER',patch.after]]) { const column=el('div','diff-column'); column.append(el('label','',`${patch.targetPath} · ${label}`),el('pre','',code)); $('#diff').append(column); }
  }
  $('#limitations').replaceChildren(...review.limitations.map(text=>el('li','',text)));
  const blockers=[...review.dependencies.blockers,...Object.values(review.blockers).flat()];
  $('#blockers').hidden=blockers.length===0; $('#blockers').replaceChildren(...blockers.map(item=>el('p','',`${item.reason ?? 'blocked'} · ${item.path ?? item.targetPath ?? item.source ?? ''}`)));
  status(review.ready?'READY FOR REVIEW':'BLOCKED',review.ready?'ready':''); $('#approveButton').disabled=!review.ready; $('#exportButton').disabled=false;
}
function renderProof(payload) {
  const verification=payload.verification, run=verification.runs[0]; const grid=el('div','proof-grid');
  for (const [tag,title,progress,note] of [
    ['source',verification.source.result.fileId,verification.source.result.progress,'source adapters'],
    ['before',verification.before.hasUploadFeature?'feature present':'feature absent',[],'original destination'],
    ['after · compiled',run.after.result.fileId,run.after.result.progress,run.cleanReset?'destination adapters · reset verified':'reset not verified'],
  ]) {
    const card=el('div','proof'); card.append(el('span','tag',tag),el('strong','',title));
    const history=el('div','progress-line'); progress.forEach(item=>history.append(el('span','',`${item.progress}%`)));
    card.append(history,el('code','',note)); grid.append(card);
  }
  $('#result').replaceChildren(grid); $('#resultPanel').hidden=false;
  state.token=payload.uploadDemo?.token ?? null; state.maxBytes=payload.uploadDemo?.maxUploadBytes ?? 0;
  state.expires=Date.now()+(payload.uploadDemo?.expiresInSeconds ?? 0)*1000;
  $('#uploadPanel').hidden=!state.token;
  $('#uploadResult').className='upload-result muted'; $('#uploadResult').textContent='Approved runtime ready. Upload UTF-8 text, or use the included sample. Jobs are queued and polled; storage is in-memory.';
  $('#approvalCopy').textContent=`Created ${payload.applied.created.length}, updated ${payload.applied.updated.length}, preserved ${payload.applied.preserved.length}. Compile, execution and clean reset passed.`;
  status('TRANSPLANT VERIFIED','verified');
}
function renderJob(job) {
  const root=$('#uploadResult'); root.className='upload-result'; root.replaceChildren();
  root.append(el('span','tag','destination job · complete'),el('strong','',`${job.name} · ${job.result.fileId}`));
  const history=el('div','upload-progress'); job.result.progress.forEach(item=>history.append(el('span','',`${item.stage} ${item.progress}%`))); root.append(history);
  const metrics=job.result.progress.at(-1)?.metrics;
  if (metrics) {
    const grid=el('div','upload-metrics');
    for (const [label,value] of [['bytes',metrics.bytes],['lines',metrics.lines],['words',metrics.words],['unique',metrics.uniqueWords],['checksum',metrics.checksum]]) { const item=el('div','upload-metric'); item.append(el('b','',String(value)),el('span','',label)); grid.append(item); }
    root.append(grid);
  }
}
async function requestJson(path, options = {}) {
  const response=await fetch(path,{...options,signal:AbortSignal.timeout(120_000)});
  const payload=await response.json();
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return {response,payload};
}
function syncControls() {
  const approved=Boolean(state.token) && Date.now()<state.expires;
  $('#refreshButton').disabled=state.busy;
  $('#uploadInput').disabled=state.busy || !approved;
  $('#sampleButton').disabled=state.busy || !approved;
  $('#uploadButton').disabled=state.busy || !approved || !state.file || state.file.size<1 || state.file.size>state.maxBytes;
}
async function loadReview() {
  if(state.busy) return;
  state.busy=true; state.review=null; state.reviewId=null; state.token=null; state.file=null;
  $('#uploadInput').value=''; $('#resultPanel').hidden=true; $('#uploadPanel').hidden=true;
  $('#approveButton').disabled=true; $('#approveButton').textContent='Approve & verify transplant →'; $('#exportButton').disabled=true;
  $('#approvalCopy').className=''; $('#approvalCopy').textContent='The server owns the prepared plan. Review the changes before approving.';
  status('PREPARING REVIEW'); syncControls();
  try { const {payload}=await requestJson('/api/review'); state.reviewId=payload.reviewId; renderReview(payload.review); }
  catch(error) { status('REVIEW ERROR'); $('#approvalCopy').className='error'; $('#approvalCopy').textContent=`${error.message}. Select New review to retry.`; }
  finally { state.busy=false; syncControls(); }
}
$('#refreshButton').addEventListener('click',loadReview);
$('#exportButton').addEventListener('click',()=>{
  if(!state.review) return;
  // Export contains only the read-only review model: no session IDs or upload tokens.
  const url=URL.createObjectURL(new Blob([JSON.stringify(state.review,null,2)],{type:'application/json'}));
  const link=el('a'); link.href=url; link.download='graft-review.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('#approveButton').addEventListener('click',async()=>{
  if(state.busy || !state.reviewId || !state.review?.ready) return;
  state.busy=true; $('#approveButton').disabled=true; $('#approveButton').textContent='Compiling & verifying…'; syncControls();
  try {
    const {payload}=await requestJson('/api/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reviewId:state.reviewId,approved:true})});
    state.reviewId=null; renderProof(payload); $('#approveButton').textContent='Verified ✓';
  } catch(error) { state.reviewId=null; $('#approvalCopy').className='error'; $('#approvalCopy').textContent=`${error.message}. Prepare a New review before retrying approval.`; $('#approveButton').textContent='Approval failed'; }
  finally { state.busy=false; syncControls(); }
});
function selectFile(file) {
  state.file=file; $('#fileLabel').textContent=file?`${file.name} · ${file.size} bytes`:'Choose a local file or use the original sample.';
  if(file && (file.size<1 || file.size>state.maxBytes)) { $('#uploadResult').className='upload-result upload-error'; $('#uploadResult').textContent=`Choose a nonempty UTF-8 file of at most ${state.maxBytes} bytes.`; }
  syncControls();
}
$('#uploadInput').addEventListener('change',()=>selectFile($('#uploadInput').files?.[0] ?? null));
$('#sampleButton').addEventListener('click',()=>{ $('#uploadInput').value=''; selectFile(new File([sampleText],'graft-proof.txt',{type:'text/plain'})); });
$('#uploadButton').addEventListener('click',async()=>{
  if(state.busy || !state.file || !state.token || state.file.size<1 || state.file.size>state.maxBytes) return;
  if(Date.now()>=state.expires) { syncControls(); $('#uploadResult').textContent='Runtime expired. Prepare and approve a New review.'; return; }
  state.busy=true; syncControls(); $('#uploadButton').textContent='Queueing destination job…';
  const token=state.token;
  try {
    const {response,payload:accepted}=await requestJson(`/api/demo-upload?name=${encodeURIComponent(state.file.name)}`,{method:'POST',headers:{'x-graft-upload-token':token,'content-type':state.file.type || 'application/octet-stream'},body:state.file});
    if(response.status!==202 || accepted.state!=='queued' || !/^\/api\/demo-jobs\/[A-Za-z0-9_-]+$/.test(accepted.poll)) throw new Error('Unexpected queued-job response');
    $('#uploadResult').className='upload-result muted'; $('#uploadResult').textContent=`Accepted ${accepted.name} · queued for destination processing.`;
    $('#uploadButton').textContent='Polling destination job…';
    const deadline=Date.now()+30_000;
    for(;;) {
      const {payload:job}=await requestJson(accepted.poll,{headers:{'x-graft-upload-token':token}});
      if(job.state==='failed') throw new Error(job.error ?? 'Destination processing failed');
      if(job.state==='complete') { renderJob(job); break; }
      $('#uploadResult').textContent=`Destination job ${job.id.slice(0,8)}… · ${job.state}`;
      if(Date.now()>=deadline) throw new Error('Job polling timed out; the accepted job may still finish. Prepare a new review to restart the demo.');
      await new Promise(resolve=>setTimeout(resolve,75));
    }
  } catch(error) { $('#uploadResult').className='upload-result upload-error'; $('#uploadResult').textContent=error.message; }
  finally { state.busy=false; $('#uploadButton').textContent='Upload through destination →'; syncControls(); }
});
void loadReview();
