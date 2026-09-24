import { eligiblePath, looksSensitive, LIMITS } from '/policy.mjs';
const $ = id => document.getElementById(id);
const state = { folders: { source: null, destination: null }, result: null, controller: null, configured: false };
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
function notify(text, kind = '') { const el = $('status'); el.textContent = text; el.className = 'notice ' + kind; el.hidden = false; }
function clearResult() { state.result = null; $('results').hidden = true; $('review-confirmation').checked = false; $('download-patch').disabled = true; }
function busy(value) {
  $('analyze').disabled = value; $('try-demo').disabled = value; $('cancel').hidden = !value;
  for (const id of ['source-url', 'destination-url', 'source-folder', 'destination-folder', 'feature', 'consent']) $(id).disabled = value;
  $('use-ai').disabled = value || !state.configured;
  document.querySelectorAll('[data-feature]').forEach(b => b.disabled = value);
  $('analyze').textContent = value ? 'Reading your projects…' : $('use-ai').checked ? 'Draft my transfer →' : 'Find my feature →';
}
function urlValue(value) { return value.trim().startsWith('github.com/') ? 'https://' + value.trim() : value.trim(); }
function selection(role) {
  if (state.folders[role]) return { kind: 'folder', snapshot: state.folders[role] };
  const url = urlValue($(role + '-url').value); if (!url) throw new Error(`Choose a ${role} repository or local folder.`);
  return { kind: 'github', url };
}
function resetFolder(role) { state.folders[role] = null; $(role + '-folder').value = ''; $(role + '-hint').textContent = 'Public URL or local code'; clearResult(); }
for (const role of ['source', 'destination']) {
  $(role + '-url').addEventListener('input', () => resetFolder(role));
  $(role + '-folder').addEventListener('change', async event => {
    if (state.controller) return;
    const items = [...event.target.files]; if (!items.length) return;
    clearResult(); const files = [], inventory = []; let total = 0, excluded = 0;
    const controller = new AbortController(); state.controller = controller; busy(true);
    $(role + '-hint').textContent = 'Reading folder…';
    try {
      if (items.length > 20000) throw new Error('Folder contains too many files. Choose a smaller source directory.');
      for (const f of items) {
        controller.signal.throwIfAborted();
        const filePath = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
        inventory.push(filePath);
        if (!eligiblePath(filePath) || f.size > LIMITS.fileBytes) { excluded++; continue; }
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer()); } catch { excluded++; continue; }
        controller.signal.throwIfAborted();
        if (content.includes('\0') || looksSensitive(content)) { excluded++; continue; }
        total += new TextEncoder().encode(content).length;
        if (total > LIMITS.snapshotBytes || files.length >= LIMITS.files) throw new Error('Folder is too large for this preview. Choose a feature-focused subdirectory.');
        files.push({ path: filePath, content });
      }
      if (!files.length) throw new Error('No eligible source files were found.');
      const name = (items[0].webkitRelativePath || 'local-project').split('/')[0];
      state.folders[role] = { name, files, inventory };
      $(role + '-url').value = name;
      $(role + '-hint').textContent = `${files.length} text files · ${excluded} excluded`;
      notify('Folder selected. Nothing is sent to an AI provider unless you enable AI and confirm code sharing.');
    } catch (e) { resetFolder(role); notify(e.name === 'AbortError' ? 'Folder import cancelled.' : e.message, 'error'); }
    finally { state.controller = null; busy(false); }
  });
}
$('feature').addEventListener('input', () => { $('character-count').textContent = `${$('feature').value.length} / 1500`; clearResult(); });
document.querySelectorAll('[data-feature]').forEach(b => b.addEventListener('click', () => { $('feature').value = b.dataset.feature; $('feature').dispatchEvent(new Event('input')); $('feature').focus(); }));
$('use-ai').addEventListener('change', () => { busy(false); clearResult(); });
$('cancel').addEventListener('click', () => state.controller?.abort());
async function run(path, payload) {
  if (state.controller) return;
  const controller = new AbortController(); state.controller = controller;
  clearResult(); busy(true);
  notify(path === '/api/demo' ? 'Preparing the authored CSV transfer example…' : 'Reading repository snapshots and finding matching feature code. No code is being executed.', 'working');
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed.');
    state.result = result; render(result);
    notify(result.review?.exportable === false ? 'Draft needs test-transfer review. Patch download is blocked; inspect the listed issues.' : result.review ? 'Draft ready for review. No repository has been changed. Build and integration checks have not been run.' : 'Discovery complete. Enable a configured AI provider to request an adapted draft; this result is not a transfer.');
    $('results').focus({ preventScroll: true }); $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  } catch (e) { notify(e.name === 'AbortError' ? 'Cancelled. No repository was changed. An already-started provider request may still incur usage.' : e.message, e.name === 'AbortError' ? '' : 'error'); }
  finally { state.controller = null; busy(false); }
}
$('transfer-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    if ($('use-ai').checked && !$('consent').checked) throw new Error('Confirm code sharing before requesting AI adaptation.');
    run('/api/analyze', { source: selection('source'), destination: selection('destination'), feature: $('feature').value, useAI: $('use-ai').checked, consent: $('consent').checked });
  } catch (e) { notify(e.message, 'error'); }
});
$('try-demo').addEventListener('click', () => run('/api/demo', {}));
function render({ mode, analysis, review }) {
  $('results').hidden = false;
  $('result-mode').textContent = mode === 'synthetic-demo' ? 'AUTHORED SAMPLE · NO AI CALL' : mode === 'ai-draft' ? 'AI-GENERATED DRAFT · HUMAN REVIEW REQUIRED' : 'READ-ONLY REPOSITORY DISCOVERY';
  $('result-title').textContent = review ? 'Your feature, in a new context.' : 'Here’s what we found.';
  $('result-summary').textContent = review?.summary ?? (analysis.candidates.length ? `Found ${analysis.candidates.length} matching source files for “${analysis.feature}”. This is bounded text-based discovery, not a verified dependency closure.` : 'No direct feature matches in the inspected files. Try more specific terms, or select a smaller feature-focused folder.');
  $('snapshot-summary').replaceChildren();
  for (const [role, repo] of [['SOURCE', analysis.source], ['DESTINATION', analysis.destination]]) {
    const el = node('div', undefined, 'snapshot-card');
    el.append(node('strong', `${role} / ${repo.name}`), node('p', [...repo.stack.languages, ...repo.stack.frameworks].join(' · ') || 'Text project'),
      node('p', `${repo.coverage.inspected} files inspected · ${repo.coverage.knownPaths} known paths`),
      node('p', `Snapshot ${repo.fingerprint.slice(0, 12)}${repo.revision ? ' · commit ' + repo.revision.slice(0, 8) : ' · local selection'}`));
    $('snapshot-summary').append(el);
  }
  $('candidates').replaceChildren();
  if (!analysis.candidates.length) $('candidates').append(node('p', 'No direct matches in selected text.', 'plain-item'));
  for (const file of analysis.candidates) { const el = node('div', undefined, 'match'); el.append(node('code', file.path), node('p', `Matched: ${file.matched.join(', ')}`)); $('candidates').append(el); }
  $('checks').replaceChildren();
  for (const [label, value, pass] of [['Repository snapshots', 'INSPECTED', true], ['Draft structure', review ? 'CHECKED' : 'NO DRAFT', Boolean(review)], ['Destination build', 'NOT RUN', false], ['Behavior & integration', 'NOT RUN', false], ['Repository writes', 'NONE', true]]) {
    const el = node('div', undefined, 'check' + (pass ? ' pass' : '')); el.append(node('span', label), node('span', value)); $('checks').append(el);
  }
  $('context-details').replaceChildren();
  [...analysis.warnings, `Source context: ${analysis.contextManifest.source.join(', ')}`, `Destination context: ${analysis.contextManifest.destination.join(', ')}`,
    `Filtered server-side: ${[...analysis.source.skipped, ...analysis.destination.skipped].join(', ') || 'none among submitted files'}`].forEach(text => $('context-details').append(node('p', text)));
  const testReport = $('test-transfer'); testReport.replaceChildren();
  const plan = analysis.testPlan, transfer = review?.testTransfer;
  if (plan) {
    testReport.append(node('p', `${plan.tests.length} related test file(s) · ${plan.support.length} support file(s) · ${plan.source.frameworks.join(', ') || 'unknown runner'} → ${plan.destination.frameworks.join(', ') || 'unknown runner'}`));
    testReport.append(node('p', `Destination layout: ${plan.destination.layout ?? 'needs review'}. ${transfer?.status === 'blocked' ? 'PATCH BLOCKED' : transfer?.status === 'included' ? 'TESTS INCLUDED IN PATCH' : 'DISCOVERY ONLY'} · Tests have NOT RUN.`));
    for (const item of transfer?.placements ?? []) testReport.append(node('p', `${item.sourcePath} → ${item.destinationPath}`, 'plain-item'));
    if (!transfer) for (const item of plan.tests) testReport.append(node('p', `${item.path} · ${item.evidence}`, 'plain-item'));
    for (const message of [...(transfer?.blockers ?? []), ...plan.warnings]) testReport.append(node('p', message, 'plain-item'));
  }
  $('review-panel').hidden = !review; if (!review) return;
  $('change-count').textContent = `${review.changes.length} files · ${review.id.slice(0, 8)}`;
  $('change-list').replaceChildren();
  for (const change of review.changes) {
    const details = node('details', undefined, 'change'); details.open = review.changes.length <= 2;
    details.append(node('summary', `${change.action === 'add' ? '+' : '~'} ${change.path}`), node('p', change.reason, 'reason'), node('p', 'Source: ' + change.sourcePaths.join(', '), 'reason'));
    const pre = node('pre');
    const lines = text => text ? text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined) : [];
    for (const text of lines(change.before)) pre.append(node('span', '- ' + text, 'diff-line remove'));
    for (const text of lines(change.content)) pre.append(node('span', '+ ' + text, 'diff-line add'));
    details.append(pre); $('change-list').append(details);
  }
  $('risks').replaceChildren(...[review.notice, ...review.risks].map(t => node('p', t, 'plain-item')));
  $('suggested-checks').replaceChildren(...review.suggestedChecks.map(t => node('p', t, 'plain-item')));
}
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const a = node('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download-report').addEventListener('click', () => { if (state.result) download('graft-review.json', JSON.stringify(state.result, null, 2), 'application/json'); });
$('review-confirmation').addEventListener('change', () => { $('download-patch').disabled = !$('review-confirmation').checked || !state.result?.review?.exportable; });
$('download-patch').addEventListener('click', () => { if ($('review-confirmation').checked && state.result?.review?.exportable) download('graft.patch', state.result.review.patch, 'text/plain'); });
fetch('/api/config').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(config => {
  state.configured = config.aiConfigured; $('use-ai').disabled = !config.aiConfigured || Boolean(state.controller);
  $('model-label').textContent = config.aiConfigured ? 'AI available' : 'No API key needed to explore';
  $('ai-state').textContent = config.aiConfigured ? `Available · ${config.model}` : 'Optional · not configured';
}).catch(() => notify('Could not connect to the local Graft server.', 'error'));
