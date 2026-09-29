/**
 * @file Current Repot public product interface asset used by the production Next.js deployment.
 *
 * UI invariant: user-visible status must reflect observed backend state; never imply unexecuted verification succeeded.
 */
// Repot presentation layer. API routes, session/CSRF and review-digest contracts stay unchanged.
/**
 * @function $
 * Implements $ for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
const $ = id => document.getElementById(id);
const state = { session: null, job: null, poll: null, busy: false, selection: 0, epoch: 0, online: false };
/**
 * @function el
 * Implements el for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
/**
 * @function notice
 * Implements notice for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function notice(text) { $('status').textContent = text; $('status').hidden = !text; }
/**
 * @function clearReview
 * Implements clear review for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function clearReview() {
  $('review-title').textContent = 'Every change, considered.';
  $('review-message').textContent = 'Choose a saved transfer to inspect its files, related tests, and proposed changes.';
  $('review-state').textContent = 'NO TRANSFER SELECTED';
  const empty = el('div', undefined, 'empty-review'); empty.append(el('span', '[ ↗︎ ]', 'empty-glyph'), el('span', 'Your next feature starts with a clear intention.')); $('review-details').replaceChildren(empty);
  $('publish-controls').hidden = true; $('cancel').hidden = true; $('pr-link').hidden = true; $('pr-link').removeAttribute('href');
  $('acknowledge').checked = false; $('workflows').checked = false; $('download').disabled = true;
}
/**
 * @function connectLink
 * Implements connect link for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function connectLink(available) {
  const label = available ? 'Connect GitHub ↗︎' : 'MCP ↗︎';
  const a = el('a', label, 'button secondary'); a.href = available ? '/auth/github' : '/mcp/'; $('account').replaceChildren(a);
  $('connect').textContent = available ? 'Connect GitHub ↗︎' : 'Connection unavailable';
  $('connect').href = available ? '/auth/github' : '#desk'; $('connect').setAttribute('aria-disabled', String(!available));
}
/**
 * @function loggedOut
 * Implements logged out for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function loggedOut(available = state.online) {
  clearTimeout(state.poll); state.epoch++; state.selection++; state.session = null; state.job = null; state.busy = false; state.online = available;
  // Remove private review content and repository names on logout, expiry and account deletion.
  clearReview(); $('source').replaceChildren(el('option', 'Select source repository')); $('source').firstChild.value = '';
  $('destination').replaceChildren(el('option', 'Select destination repository')); $('destination').firstChild.value = '';
  $('feature').value = ''; $('consent').checked = false; $('character-count').textContent = '0 / 1500';
  $('workspace').hidden = false; $('composer').disabled = true; $('welcome').hidden = false;
  $('refresh').disabled = true; $('delete-data').disabled = true;
  $('jobs').replaceChildren(el('p', 'Sign in to see your transfers. No repository data is stored in this browser.', 'muted'));
  $('connection-state').textContent = available ? 'SIGN IN REQUIRED' : 'FRONTEND PREVIEW';
  $('allowance').textContent = 'SIGN IN TO PREPARE A TRANSFER';
  $('welcome-title').textContent = available ? 'Start with your GitHub account.' : 'Explore the interface. Connect when ready.';
  $('welcome-copy').textContent = available ? 'The connected beta is invite-only. Sign in to select repositories and prepare a draft.' : 'The connected backend is unavailable on this deployment. Repository actions are disabled; no code is uploaded or changed.';
  connectLink(available); gate();
}
/**
 * @function request
 * Implements request for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': state.session?.csrf || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result; try { result = await response.json(); } catch { throw new Error('The connected backend is unavailable. This page does not execute repository actions on its own.'); }
  if (!response.ok) {
    if (response.status === 401) { loggedOut(true); const error = new Error('Sign in to continue.'); error.status = 401; throw error; }
    throw new Error(typeof result.error === 'string' ? result.error : 'Request failed. No automatic retry was performed.');
  }
  return result;
}
/**
 * @function gate
 * Implements gate for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function gate() {
  const valid = $('source').value && $('destination').value && $('source').value !== $('destination').value && $('feature').value.trim().length >= 3 && $('feature').value.length <= 1500 && $('consent').checked;
  $('create-draft').disabled = state.busy || !state.session?.aiConfigured || !valid;
  $('publish').disabled = state.busy || !state.session?.writesEnabled || !state.job?.review?.exportable || !['review_ready', 'delivery_uncertain'].includes(state.job?.state) || !$('acknowledge').checked || !$('workflows').checked;
}
/**
 * @function loadJobs
 * Implements load jobs for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
async function loadJobs() {
  if (!state.session) return; const epoch = state.epoch;
  const { jobs } = await request('/api/jobs'); if (epoch !== state.epoch) return;
  if (!Array.isArray(jobs)) throw new Error('The transfer history response was invalid.');
  $('jobs').replaceChildren();
  if (!jobs.length) $('jobs').append(el('p', 'No transfers yet. Your first feature starts above.', 'muted'));
  for (const j of jobs) {
    const b = el('button', undefined, 'job'); b.type = 'button'; b.setAttribute('aria-current', String(j.id === state.job?.id));
    b.append(el('strong', j.feature), el('small', j.state.replaceAll('_', ' ') + ' ↗︎'));
    b.addEventListener('click', () => select(j.id, true).catch(e => notice(e.message))); $('jobs').append(b);
  }
}
/**
 * @function safePR
 * Implements safe pr for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function safePR(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && !u.username && !u.password && !u.search && !u.hash && /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(u.pathname); } catch { return false; }
}
/**
 * @function render
 * Implements render for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
function render(job) {
  state.job = job; $('review-title').textContent = job.feature; $('review-message').textContent = job.message;
  $('review-state').textContent = job.state.replaceAll('_', ' ').toUpperCase();
  const details = $('review-details'); details.replaceChildren();
  $('cancel').hidden = !['queued', 'running', 'review_ready', 'blocked'].includes(job.state);
  $('publish-controls').hidden = !['review_ready', 'delivery_uncertain'].includes(job.state) || !job.review?.exportable;
  $('download').disabled = !job.review?.exportable || typeof job.review?.patch !== 'string';
  $('pr-link').hidden = !job.delivery || !safePR(job.delivery.url); $('pr-link').removeAttribute('href');
  if (!$('pr-link').hidden) $('pr-link').href = job.delivery.url;
  if (job.review) {
    details.append(el('div', 'BUILD: NOT RUN · TRANSFERRED TESTS: NOT RUN · EXISTING TESTS: NOT RUN', 'evidence'));
    details.append(el('p', `Review ${job.digest?.slice(0, 12) || '—'} · ${job.review.changes.length} changed files`, 'path'));
    const placements = job.review.testTransfer?.placements || [];
    if (placements.length) details.append(el('h4', 'Tests travel with the feature.'));
    for (const p of placements) { const row = el('div', undefined, 'mapping-row'); row.append(el('span', p.sourcePath), el('span', '↗︎'), el('span', p.destinationPath)); details.append(row); }
    for (const text of [...(job.review.testTransfer?.blockers || []), ...(job.review.risks || [])]) details.append(el('p', text, 'risk'));
    for (const c of job.review.changes) {
      const d = el('details', undefined, 'change'); d.append(el('summary', `${c.action === 'add' ? '+' : '~'} ${c.path}`), el('p', c.reason));
      const columns = el('div', undefined, 'diff-columns');
      for (const [heading, content] of [['BEFORE', c.before == null ? '(new file)' : c.before], ['PROPOSED', c.content]]) {
        const side = el('div', undefined, 'diff-side'), pre = el('pre', content); pre.tabIndex = 0; pre.setAttribute('aria-label', heading + ' code for ' + c.path);
        side.append(el('h4', heading), pre); columns.append(side);
      }
      d.append(columns); details.append(d);
    }
    if (!state.session?.writesEnabled) details.append(el('p', 'The operator has disabled GitHub writes. A reviewed patch is still available.', 'muted'));
  }
  gate();
}
/**
 * @function select
 * Implements select for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
async function select(id, focus = false) {
  clearTimeout(state.poll); const version = ++state.selection;
  $('acknowledge').checked = false; $('workflows').checked = false; gate();
  const job = await request('/api/jobs/' + id); if (version !== state.selection || !state.session) return; render(job);
  if (focus) { $('review').scrollIntoView?.({ block: 'start' }); $('review').focus({ preventScroll: true }); }
  if (['queued', 'running', 'publishing'].includes(job.state)) state.poll = setTimeout(() => select(id).catch(e => notice(e.message)), 1500);
}
$('refresh').addEventListener('click', () => loadJobs().catch(e => notice(e.message)));
$('transfer-form').addEventListener('submit', async event => {
  event.preventDefault(); gate(); if (state.busy || !state.session || $('create-draft').disabled) return;
  state.busy = true; gate(); const epoch = state.epoch;
  try {
    const job = await request('/api/jobs', { sourceId: Number($('source').value), destinationId: Number($('destination').value), feature: $('feature').value, consentAI: $('consent').checked });
    if (epoch !== state.epoch) return;
    notice('Draft started. Its result is saved on the connected service; paid requests are not automatically retried.'); await loadJobs(); await select(job.id, true);
  } catch (e) { notice(e.message); }
  finally { state.busy = false; gate(); }
});
for (const id of ['source', 'destination', 'consent', 'acknowledge', 'workflows']) $(id).addEventListener('change', gate);
$('feature').addEventListener('input', () => { $('character-count').textContent = `${$('feature').value.length} / 1500`; gate(); });
$('publish').addEventListener('click', async () => {
  gate(); if ($('publish').disabled) return; state.busy = true; gate(); const id = state.job.id, epoch = state.epoch;
  try { await request(`/api/jobs/${id}/publish`, { digest: state.job.digest, acknowledgeUnverified: true, acknowledgeWorkflows: true }); if (epoch === state.epoch) notice('Draft pull request created. Review and test it in GitHub before merging.'); }
  catch (e) { notice(e.message); }
  finally { state.busy = false; gate(); if (epoch === state.epoch && state.session) { await select(id).catch(e => notice(e.message)); await loadJobs().catch(e => notice(e.message)); } }
});
$('cancel').addEventListener('click', async () => { if (state.busy || !state.job || !state.session) return; state.busy = true; gate(); const id = state.job.id, epoch = state.epoch;
  try { await request(`/api/jobs/${id}/cancel`, {}); if (epoch === state.epoch) { await select(id); await loadJobs(); notice('Transfer cancelled. An already-started AI request may still be billed.'); } } catch (e) { notice(e.message); } finally { state.busy = false; gate(); }
});
$('download').addEventListener('click', () => {
  if (!state.job?.review?.exportable || typeof state.job.review.patch !== 'string') return;
  const a = el('a'), url = URL.createObjectURL(new Blob([state.job.review.patch], { type: 'text/plain' })); a.href = url; a.download = 'repot.patch'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('delete-data').addEventListener('click', async () => {
  if (!state.session || !confirm('Delete your saved Repot drafts and sessions? Existing GitHub branches and pull requests stay in GitHub.')) return;
  try { const result = await request('/api/account/delete', {}); loggedOut(true); notice(result.note); } catch (e) { notice(e.message); }
});
// This diagram is an illustration, not fabricated repository analysis or an execution result.
const layers = {
  implementation: ['src/csv.ts', 'lib/export/csv.ts', 'Adapt the implementation to its new surroundings.'],
  tests: ['test/csv.test.ts', 'tests/export/csv.test.ts', 'Preserve the assertions. Adapt the supported imports and placement.'],
  support: ['test/fixtures/rows.json', 'tests/export/fixtures/rows.json', 'Bring the explicitly referenced helpers and text fixtures.']
};
for (const button of document.querySelectorAll('[data-layer]')) button.addEventListener('click', () => {
  const layer = layers[button.dataset.layer]; if (!layer) return;
  for (const b of document.querySelectorAll('[data-layer]')) b.setAttribute('aria-pressed', String(b === button));
  $('anatomy-source').textContent = layer[0]; $('anatomy-destination').textContent = layer[1]; $('anatomy-note').textContent = layer[2];
});
/**
 * @function init
 * Implements init for the Repot interface.
 * UX/security: keep state transitions explicit and render repository/user text as text rather than executable HTML.
 */
