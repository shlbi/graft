import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryName, readPublicRepository, boundedJSON } from '../lib/github.mjs';
import { proposeWithAI } from '../lib/ai.mjs';
import { snapshot, analyze } from '../lib/core.mjs';
import { demoInput, demoProposal } from '../lib/demo.mjs';
const json = body => new Response(JSON.stringify(body), { status: 200 });
const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40), blobSha = 'c'.repeat(40);
test('GitHub URL intake allowlists the exact host and owner/repo grammar', () => {
  assert.equal(repositoryName('https://github.com/owner/project.git'), 'owner/project');
  assert.equal(repositoryName('owner/project'), 'owner/project');
  for (const input of ['http://127.0.0.1/a/b', 'https://github.com.evil/a/b', 'https://github.com:444/a/b', 'https://a:b@github.com/a/b', 'https://github.com/a/b/tree/main', 'https://github.com/a/b?x=y', 'https://github.com/a/b#x', 'a/..', 'a/b/c']) assert.throws(() => repositoryName(input));
});
test('public intake pins commit/tree/blob and never fetches user-controlled hosts or download URLs', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/a/b')) return json({ private: false, default_branch: 'feature/main' });
    if (url.includes('/commits/')) return json({ sha, commit: { tree: { sha: treeSha } } });
    if (url.includes('/git/trees/')) return json({ truncated: false, tree: [{ type: 'blob', mode: '100644', path: 'csv.js', size: 10, sha: blobSha }, { type: 'blob', mode: '120000', path: 'link.js', size: 6, sha: blobSha }] });
    return json({ encoding: 'base64', size: 10, content: Buffer.from('exportCSV()').toString('base64') });
  };
  const repo = await readPublicRepository('a/b', 'CSV export', { fetchImpl });
  assert.equal(repo.revision, sha); assert.equal(repo.files.length, 1); assert.ok(repo.inventory.includes('link.js'));
  assert.ok(calls[1].url.endsWith('feature%2Fmain')); assert.ok(calls[2].url.includes(treeSha)); assert.ok(calls[3].url.includes(blobSha));
  assert.ok(calls.every(c => c.url.startsWith('https://api.github.com/repos/a/b') && c.opts.redirect === 'error' && !c.opts.headers.authorization));
});
test('truncated repository tree and private repos fail closed', async () => {
  await assert.rejects(readPublicRepository('a/b', 'csv', { fetchImpl: async () => json({ private: true }) }), /public/);
  let count = 0;
  await assert.rejects(readPublicRepository('a/b', 'csv', { fetchImpl: async () => json(++count === 1 ? { private: false, default_branch: 'main' } : count === 2 ? { sha, commit: { tree: { sha: treeSha } } } : { truncated: true, tree: [] }) }), /truncated/);
});
test('upstream error response never leaks body contents', async () => {
  await assert.rejects(readPublicRepository('a/b', 'csv', { fetchImpl: async () => new Response('sensitive debug body', { status: 403 }) }), e => /rate limit/.test(e.message) && !e.message.includes('sensitive'));
});
test('upstream response byte limit is enforced', async () => { await assert.rejects(boundedJSON(json({ data: 'x'.repeat(200) }), 20), /size limit/); });
function aiOptions() {
  const source = snapshot(demoInput.source), destination = snapshot(demoInput.destination);
  return { source, destination, context: analyze(source, destination, 'CSV export').context, consent: true, apiKey: 'test-placeholder', model: 'test-model' };
}
test('AI call requires explicit consent and configuration before any network request', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return json({}); };
  await assert.rejects(proposeWithAI({ ...aiOptions(), consent: false, fetchImpl }), /consent/);
  await assert.rejects(proposeWithAI({ ...aiOptions(), apiKey: '', fetchImpl }), /Configure/);
  assert.equal(calls, 0);
});
test('AI adapter submits bounded structured output, no tools, store false and validates response locally', async () => {
  let payload;
  const review = await proposeWithAI({ ...aiOptions(), fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.redirect, 'error'); payload = JSON.parse(options.body);
    return json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(demoProposal) }] }], usage: { input_tokens: 100, output_tokens: 50 } });
  } });
  assert.equal(payload.store, false); assert.equal(payload.max_output_tokens, 12000); assert.equal(payload.text.format.strict, true); assert.equal(payload.tools, undefined);
  assert.match(payload.instructions, /untrusted data/); assert.equal(review.verification.tests, 'not_run'); assert.equal(review.usage.inputTokens, 100);
});
test('AI incomplete, refusal, malformed JSON and empty proposals stop without applying', async () => {
  for (const body of [
    { status: 'incomplete' }, { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{nope' }] }] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...demoProposal, changes: [] }) }] }] }
  ]) await assert.rejects(proposeWithAI({ ...aiOptions(), fetchImpl: async () => json(body) }));
});
