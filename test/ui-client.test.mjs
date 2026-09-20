import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Focused DOM-stub controller tests. These are not live browser integration tests.
const source = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
function harness() {
  function element() {
    return { children: [], handlers: {}, textContent: '', className: '', hidden: false, disabled: false,
      value: '', files: [], append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(type, callback) { this.handlers[type] = callback; },
      click() { this.clicked = true; },
    };
  }
  const ids = ['statusPill','metrics','graph','mappings','changes','diff','limitations','blockers',
    'approveButton','exportButton','refreshButton','resultPanel','uploadPanel','result',
    'approvalCopy','uploadInput','uploadResult','uploadButton','sampleButton','fileLabel'];
  const nodes = new Map(ids.map(id => [`#${id}`, element()]));
  let downloaded;
  const context = vm.createContext({
    document: { querySelector: selector => { assert.ok(nodes.has(selector), selector); return nodes.get(selector); }, createElement: element },
    Blob, File, Date, console,
    URL: { createObjectURL(blob) { downloaded = blob; return 'blob:test'; }, revokeObjectURL() {} },
    AbortSignal: { timeout: () => undefined },
    fetch: () => new Promise(() => {}), // Intentionally no network or mocked success.
    setTimeout: () => 0,
  });
  vm.runInContext(source, context, { timeout: 1000 });
  return { nodes, run: code => vm.runInContext(code, context, { timeout: 1000 }), downloaded: () => downloaded };
}

test('client hides proof and upload and disables approval while a fresh review is loading', () => {
  const ui = harness();
  assert.equal(ui.nodes.get('#resultPanel').hidden, true);
  assert.equal(ui.nodes.get('#uploadPanel').hidden, true);
  assert.equal(ui.nodes.get('#approveButton').disabled, true);
  assert.equal(ui.nodes.get('#uploadInput').disabled, true);
  assert.equal(ui.nodes.get('#exportButton').disabled, true);
});

test('client controls reject expired runtimes, in-flight work, empty files and oversized files', () => {
  const ui = harness();
  ui.run("Object.assign(state,{busy:false,token:'test',expires:Date.now()+60000,maxBytes:10,file:new File(['hello'],'a.txt')}); syncControls();");
  assert.equal(ui.nodes.get('#uploadButton').disabled, false);
  ui.run('state.busy=true; syncControls();');
  assert.equal(ui.nodes.get('#sampleButton').disabled, true);
  assert.equal(ui.nodes.get('#refreshButton').disabled, true);
  ui.run('state.busy=false; state.expires=0; syncControls();');
  assert.equal(ui.nodes.get('#uploadButton').disabled, true);
  ui.run("state.expires=Date.now()+60000; selectFile(new File([],'empty.txt'));");
  assert.equal(ui.nodes.get('#uploadButton').disabled, true);
  ui.run("selectFile(new File(['x'.repeat(11)],'big.txt'));");
  assert.equal(ui.nodes.get('#uploadButton').disabled, true);
  ui.run("selectFile(new File(['valid'],'ok.txt'));");
  assert.equal(ui.nodes.get('#uploadButton').disabled, false);
});

test('review download contains only the read-only review, never session authorization', async () => {
  const ui = harness();
  ui.run("state.review={schemaVersion:1,feature:'example',ready:true}; state.reviewId='private-session'; state.token='private-upload-token';");
  ui.nodes.get('#exportButton').handlers.click();
  const text = await ui.downloaded().text();
  assert.deepEqual(JSON.parse(text), { schemaVersion: 1, feature: 'example', ready: true });
  assert.equal(text.includes('private-'), false);
});

test('file names are assigned as text rather than injected HTML', () => {
  const ui = harness();
  ui.run("state.busy=false; state.maxBytes=100; selectFile(new File(['x'],'<img src=x onerror=alert(1)>.txt'));");
  assert.match(ui.nodes.get('#fileLabel').textContent, /^<img src=x/u);
  assert.equal('innerHTML' in ui.nodes.get('#fileLabel'), false);
});
