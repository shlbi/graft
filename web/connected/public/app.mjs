const $ = id => document.getElementById(id);
const state = { session: null, job: null, poll: null, busy: false, selection: 0 };
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
function notice(text) { $('status').textContent = text; $('status').hidden = false; }
async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': state.session?.csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) loggedOut(); throw new Error(result.error || 'Request failed.'); } return result;
}
function loggedOut() { clearTimeout(state.poll); state.session = null; state.job = null; state.selection++; $('workspace').hidden = true; $('welcome').hidden = false; $('account').replaceChildren(); const a = el('a', 'Connect GitHub ↗', 'button secondary'); a.href = '/auth/github'; $('account').append(a); }
async function loadJobs() {
  const { jobs } = await request('/api/jobs'); $('jobs').replaceChildren();
  if (!jobs.length) $('jobs').append(el('p', 'Your first transfer starts above.'));
  for (const j of jobs) { const b = el('button', undefined, 'job'); b.append(el('strong', j.feature), el('small', j.state.replaceAll('_', ' '))); b.addEventListener('click', () => select(j.id).catch(e => notice(e.message))); $('jobs').append(b); }
}
function gate() { $('publish').disabled = state.busy || !state.session?.writesEnabled || !$('acknowledge').checked || !$('workflows').checked; }
function render(job) {
  state.job = job; $('review-title').textContent = job.feature; $('review-message').textContent = job.message;
  const details = $('review-details'); details.replaceChildren();
  $('cancel').hidden = !['queued', 'running', 'review_ready', 'blocked'].includes(job.state);
  $('publish-controls').hidden = !['review_ready', 'delivery_uncertain'].includes(job.state) || !job.review?.exportable;
  $('download').disabled = !job.review?.exportable; $('pr-link').hidden = !job.delivery;
  if (job.delivery) $('pr-link').href = job.delivery.url;
  if (job.review) {
    details.append(el('div', 'BUILD: NOT RUN · TRANSFERRED TESTS: NOT RUN · EXISTING TESTS: NOT RUN', 'evidence'));
    details.append(el('p', `Review ${job.digest?.slice(0, 12)} · ${job.review.changes.length} changed files`, 'path'));
    for (const p of job.review.testTransfer?.placements || []) details.append(el('p', `${p.sourcePath} → ${p.destinationPath}`, 'path'));
    for (const text of [...(job.review.testTransfer?.blockers || []), ...(job.review.risks || [])]) details.append(el('p', text));
    for (const c of job.review.changes) { const d = el('details', undefined, 'change'); d.append(el('summary', `${c.action === 'add' ? '+' : '~'} ${c.path}`), el('p', c.reason));
      const before = el('pre', c.before == null ? '(new file)' : c.before), after = el('pre', c.content); d.append(el('h3', 'Before'), before, el('h3', 'Proposed'), after); details.append(d); }
    if (!state.session.writesEnabled) details.append(el('p', 'The operator has disabled GitHub writes. A reviewed patch is still available.'));
  }
  gate();
}
async function select(id) {
  clearTimeout(state.poll); const version = ++state.selection;
  $('acknowledge').checked = false; $('workflows').checked = false; gate();
  const job = await request('/api/jobs/' + id); if (version !== state.selection) return; render(job);
  if (['queued', 'running', 'publishing'].includes(job.state)) state.poll = setTimeout(() => select(id).catch(e => notice(e.message)), 1500);
}
$('refresh').addEventListener('click', () => loadJobs().catch(e => notice(e.message)));
$('transfer-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy) return; state.busy = true; $('create-draft').disabled = true;
  try {
    const job = await request('/api/jobs', { sourceId: Number($('source').value), destinationId: Number($('destination').value), feature: $('feature').value, consentAI: $('consent').checked });
    notice('Draft started. You can leave this page and return to its saved result. AI requests are not automatically retried.'); await loadJobs(); await select(job.id); $('review').focus();
  } catch (e) { notice(e.message); }
  finally { state.busy = false; $('create-draft').disabled = !state.session?.aiConfigured; gate(); }
});
for (const id of ['acknowledge', 'workflows']) $(id).addEventListener('change', gate);
$('publish').addEventListener('click', async () => {
  if (state.busy || !state.job || !$('acknowledge').checked || !$('workflows').checked) return;
  state.busy = true; gate(); const id = state.job.id;
  try { await request(`/api/jobs/${id}/publish`, { digest: state.job.digest, acknowledgeUnverified: true, acknowledgeWorkflows: true }); notice('Draft pull request created. Review and test it in GitHub before merging.'); }
  catch (e) { notice(e.message); }
  finally { state.busy = false; gate(); await select(id).catch(e => notice(e.message)); await loadJobs().catch(e => notice(e.message)); }
});
$('cancel').addEventListener('click', async () => { try { if (state.job) { await request(`/api/jobs/${state.job.id}/cancel`, {}); await select(state.job.id); await loadJobs(); } } catch (e) { notice(e.message); } });
$('download').addEventListener('click', () => {
  if (!state.job?.review?.exportable) return;
  const a = el('a'), url = URL.createObjectURL(new Blob([state.job.review.patch], { type: 'text/plain' })); a.href = url; a.download = 'graft.patch'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('delete-data').addEventListener('click', async () => {
  if (!confirm('Delete your saved drafts and sessions? Existing GitHub branches and pull requests will stay in GitHub.')) return;
  try { const result = await request('/api/account/delete', {}); loggedOut(); notice(result.note); } catch (e) { notice(e.message); }
});
async function init() {
  try {
    state.session = await request('/api/session'); $('welcome').hidden = true; $('workspace').hidden = false;
    $('account').replaceChildren(el('span', state.session.user.login)); const b = el('button', 'Sign out', 'button secondary');
    b.addEventListener('click', async () => { try { await request('/api/logout', {}); loggedOut(); } catch (e) { notice(e.message); } }); $('account').append(b);
    $('allowance').textContent = `${state.session.userDailyDraftLimit} draft requests per UTC day · 24h retention`;
    $('create-draft').disabled = !state.session.aiConfigured;
    if (!state.session.aiConfigured) notice('AI drafting is disabled until the operator configures a model and API budget. GitHub connection and repository selection still work.');
    const { repositories } = await request('/api/repos');
    for (const r of repositories) for (const target of ['source', 'destination']) { const option = el('option', `${r.name}${r.private ? ' · private' : ''}`); option.value = r.id; option.disabled = target === 'destination' && (!r.writable || r.archived === true); $(target).append(option); }
    if (!repositories.length) notice('No repositories available. Install this GitHub App on the repositories you want to use, then reconnect.');
    await loadJobs();
  } catch (e) { if (state.session) notice(e.message); }
}
init();