async function init() {
  try {
    const session = await request('/api/session');
    if (!session?.user?.login || typeof session.csrf !== 'string' || typeof session.aiConfigured !== 'boolean' || typeof session.writesEnabled !== 'boolean') throw new Error('The connected backend returned an invalid session.');
    state.session = session; state.online = true; state.epoch++; const epoch = state.epoch;
    $('welcome').hidden = true; $('workspace').hidden = false; $('composer').disabled = false;
    $('refresh').disabled = false; $('delete-data').disabled = false; $('connection-state').textContent = 'GITHUB CONNECTED';
    $('account').replaceChildren(el('span', session.user.login)); const b = el('button', 'Sign out ↗︎', 'button secondary'); b.type = 'button';
    b.addEventListener('click', async () => { try { await request('/api/logout', {}); loggedOut(true); notice('Signed out. Private review content has been cleared.'); } catch (e) { notice(e.message); } }); $('account').append(b);
    $('allowance').textContent = `${session.userDailyDraftLimit} DRAFT REQUESTS / UTC DAY · 24H RETENTION`; gate();
    if (!session.aiConfigured) notice('AI drafting is disabled until the operator configures a model and API budget. Repository selection is available.');
    const { repositories } = await request('/api/repos'); if (epoch !== state.epoch) return;
    if (!Array.isArray(repositories)) throw new Error('The repository list response was invalid.');
    for (const r of repositories) for (const target of ['source', 'destination']) {
      const option = el('option', `${r.name}${r.private ? ' · private' : ''}`); option.value = r.id;
      option.disabled = target === 'destination' && (!r.writable || r.archived === true); $(target).append(option);
    }
    if (!repositories.length) notice('No repositories available. Install the GitHub App on the repositories you want to use, then reconnect.');
    await loadJobs();
  } catch (e) { if (e.status === 401) return; if (state.session) notice(e.message); else { loggedOut(false); } }
}
init();
