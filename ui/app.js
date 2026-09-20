const $ = selector => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

let reviewId = null;
let currentReview = null;

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
  const limitations = $('#limitations');
  limitations.replaceChildren(...review.limitations.map(item => el('li', '', item)));
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
  const pill = $('#statusPill');
  pill.className = 'pill verified';
  pill.textContent = 'TRANSPLANT VERIFIED';
  $('#approvalCopy').textContent = `Created ${payload.applied.created.length}, updated ${payload.applied.updated.length}, preserved ${payload.applied.preserved.length}. Clean reset passed.`;
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

loadReview();
