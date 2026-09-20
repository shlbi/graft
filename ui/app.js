const $ = selector => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let reviewId = null;
let currentReview = null;
let uploadToken = null;
let uploadMaxBytes = 0;

function metric(value, label) {
  const box = el('div', 'metric');
  box.append(el('strong', '', String(value)), el('span', '', label));
  return box;
}

function nodeCard(item) {
  const card = el('div', `node ${item.kind}`);
  card.append(el('code', '', item.path), el('small', '', item.kind.replace('-', ' ')));
  return card;
}

function renderGraph(review) {
  const graph = $('#graph');
  graph.replaceChildren();
  const source = el('div', 'lane');
  const bridge = el('div', 'connector');
  const destination = el('div', 'lane');
  const sourceHead = el('div', 'lane-title');
  sourceHead.append(el('span', '', 'SOURCE FEATURE'), el('span', '', 'copy boundary'));
  const destinationHead = el('div', 'lane-title');
  destinationHead.append(el('span', '', 'DESTINATION APP'), el('span', '', 'reuse infrastructure'));
  source.append(sourceHead);
  destination.append(destinationHead);
  review.graph.nodes.filter(item => item.side === 'source').forEach(item => source.append(nodeCard(item)));
  const relations = el('div', 'relations');
  relations.append(el('small', '', 'DISCOVERED EDGES'));
  review.graph.edges.filter(edge => edge.kind === 'dependency' || edge.kind === 'boundary').forEach(edge => {
    relations.append(el('code', '', `${edge.from.replace('source:', '')} → ${edge.to.replace('source:', '')}`));
  });
  source.append(relations);
  review.graph.nodes.filter(item => item.side === 'destination').forEach(item => destination.append(nodeCard(item)));
  bridge.append(el('span', '', 'STOP'), el('b', '', '⇢'), el('span', '', 'MAP'));
  graph.append(source, bridge, destination);
}

function renderMappings(review) {
  const root = $('#mappings');
  root.replaceChildren();
  for (const mapping of review.mappings) {
    const card = el('div', 'mapping');
    card.append(el('span', 'tag', mapping.kind));
    const route = el('div', 'route');
    route.append(el('code', '', `${mapping.source}\n${review.bindings.find(item => item.sourceCapability === mapping.source)?.sourceModule ?? ''}`));
    route.append(el('span', 'arrow', '→'));
    route.append(el('code', '', `${mapping.destination}\n${mapping.destinationModule}`));
    card.append(route);
    root.append(card);
  }
}

function renderChanges(review) {
  const root = $('#changes');
  root.replaceChildren();
  for (const copy of review.copies) {
    const card = el('div', 'change');
    card.append(el('span', 'tag', 'create'), el('strong', '', copy.targetPath), el('code', '', `from ${copy.sourcePath}`));
    root.append(card);
  }
  for (const patch of review.integrations) {
    const card = el('div', 'change');
    card.append(el('span', 'tag', 'integrate'), el('strong', '', patch.targetPath), el('code', '', `exact marker · ${patch.id}`));
    root.append(card);
  }
  const diff = $('#diff');
  diff.replaceChildren();
  for (const patch of review.integrations) {
    const before = el('div', 'diff-column');
    before.append(el('label', '', `${patch.targetPath} · BEFORE`), el('pre', '', patch.before));
    const after = el('div', 'diff-column');
    after.append(el('label', '', `${patch.targetPath} · AFTER`), el('pre', '', patch.after));
    diff.append(before, after);
  }
}

function renderReview(review) {
  currentReview = review;
  $('#metrics').replaceChildren(
    metric(review.dependencies.files.length, 'feature modules'),
    metric(review.dependencies.adapterBoundaries.length, 'adapter boundaries'),
    metric(review.mappings.length, 'capability grafts'),
    metric(review.touchedTargets.length, 'destination paths'),
  );
  renderGraph(review);
  renderMappings(review);
  renderChanges(review);
  $('#limitations').replaceChildren(...review.limitations.map(item => el('li', '', item)));
  const pill = $('#statusPill');
  pill.className = `pill ${review.ready ? 'ready' : ''}`;
  pill.textContent = review.ready ? 'READY FOR REVIEW' : 'BLOCKED';
  $('#approveButton').disabled = !review.ready;
}

function renderResult(payload) {
  const verification = payload.verification;
  const run = verification.runs[0];
  const result = $('#result');
  result.replaceChildren();
  const grid = el('div', 'proof-grid');
  const source = el('div', 'proof');
  source.append(el('span', 'tag', 'source'), el('strong', '', verification.source.result.fileId));
  const sourceProgress = el('div', 'progress-line');
  verification.source.result.progress.forEach(item => sourceProgress.append(el('span', '', `${item.progress}%`)));
  source.append(sourceProgress);
  const baseline = el('div', 'proof');
  baseline.append(el('span', 'tag', 'before'), el('strong', '', verification.before.hasUploadFeature ? 'feature present' : 'feature absent'));
  const destination = el('div', 'proof');
  destination.append(el('span', 'tag', 'after · compiled'), el('strong', '', run.after.result.fileId));
  const destinationProgress = el('div', 'progress-line');
  run.after.result.progress.forEach(item => destinationProgress.append(el('span', '', `${item.progress}%`)));
  destination.append(destinationProgress, el('code', '', 'destination adapters · reset verified'));
  grid.append(source, baseline, destination);
  result.append(grid);
  $('#resultPanel').classList.remove('hidden');

  uploadToken = payload.uploadDemo?.token ?? null;
  uploadMaxBytes = payload.uploadDemo?.maxUploadBytes ?? 0;
  if (uploadToken) {
    $('#uploadPanel').classList.remove('hidden');
    $('#uploadButton').disabled = !$('#uploadInput').files?.length;
    $('#uploadResult').className = 'upload-result muted';
    $('#uploadResult').textContent = `Approved runtime ready for ${payload.uploadDemo.expiresInSeconds}s. Uploads enter an explicit queued job and are polled to completion. Choose a text-like file up to ${Math.floor(uploadMaxBytes / 1024)} KB.`;
  }

  const pill = $('#statusPill');
  pill.className = 'pill verified';
  pill.textContent = 'TRANSPLANT VERIFIED';
  $('#approvalCopy').textContent = `Created ${payload.applied.created.length}, updated ${payload.applied.updated.length}, preserved ${payload.applied.preserved.length}. Clean reset passed.`;
}

