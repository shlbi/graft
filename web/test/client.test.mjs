// DOM-stub tests of the actual shipped controller. Not a browser-rendering claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { eligiblePath, looksSensitive, LIMITS } from '../lib/policy.mjs';
import { demoRun, demoInput } from '../lib/demo.mjs';
import { snapshot, analyze } from '../lib/core.mjs';
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ''; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, fn) { (this.events[name] ??= []).push(fn); }
  dispatchEvent(event) { for (const fn of this.events[event.type] ?? []) fn(event); }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click', target: this }); }
  focus() {} scrollIntoView() {} remove() {}
}
async function settle(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setImmediate(r)); } assert.fail('Controller did not settle'); }
async function harness({ sample = demoRun } = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  for (const id of ['results', 'status', 'review-panel', 'cancel']) ids[id].hidden = true;
  for (const id of ['download-patch', 'use-ai']) ids[id].disabled = true;
  const downloads = [], requests = [], buttons = [];
  const source = (await readFile(new URL('../public/app.mjs', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
  const fetchImpl = async (url, options) => {
    if (url === '/api/config') return { ok: true, json: async () => ({ aiConfigured: false, model: null }) };
    if (url === '/api/demo') return { ok: true, json: async () => sample() };
    const body = JSON.parse(options.body); requests.push(body);
    const a = analyze(snapshot(body.source.snapshot), snapshot(body.destination.snapshot), body.feature);
    const { context, ...analysis } = a;
    return { ok: true, json: async () => ({ mode: 'discovery', analysis, review: null }) };
  };
  vm.runInNewContext(source, {
    eligiblePath, looksSensitive, LIMITS, AbortController, TextEncoder, TextDecoder, Blob,
    document: { getElementById: id => ids[id], createElement: tag => new Element(tag), querySelectorAll: () => buttons, body: new Element('body') },
    fetch: fetchImpl, matchMedia: () => ({ matches: true }), URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:sample'; }, revokeObjectURL() {} },
    setTimeout: () => {}, Event: class { constructor(type) { this.type = type; } }
  });
  await settle(() => ids['model-label'].textContent.includes('No API key'));
  return { ids, downloads, requests };
}
test('actual client renders the sample, gates patch download and exports matching bytes', async () => {
  const { ids, downloads } = await harness(); ids['try-demo'].click();
  await settle(() => !ids.results.hidden && !ids.analyze.disabled);
  assert.match(ids['result-mode'].textContent, /AUTHORED SAMPLE/); assert.equal(ids['change-list'].children.length, 5);
  assert.equal(ids['download-patch'].disabled, true);
  ids['review-confirmation'].checked = true; ids['review-confirmation'].dispatchEvent({ type: 'change' });
  assert.equal(ids['download-patch'].disabled, false); ids['download-patch'].click();
  assert.equal(await downloads[0].text(), demoRun().review.patch);
  ids['download-report'].click(); assert.equal(JSON.parse(await downloads[1].text()).review.id, demoRun().review.id);
});
test('editing the description clears previous results and revokes the UI download gate', async () => {
  const { ids } = await harness(); ids['try-demo'].click(); await settle(() => !ids.results.hidden);
  ids.feature.value = 'Another feature'; ids.feature.dispatchEvent({ type: 'input' });
  assert.equal(ids.results.hidden, true); assert.equal(ids['download-patch'].disabled, true); assert.equal(ids['review-confirmation'].checked, false);
});
test('folder intake filters excluded content before sending either project to the server', async () => {
  const { ids, requests } = await harness();
  for (const role of ['source', 'destination']) {
    const originals = [...demoInput[role].files, { path: '.env', content: 'EXAMPLE_NOT_REAL_SECRET=1' }, { path: 'node_modules/a.js', content: 'ignored' }];
    ids[role + '-folder'].files = originals.map(f => ({ webkitRelativePath: `${role}/${f.path}`, name: f.path.split('/').pop(), size: Buffer.byteLength(f.content), arrayBuffer: async () => new TextEncoder().encode(f.content).buffer }));
    ids[role + '-folder'].dispatchEvent({ type: 'change', target: ids[role + '-folder'] });
    await settle(() => ids[role + '-hint'].textContent.includes('text files') && !ids.analyze.disabled);
  }
  ids.feature.value = 'CSV export'; ids['transfer-form'].dispatchEvent({ type: 'submit', preventDefault() {} });
  await settle(() => requests.length === 1 && !ids.analyze.disabled);
  for (const role of ['source', 'destination']) assert.ok(requests[0][role].snapshot.files.every(f => f.path !== '.env' && !f.path.includes('node_modules')));
  assert.ok(!JSON.stringify(requests[0]).includes('EXAMPLE_NOT_REAL_SECRET')); assert.equal(ids['review-panel'].hidden, true);
});
test('client refuses unconsented AI before any analysis request', async () => {
  const { ids, requests } = await harness(); ids['use-ai'].checked = true; ids.consent.checked = false;
  ids['transfer-form'].dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.match(ids.status.textContent, /Confirm code sharing/); assert.equal(requests.length, 0);
});

// The real client must never export a partial feature-only patch through a blocked test gate.
test('blocked test transfer stays visible and cannot download a patch even after checking approval', async () => {
  const { ids, downloads } = await harness({ sample: () => {
    const r = demoRun(); r.review.exportable = false; r.review.patch = null;
    r.review.testTransfer.status = 'blocked'; r.review.testTransfer.blockers = ['Fixture collision: tests/fixtures/cells.json']; return r;
  } });
  ids['try-demo'].click(); await settle(() => !ids.results.hidden && !ids.analyze.disabled);
  assert.match(ids.status.textContent, /blocked/);
  assert.ok(ids['test-transfer'].children.some(c => c.textContent.includes('Fixture collision')));
  ids['review-confirmation'].checked = true; ids['review-confirmation'].dispatchEvent({ type: 'change' });
  assert.equal(ids['download-patch'].disabled, true);
  ids['download-patch'].dispatchEvent({ type: 'click' }); assert.equal(downloads.length, 0);
  ids['download-report'].click(); assert.equal(JSON.parse(await downloads[0].text()).review.patch, null);
});

test('client displays conversion and setup audit without implying runner verification', async () => {
  const { ids } = await harness({ sample: () => {
    const r = demoRun(); r.review.testTransfer.framework = {from:'jest',to:'vitest',conversion:true,runtimeVerification:'not_run'};
    r.review.testTransfer.adaptations = [{sourcePath:'test/csv.test.mjs',kind:'explicit-per-file-setup',sourceSetup:['test/setupTests.mjs']}]; return r;
  } });
  ids['try-demo'].click(); await settle(() => !ids.results.hidden && !ids.analyze.disabled);
  const rendered = ids['test-transfer'].children.map(c=>c.textContent).join('\n');
  assert.match(rendered, /jest → vitest/); assert.match(rendered, /NOT VERIFIED/); assert.match(rendered, /explicit-per-file-setup/); assert.match(rendered, /test\/setupTests.mjs/);
});
