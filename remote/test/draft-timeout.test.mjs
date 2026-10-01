/**
 * @file Executable timing/cancellation regression tests for the real MCP draft
 * handler, AI adapter and request lifecycle. SDK, auth, DB, GitHub and AI are
 * synthetic boundaries; virtual time does not claim a live Vercel/client pass.
 * Run: node --experimental-vm-modules --test remote/test/draft-timeout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createDraftExecution, DRAFT_REQUEST_TIMEOUT_MS, DRAFT_AI_TIMEOUT_MS } from '../draft-execution.mjs';

const root = new URL('../../', import.meta.url);
const args = { sourceRepo: 'sample/source', destinationRepo: 'sample/destination', feature: 'Pomodoro timer', allowAI: true };
const proposal = { summary: 'Timer transfer', changes: [{ path: 'timer.js', action: 'add', content: 'export const duration = 1500;', sourcePaths: ['timer.js'], reason: 'Timer' }], risks: [], suggestedChecks: ['Run destination tests'] };

/** Test-only Fault matches the unchanged production error contract. */
class Fault extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Flush async stages without sleeping or running an indefinite worker. */
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

/** Load exact production source with a closed import map; no real credentials or services. */
async function load(file, dependencies, globals = {}) {
  const context = vm.createContext({
    URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal, DOMException,
    Date, Buffer, TextDecoder, ReadableStream, setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a), setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a), ...globals
  });
  const source = await readFile(new URL(file, root), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: file });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency: ${specifier}`);
    const exports = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

/** Keep timing tests focused: real adapter logic, synthetic deterministic review engine. */
async function loadAI(fetchImpl, overrides = {}) {
  return load('web/lib/ai.mjs', {
    './core.mjs': {
      Fault,
      requireThat(value, message, status) { if (!value) throw new Fault(message, status); },
      reviewProposal(value) { return { ...value, exportable: true, patch: 'synthetic patch', testTransfer: { status: 'included' }, verification: { tests: 'not_run', build: 'not_run', integration: 'not_run' } }; },
      ...overrides
    },
    './github.mjs': { boundedJSON: response => response.json() }
  }, { fetch: fetchImpl });
}

/** Schedule a cancellable synthetic OpenAI response; save only fake request data. */
function delayedProvider(delay, calls, body = { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }) {
  return (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(Response.json(body)); }, delay);
    const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  });
}

/** Minimal arguments for the real AI adapter; nothing here is a live token or repo. */
function aiInput() {
  return { source: { name: 'source' }, destination: { name: 'destination', inventory: [] },
    context: { feature: 'timer', source: [], destination: [], testPlan: {} }, consent: true, apiKey: 'SYNTHETIC_API_KEY' };
}

/** Register the actual MCP tool callbacks while replacing infrastructure, not business code. */
async function mcpFixture(fetchImpl, overrides = {}, requestSignal) {
  const events = [], requests = [];
  const ai = await loadAI(fetchImpl);
  const shape = new Proxy({}, { get: () => () => shape });
  class McpServer {
    constructor() { this.tools = new Map(); }
    registerTool(name, config, callback) { this.tools.set(name, { config, callback }); }
    registerResource() {}
  }
  const github = {
    async githubTokenForUser(uid) { events.push('github_access'); assert.equal(uid, 'test-user'); return 'SYNTHETIC_GITHUB_TOKEN'; },
    async snapshotRepository(token, name, options) {
      events.push('read'); requests.push(options);
      assert.equal(token, 'SYNTHETIC_GITHUB_TOKEN');
      return { meta: { name }, snapshot: { name, revision: 'a'.repeat(40), inventory: [] } };
    },
    listRepositories() { throw new Error('Unexpected list'); },
    publishDraft() { assert.fail('Draft must never publish'); }, ...overrides.github
  };
  const reviews = {
    async incrementUsage(uid, kind) { events.push('quota'); assert.equal(kind, 'drafts'); },
    async cleanupExpired() { events.push('cleanup'); },
    async saveReview(value) { events.push('save'); assert.equal(value.userId, 'test-user'); return { id: 'synthetic-review-123456789', expiresAt: '2099-01-01T00:00:00Z' }; },
    getReview() { throw new Error('Unexpected get review'); },
    publishStoredReview() { assert.fail('Draft must never publish'); }, ...overrides.reviews
  };
  const module = await load('remote/mcp.mjs', {
    '@modelcontextprotocol/server': { McpServer, createMcpHandler: factory => ({ factory }) },
    'zod/v4': { object: () => shape, string: () => shape, literal: () => shape },
    '../web/lib/core.mjs': { analyze: () => ({ context: aiInput().context }) },
    '../web/lib/ai.mjs': { proposeWithAI: ai.proposeWithAI, REPOT_AI_MODEL: ai.REPOT_AI_MODEL },
    '../web/lib/core-base.mjs': { Fault },
    './github.mjs': github,
    './reviews.mjs': reviews,
    './env.mjs': { env: name => { assert.equal(name, 'OPENAI_API_KEY'); return 'SYNTHETIC_API_KEY'; } },
    './draft-execution.mjs': { createDraftExecution, DRAFT_AI_TIMEOUT_MS }
  });
  const server = module.mcpHandler.factory({ authInfo: { extra: { userId: 'test-user' } }, requestInfo: { signal: requestSignal } });
  return { draft: server.tools.get('repot_draft').callback, events, requests };
}

/** Parse tool output without changing success/error semantics. */
const output = result => JSON.parse(result.content[0].text);

test('host budget > complete draft > AI budget; no floating or paid-plan-only duration', async () => {
  const route = await readFile(new URL('app/mcp/route.js', root), 'utf8');
  const duration = Number(route.match(/export const maxDuration\s*=\s*(\d+)/)?.[1]);
  assert.equal(duration, 300);
  assert.ok(duration * 1000 > DRAFT_REQUEST_TIMEOUT_MS);
  assert.ok(DRAFT_REQUEST_TIMEOUT_MS > DRAFT_AI_TIMEOUT_MS);
  assert.equal(DRAFT_AI_TIMEOUT_MS, 180000);
});

for (const delay of [61_200, 95_000, 150_000]) {
  test(`a ${delay / 1000}s provider result reaches a saved review instead of the old cutoff`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const calls = [], progress = [];
    const fixture = await mcpFixture(delayedProvider(delay, calls));
    const running = fixture.draft(args, { mcpReq: { _meta: { progressToken: 0 }, notify: async event => progress.push(event) } });
    await flush(); assert.equal(calls.length, 1);
    assert.equal(fixture.events.includes('save'), false);
    t.mock.timers.tick(delay); await flush();
    const result = await running, data = output(result);
    assert.equal(result.isError, undefined); assert.equal(data.reviewId, 'synthetic-review-123456789');
    assert.equal(data.model, 'gpt-6.1-sol'); assert.equal(data.verification.tests, 'not_run');
    assert.equal(fixture.events.filter(x => x === 'save').length, 1);
    assert.equal(fixture.events.filter(x => x === 'quota').length, 1);
    assert.equal(calls[0].payload.model, 'gpt-6.1-sol'); assert.equal(calls[0].payload.reasoning.effort, 'medium');
    assert.equal(calls[0].payload.store, false); assert.equal(calls[0].payload.background, undefined);
    assert.equal(calls[0].payload.max_output_tokens, 12000); assert.equal(calls[0].payload.text.format.strict, true);
    assert.equal(calls[0].payload.tools, undefined);
    assert.ok(fixture.requests.every(options => options.signal instanceof AbortSignal));
    assert.ok(progress.length >= 2);
    assert.ok(progress.every((event, i) => event.params.progressToken === 0 && event.params.progress === i + 1 && event.params.total === undefined));
    assert.ok(!JSON.stringify(progress).includes('SYNTHETIC_'));
    const count = progress.length; t.mock.timers.tick(600000); await flush(); assert.equal(progress.length, count);
  });
}

test('AI cutoff returns ai_timeout with no save, retry or repository publication', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const calls = [], fixture = await mcpFixture(delayedProvider(999999, calls));
  const running = fixture.draft(args); await flush(); t.mock.timers.tick(180000); await flush();
  const result = await running, data = output(result);
  assert.equal(result.isError, true); assert.equal(data.error.code, 'ai_timeout'); assert.equal(data.error.stage, 'generating');
  assert.equal(data.retryAutomatically, false); assert.equal(calls.length, 1); assert.equal(fixture.events.includes('save'), false);
  assert.equal(calls[0].options.signal.aborted, true);
});

test('whole-draft cutoff stops a stalled stage and prevents late AI or review creation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let finishRead;
  const calls = [], fixture = await mcpFixture(delayedProvider(1, calls), {
    github: { snapshotRepository: () => new Promise(resolve => { finishRead = resolve; }) }
  });
  const running = fixture.draft(args); await flush(); t.mock.timers.tick(240000); await flush();
  const data = output(await running); assert.equal(data.error.code, 'draft_timeout'); assert.equal(data.error.stage, 'reading');
  finishRead({ meta: {}, snapshot: {} }); await flush();
  assert.equal(calls.length, 0); assert.equal(fixture.events.includes('quota'), false); assert.equal(fixture.events.includes('save'), false);
});

for (const source of ['SDK', 'HTTP']) {
  test(`${source} cancellation reaches the AI connection without leaking its reason`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const controller = new AbortController(), calls = [];
    const fixture = await mcpFixture(delayedProvider(999999, calls), {}, source === 'HTTP' ? controller.signal : undefined);
    const running = fixture.draft(args, source === 'SDK' ? { mcpReq: { signal: controller.signal } } : undefined);
    await flush(); controller.abort(new Error('PRIVATE_CLIENT_ABORT_REASON')); await flush();
    const result = await running, data = output(result);
    assert.equal(data.error.code, 'draft_cancelled'); assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(fixture.events.includes('save'), false); assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  });
}

test('already cancelled requests never call GitHub, AI, quota or save', async () => {
  const controller = new AbortController(); controller.abort('PRIVATE_REASON');
  const fixture = await mcpFixture(() => assert.fail('AI called'), {}, controller.signal);
  const result = await fixture.draft(args);
  assert.equal(output(result).error.code, 'draft_cancelled'); assert.deepEqual(fixture.events, []);
});

for (const invalid of [{ ...args, allowAI: false }, { ...args, destinationRepo: args.sourceRepo }]) {
  test('invalid or unconsented inputs fail before charging a draft or calling a provider', async () => {
    const fixture = await mcpFixture(() => assert.fail('AI called'));
    const result = await fixture.draft(invalid);
    assert.equal(result.isError, true); assert.deepEqual(fixture.events, []);
  });
}

test('provider failure does not cause an automatic retry or expose its body', async () => {
  let calls = 0;
  const fixture = await mcpFixture(async () => { calls++; return new Response('PRIVATE_PROVIDER_DETAIL', { status: 500 }); });
  const result = await fixture.draft(args);
  assert.equal(result.isError, true); assert.equal(calls, 1); assert.equal(fixture.events.includes('save'), false);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('unexpected database errors are not reflected in the MCP result', async () => {
  const fixture = await mcpFixture(() => assert.fail('AI called'), { github: { githubTokenForUser: async () => { throw new Error('postgresql://PRIVATE_PASSWORD@host'); } } });
  const result = await fixture.draft(args);
  assert.equal(result.isError, true); assert.equal(output(result).error.stage, 'github_access');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

test('failure while saving never reports a review ID or a successful draft', async () => {
  const fixture = await mcpFixture(async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }), {
    reviews: { saveReview: async () => { throw new Error('PRIVATE_DB_EXCEPTION'); } }
  });
  const result = await fixture.draft(args), data = output(result);
  assert.equal(result.isError, true); assert.equal(data.error.stage, 'saving'); assert.equal(data.reviewId, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});

for (const behavior of ['rejects', 'never-resolves']) {
  test(`optional progress that ${behavior} does not stall successful drafting`, async () => {
    const fixture = await mcpFixture(async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }));
    const result = await fixture.draft(args, { mcpReq: { _meta: { progressToken: 'test' }, notify: () => behavior === 'rejects' ? Promise.reject(new Error('progress unavailable')) : new Promise(() => {}) } });
    assert.equal(result.isError, undefined); assert.equal(output(result).reviewId, 'synthetic-review-123456789');
  });
}

test('legacy AI callers retain their 90-second cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], ai = await loadAI(delayedProvider(95000, calls));
  const running = ai.proposeWithAI(aiInput()); const checked = assert.rejects(running, error => error.code === 'ai_timeout');
  await flush(); t.mock.timers.tick(90000); await checked;
});

test('AI timeout remains active while the response body is still arriving', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ai = await loadAI(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
  } }), { headers: { 'content-type': 'application/json' } }));
  const running = ai.proposeWithAI({ ...aiInput(), timeoutMs: 180000 });
  const checked = assert.rejects(running, error => error.code === 'ai_timeout');
  await flush(); t.mock.timers.tick(180000); await checked;
});

for (const body of [{ status: 'incomplete' }, { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }, { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'not-json' }] }] }]) {
  test('incomplete/refused/malformed AI output still blocks review creation', async () => {
    const fixture = await mcpFixture(async () => Response.json(body));
    const result = await fixture.draft(args);
    assert.equal(result.isError, true); assert.equal(fixture.events.includes('save'), false);
  });
}

test('a new execution is isolated from a cancelled previous request', async () => {
  const controller = new AbortController();
  const first = createDraftExecution({ mcpReq: { signal: controller.signal } });
  controller.abort('test');
  const second = createDraftExecution();
  try {
    await assert.rejects(first.run('generating', () => assert.fail('cancelled work ran')));
    assert.equal(await second.run('generating', () => 42), 42);
  } finally { first.dispose(); second.dispose(); }
});
