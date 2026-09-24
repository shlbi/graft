// Execute the actual browser controller against explicit DOM/HTTP doubles. Not a browser E2E claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ''; }
  append(...n) { this.children.push(...n); } replaceChildren(...n) { this.children = n; }
  addEventListener(type, cb) { (this.events[type] ||= []).push(cb); }
  dispatchEvent(e) { for (const cb of this.events[e.type] || []) cb(e); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
  focus() {} remove() {}
  set innerHTML(_) { throw new Error('Never render untrusted repository text as HTML'); }
}
async function settle(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setImmediate(r)); } assert.fail('Controller did not settle'); }
async function harness({ signedIn = true, writes = true, ai = true } = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), code = await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const calls = [], downloads = [], created = [];
  const job = { id: 'a'.repeat(43), state: 'review_ready', feature: 'CSV <script>evil</script>', digest: 'abc', message: 'Draft ready',
    review: { exportable: true, patch: 'authored patch', changes: [{ action: 'add', path: 'src/csv.js', content: '<img src=x onerror=evil()>', reason: 'Test fixture', before: null }], testTransfer: { placements: [], blockers: [] }, risks: [] } };
  vm.runInNewContext(code, { document: { getElementById: x => ids[x], createElement: tag => { const n = new Element(tag); created.push(n); return n; }, body: new Element('body') },
    URL: { createObjectURL: b => { downloads.push(b); return 'blob:test'; }, revokeObjectURL() {} }, Blob, clearTimeout() {}, setTimeout() { return 1; }, confirm: () => true,
    fetch: async (path, opts) => { calls.push({ path, opts }); let data, status = 200;
      if (path === '/api/session') { status = signedIn ? 200 : 401; data = signedIn ? { user: { id: 1, login: 'alice' }, csrf: 'test-csrf', writesEnabled: writes, aiConfigured: ai, userDailyDraftLimit: 3 } : { error: 'Sign in' }; }
      else if (path === '/api/repos') data = { repositories: [{ id: 10, name: 'demo/source', writable: false }, { id: 20, name: 'demo/destination', writable: true, private: true }] };
      else if (path === '/api/jobs' && opts.method === 'GET') data = { jobs: [job] };
      else if (path === '/api/jobs') data = job;
      else if (path.endsWith('/publish')) { job.delivery = { url: 'https://github.com/demo/destination/pull/1' }; job.state = 'delivered'; data = job.delivery; }
      else if (path.startsWith('/api/jobs/')) data = job;
      else data = { signedOut: true, note: 'GitHub data stays.' };
      return { ok: status < 400, status, json: async () => structuredClone(data) };
    } });
  await settle(() => signedIn ? ids.jobs.children.length : ids.account.children.length);
  return { ids, calls, job, created, downloads };
}
test('connected UI signs out cleanly on unauthenticated bootstrap', async () => {
  const h = await harness({ signedIn: false }); assert.equal(h.ids.workspace.hidden, true); assert.equal(h.ids.welcome.hidden, false); assert.equal(h.calls.length, 1);
});
test('repository selection disables read-only destinations; drafts require provider configuration', async () => {
  const h = await harness({ ai: false }); assert.equal(h.ids.destination.children[0].disabled, true); assert.equal(h.ids.destination.children[1].disabled, false); assert.equal(h.ids['create-draft'].disabled, true);
});
test('controller requires both acknowledgements before publication and attaches CSRF and review digest', async () => {
  const h = await harness(); h.ids.jobs.children[0].click(); await settle(() => h.ids['review-title'].textContent === h.job.feature);
  assert.equal(h.ids.publish.disabled, true); h.ids.acknowledge.checked = true; h.ids.acknowledge.dispatchEvent({ type: 'change' }); assert.equal(h.ids.publish.disabled, true);
  h.ids.workflows.checked = true; h.ids.workflows.dispatchEvent({ type: 'change' }); assert.equal(h.ids.publish.disabled, false);
  h.ids.publish.click(); await settle(() => h.calls.some(c => c.path.endsWith('/publish')));
  const p = h.calls.find(c => c.path.endsWith('/publish')); assert.equal(p.opts.headers['x-csrf-token'], 'test-csrf'); assert.deepEqual(JSON.parse(p.opts.body), { digest: 'abc', acknowledgeUnverified: true, acknowledgeWorkflows: true });
});
test('review renders code as text and downloads exact stored patch bytes', async () => {
  const h = await harness(); h.ids.jobs.children[0].click(); await settle(() => h.ids['review-title'].textContent === h.job.feature);
  assert.ok(h.created.some(n => n.tagName === 'pre' && n.textContent === '<img src=x onerror=evil()>'));
  assert.ok(!h.created.some(n => n.tagName === 'script' || n.tagName === 'img'));
  h.ids.download.click(); assert.equal(await h.downloads[0].text(), 'authored patch');
});
test('operator write switch stays visible and disabled even after both acknowledgement checkboxes', async () => {
  const h = await harness({ writes: false }); h.ids.jobs.children[0].click(); await settle(() => h.ids['review-title'].textContent === h.job.feature);
  h.ids.acknowledge.checked = true; h.ids.workflows.checked = true; h.ids.workflows.dispatchEvent({ type: 'change' }); assert.equal(h.ids.publish.disabled, true); h.ids.publish.click(); assert.ok(!h.calls.some(c => c.path.endsWith('/publish')));
});