function renderUploadResult(payload) {
  const root = $('#uploadResult');
  root.className = 'upload-result';
  root.replaceChildren();
  const completed = payload.result.progress.at(-1);
  root.append(el('span', 'tag', 'destination job · complete'), el('strong', '', `${payload.name} · ${payload.result.fileId}`));
  const progress = el('div', 'upload-progress');
  payload.result.progress.forEach(item => progress.append(el('span', '', `${item.stage} ${item.progress}%`)));
  root.append(progress);
  if (completed?.metrics) {
    const metrics = el('div', 'upload-metrics');
    for (const [label, value] of [
      ['bytes', completed.metrics.bytes], ['lines', completed.metrics.lines], ['words', completed.metrics.words],
      ['unique', completed.metrics.uniqueWords], ['checksum', completed.metrics.checksum],
    ]) {
      const item = el('div', 'upload-metric');
      item.append(el('b', '', String(value)), el('span', '', label));
      metrics.append(item);
    }
    root.append(metrics);
  }
}

async function pollUploadJob(pollPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(pollPath, {
      headers: { 'x-graft-upload-token': uploadToken, accept: 'application/json' },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `job poll failed (${response.status})`);
    $('#uploadResult').className = 'upload-result muted';
    $('#uploadResult').textContent = `Destination job ${payload.id.slice(0, 8)}… · ${payload.state}`;
    if (payload.state === 'complete') return payload;
    if (payload.state === 'failed') throw new Error(payload.error ?? 'destination job failed');
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('destination job did not complete before the demo polling timeout');
}

async function loadReview() {
  try {
    const response = await fetch('/api/review', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`review request failed (${response.status})`);
    const payload = await response.json();
    reviewId = payload.reviewId;
    renderReview(payload.review);
  } catch (error) {
    $('#statusPill').textContent = 'REVIEW ERROR';
    $('#approvalCopy').className = 'error';
    $('#approvalCopy').textContent = error.message;
  }
}

$('#approveButton').addEventListener('click', async () => {
  if (!reviewId || !currentReview?.ready) return;
  const button = $('#approveButton');
  button.disabled = true;
  button.textContent = 'Compiling & verifying…';
  try {
    const response = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ reviewId, approved: true }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? `approval failed (${response.status})`);
    renderResult(payload);
    button.textContent = 'Verified ✓';
  } catch (error) {
    $('#approvalCopy').className = 'error';
    $('#approvalCopy').textContent = error.message;
    button.textContent = 'Approval failed';
  }
});

$('#uploadInput').addEventListener('change', () => {
  const file = $('#uploadInput').files?.[0];
  $('#uploadButton').disabled = !uploadToken || !file;
  if (file && uploadMaxBytes && file.size > uploadMaxBytes) {
    $('#uploadResult').className = 'upload-result upload-error';
    $('#uploadResult').textContent = `File is ${file.size} bytes; this demo is capped at ${uploadMaxBytes} bytes.`;
    $('#uploadButton').disabled = true;
  }
});

$('#uploadButton').addEventListener('click', async () => {
  const file = $('#uploadInput').files?.[0];
  if (!file || !uploadToken) return;
  const button = $('#uploadButton');
  button.disabled = true;
  button.textContent = 'Queueing destination job…';
  try {
    const response = await fetch(`/api/demo-upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'x-graft-upload-token': uploadToken, 'content-type': file.type || 'application/octet-stream' },
      body: file,
    });
    const accepted = await response.json();
    if (!response.ok) throw new Error(accepted.error ?? `upload failed (${response.status})`);
    if (response.status !== 202 || accepted.state !== 'queued' || typeof accepted.poll !== 'string') {
      throw new Error('approved runtime did not return the expected queued job contract');
    }
    $('#uploadResult').className = 'upload-result muted';
    $('#uploadResult').textContent = `Queued ${accepted.name} · waiting for destination job ${accepted.id.slice(0, 8)}…`;
    button.textContent = 'Polling destination job…';
    const completed = await pollUploadJob(accepted.poll);
    renderUploadResult(completed);
    button.textContent = 'Upload another file →';
    button.disabled = false;
  } catch (error) {
    $('#uploadResult').className = 'upload-result upload-error';
    $('#uploadResult').textContent = error.message;
    button.textContent = 'Upload failed';
  }
});

loadReview();
