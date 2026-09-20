import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createJobQueue } from '../demo/job-queue.mjs';
import { createUploadHttpServer } from '../demo/upload-server.mjs';
import { createReviewServer } from '../ui/server.mjs';
import { createCompiledTransplantFeature } from '../demo/http-transplant.mjs';
import { prepareDemoTransplant, uploadFeature, destinationInventory } from '../demo/graft-fixture.mjs';
import { prepareTransplant } from '../dist/transplant.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const upload = name => ({ name, content: 'hello', size: 5 });

test('queue reservations bound concurrent receiving bodies, not just accepted jobs', async () => {
  const queue = createJobQueue({ run: async () => ({ ok: true }), maxJobs: 1 });
  const ticket = queue.reserve();
  assert.equal(queue.stats().receivingJobs, 1);
  assert.throws(() => queue.reserve(), /full/u);
  ticket.release();
  assert.equal(queue.stats().receivingJobs, 0);
  const accepted = queue.reserve().submit(upload('one.txt'));
  assert.equal(accepted.state, 'queued');
  assert.throws(() => queue.reserve(), /full/u);
  await queue.close();
  assert.equal(queue.get(accepted.id).state, 'complete');
});

test('same-tick shutdown waits for all accepted work and maintains serial execution', async () => {
  const gate = deferred();
  const entered = deferred();
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const queue = createJobQueue({ maxJobs: 3, run: async name => {
    active++;
    maxActive = Math.max(active, maxActive);
    calls.push(name);
    entered.resolve();
    await gate.promise;
    active--;
    return { name };
  } });
  const jobs = ['one', 'two', 'three'].map(name => queue.reserve().submit(upload(name)));
  const closing = queue.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await entered.promise;
  assert.equal(closed, false);
  assert.equal(queue.get(jobs[0].id).state, 'running');
  assert.equal(queue.get(jobs[1].id).state, 'queued');
  assert.throws(() => queue.reserve(), /closing/u);
  gate.resolve();
  await Promise.all([closing, queue.close()]);
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.equal(maxActive, 1);
  assert.equal(queue.stats().activeJobs, 0);
  assert.equal(queue.stats().queuedJobs, 0);
  for (const job of jobs) assert.equal(queue.get(job.id).state, 'complete');
});

test('failed jobs do not strand later work; public results cannot mutate queue state', async () => {
  const queue = createJobQueue({ run: async name => {
    if (name === 'bad') throw new Error('fixture failure');
    return { values: [name] };
  } });
  const bad = queue.reserve().submit(upload('bad'));
  const good = queue.reserve().submit(upload('good'));
  await queue.close();
  assert.equal(queue.get(bad.id).state, 'failed');
  assert.equal(queue.get(bad.id).error, 'fixture failure');
  const output = queue.get(good.id);
  assert.equal('content' in output, false);
  output.result.values[0] = 'changed';
  assert.deepEqual(queue.get(good.id).result.values, ['good']);
});

test('shutdown revokes outstanding reservations rather than accepting post-close work', async () => {
  const queue = createJobQueue({ run: async () => ({}) });
  const ticket = queue.reserve();
  await queue.close();
  assert.throws(() => ticket.submit(upload('late')), /no longer valid/u);
  assert.equal(queue.stats().receivingJobs, 0);
});

function statusWithHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function slowPost(base) {
  const response = deferred();
  const request = httpRequest(`${base}/api/upload?name=slow.txt`, {
    method: 'POST', headers: { 'content-length': 2 },
  }, incoming => {
    const chunks = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => response.resolve({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
  });
  request.on('error', error => response.resolve({ error }));
  request.write('a');
  return { request, response: response.promise };
}

test('HTTP reservations reject a second upload while the first body is still arriving', async () => {
  const app = createUploadHttpServer({ maxJobs: 1, uploadAndProcess: async (name, content) => ({ name, content }) });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const first = slowPost(base);
  try {
    let receiving = false;
    for (let i = 0; i < 100; i++) {
      const stats = await (await fetch(`${base}/api/health`)).json();
      if (stats.receivingJobs === 1) { receiving = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(receiving, true);
    const second = await fetch(`${base}/api/upload?name=second.txt`, { method: 'POST', body: 'second' });
    assert.equal(second.status, 503);
    first.request.end('b');
    const accepted = await first.response;
    assert.equal(accepted.status, 202);
  } finally {
    first.request.destroy();
    await app.close();
  }
});

test('local upload boundary rejects foreign hosts/origins and invalid UTF-8 without accepting a job', async () => {
  const app = createUploadHttpServer({ uploadAndProcess: async () => ({ ok: true }) });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const headers of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal(await statusWithHeaders(`${base}/api/health`, headers), 403);
    }
    const invalid = await fetch(`${base}/api/upload?name=invalid.txt`, { method: 'POST', body: Buffer.from([0xff, 0xfe]) });
    assert.equal(invalid.status, 415);
    const stats = await (await fetch(`${base}/api/health`)).json();
    assert.equal(stats.receivingJobs, 0);
    assert.equal(stats.retainedJobs, 0);
    assert.equal((await fetch(`${base}/api/upload?name=empty.txt`, { method: 'POST', body: '' })).status, 400);
  } finally { await app.close(); }
  assert.throws(() => createUploadHttpServer({ host: '0.0.0.0', uploadAndProcess: async () => ({}) }), /loopback/u);
});

test('review API is not readable through a foreign Host or cross-origin browser request', async () => {
  const app = createReviewServer({ port: 0 });
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const headers of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }]) {
      assert.equal(await statusWithHeaders(`${base}/api/review`, headers), 403);
    }
    assert.equal((await fetch(`${base}/api/review`)).status, 200);
  } finally { await Promise.all([app.close(), app.close()]); }
  assert.throws(() => createReviewServer({ host: '0.0.0.0' }), /loopback/u);
});

test('compiled upload runtime uses the exact supplied reviewed snapshot, not a freshly loaded fixture', async () => {
  const original = await prepareDemoTransplant();
  const sourceSnapshots = original.sourceSnapshots.map(file => file.path.endsWith('/service.ts')
    ? { ...file, content: file.content.replace('name: stored.name', "name: 'reviewed-' + stored.name") } : file);
  const prepared = prepareTransplant(uploadFeature, destinationInventory, sourceSnapshots, original.destinationSnapshots);
  const runtime = await createCompiledTransplantFeature({ fixture: { ...original, sourceSnapshots, prepared } });
  try {
    const result = await runtime.uploadAndProcess('proof.txt', 'approved input');
    assert.equal(result.name, 'reviewed-proof.txt');
    assert.equal(result.fileId, 'blob-1');
  } finally { await runtime.close(); }
});
