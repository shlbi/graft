/**
 * @file Executes the real GitHub read pipeline against synthetic network/auth/tar
 * boundaries and real Node streams/gzip. No remote repositories or credentials.
 * This tests stream cancellation/error propagation, not full tar parsing or PRs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gzipSync } from 'node:zlib';

const source = await readFile(new URL('../github.mjs', import.meta.url), 'utf8');
/** Test error shares the production Fault shape without importing unrelated engine code. */
class Fault extends Error { constructor(message, status) { super(message); this.status = status; } }

/** Compile unchanged production source with explicit non-network test dependencies. */
async function load(fetchImpl) {
  const context = vm.createContext({ URL, AbortSignal, Buffer, TextDecoder, Promise, fetch: fetchImpl });
  const module = new vm.SourceTextModule(source, { context });
  const deps = {
    'node:stream': { Readable, Transform }, 'node:stream/promises': { pipeline }, 'node:zlib': { createGunzip },
    // Deliberately a sink, not a simulated claim that the real tar parser was tested.
    'tar-stream': { default: { extract: () => new Writable({ write(chunk, encoding, done) { done(); } }) } },
    './auth.mjs': { getAuth() { assert.fail('No auth credentials may be used'); } },
    './db.mjs': { db() { assert.fail('No database may be queried'); } },
    '../web/lib/core-base.mjs': { snapshot: value => value, Fault, requireThat(value, message, status) { if (!value) throw new Fault(message, status); } },
    '../web/lib/policy.mjs': { eligiblePath: () => true, LIMITS: { files: 1500, fileBytes: 60000, snapshotBytes: 750000 }, looksSensitive: () => false }
  };
  await module.link(specifier => {
    assert.ok(Object.hasOwn(deps, specifier));
    return new vm.SyntheticModule(Object.keys(deps[specifier]), function () {
      for (const [key, value] of Object.entries(deps[specifier])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate(); return module.namespace;
}

/** Return read-only metadata before passing the archive call to a synthetic producer. */
function responses(archive, calls) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    if (url.endsWith('/sample/source')) return Response.json({ default_branch: 'main', private: true });
    if (url.endsWith('/commits/main')) return Response.json({ sha: 'a'.repeat(40) });
    return archive(options);
  };
}

test('an already cancelled repository read performs zero requests', async () => {
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  const github = await load(() => assert.fail('network called'));
  await assert.rejects(github.snapshotRepository('SYNTHETIC_TOKEN', 'sample/source', { signal: controller.signal }), /cancelled/);
});

test('parent cancellation reaches metadata/commit/archive and cancels its stream', async () => {
  const controller = new AbortController(), calls = [];
  let archiveReady, cancelled = false;
  const ready = new Promise(resolve => { archiveReady = resolve; });
  const github = await load(responses(async () => {
    archiveReady();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, calls));
  const pending = github.snapshotRepository('SYNTHETIC_TOKEN', 'sample/source', { signal: controller.signal });
  const checked = assert.rejects(pending, error => error.name === 'AbortError');
  await ready; controller.abort(); await checked;
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.options.signal.aborted));
  assert.equal(cancelled, true);
});

test('invalid gzip is rejected instead of emitting an unhandled stream error', async () => {
  const calls = [], github = await load(responses(async () => new Response('not a gzip archive'), calls));
  await assert.rejects(github.snapshotRepository('SYNTHETIC_TOKEN', 'sample/source'), error => error.code === 'Z_DATA_ERROR');
});

test('a source stream failure rejects the awaited snapshot', async () => {
  const github = await load(responses(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('synthetic stream failure')); }
  })), []));
  await assert.rejects(github.snapshotRepository('SYNTHETIC_TOKEN', 'sample/source'), /synthetic stream failure/);
});

test('the existing compressed-byte cap still rejects oversized archives', async () => {
  const github = await load(responses(async () => new Response(Buffer.alloc(20_000_001)), []));
  await assert.rejects(github.snapshotRepository('SYNTHETIC_TOKEN', 'sample/source'), /20 MB intake limit/);
});

test('a successful native stream pipeline preserves pinned revision and only reads', async () => {
  const calls = [], github = await load(responses(async () => new Response(gzipSync(Buffer.alloc(0))), calls));
  const result = await github.snapshotRepository('SYNTHETIC_TOKEN', 'sample/source');
  assert.equal(result.snapshot.revision, 'a'.repeat(40));
  assert.ok(calls[2].url.endsWith('/tarball/' + 'a'.repeat(40)));
  assert.ok(calls.every(call => call.options.method === 'GET'));
});
