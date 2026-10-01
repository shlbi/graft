/**
 * @file MCP production/local contract regression module that guards Repot authorization, storage, and publication invariants.
 *
 * Evidence invariant: only record checks that actually executed; never promote a skipped or simulated result to verified.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * @function read
 * Acceptance/test helper for read; preserves repeatable setup and explicit evidence boundaries.
 */
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('remote MCP is OAuth protected and only POST is served on MCP host', async () => {
  const route = await read('app/mcp/route.js');
  assert.match(route, /requireMcpAuth/);
  assert.ok(route.includes("requiredScopes:['repot:read','repot:write']"));
  assert.ok(route.includes("host==='mcp.getrepot.com'"));
  assert.match(route, /status:405/);
});

test('MCP tokens are not forwarded to GitHub', async () => {
  const route = await read('app/mcp/route.js');
  const github = await read('remote/github.mjs');
  assert.ok(route.includes('extra:{userId:'));
  assert.ok(github.includes('githubTokenForUser'));
  assert.doesNotMatch(github, /authInfo/);
});

test('publication creates a repot branch and draft PR, never merges default branch', async () => {
  const github = await read('remote/github.mjs');
  assert.ok(github.includes('repot/transfer-'));
  assert.match(github, /draft:true/);
  assert.doesNotMatch(github, /merge_method|force:true/);
  assert.match(github, /Destination default branch changed/);
});

test('reviews are encrypted and durable with ownership and expiry checks', async () => {
  const crypto = await read('remote/crypto.mjs');
  const reviews = await read('remote/reviews.mjs');
  assert.match(crypto, /aes-256-gcm/);
  assert.ok(reviews.includes('user_id=$2'));
  assert.match(reviews, /expires_at/);
  assert.match(reviews, /FOR UPDATE/);
});

test('AI draft requires explicit allowAI and server-side API key', async () => {
  const mcp = await read('remote/mcp.mjs');
  assert.ok(mcp.includes('allowAI:z.literal(true)'));
  assert.ok(mcp.includes("env('OPENAI_API_KEY')"));
  assert.ok(!mcp.includes('apiKey:z.'));
});

test('auth supports current CIMD plus DCR fallback', async () => {
  const auth = await read('remote/auth.mjs');
  assert.ok(auth.includes("metadataProfile:'mcp-2026-07-28'"));
  assert.ok(auth.includes('allowDynamicClientRegistration:true'));
  assert.ok(auth.includes('allowUnauthenticatedClientRegistration:true'));
  assert.ok(auth.includes('resource:resource()'));
});

test('build does not require production secrets at module initialization', async () => {
  const authRoute = await read('app/api/auth/[...all]/route.js');
  const mcpRoute = await read('app/mcp/route.js');
  assert.ok(authRoute.includes('handlers=()=>toNextJsHandler(getAuth())'));
  assert.match(mcpRoute, /export async function POST/);
});

test('public MCP page is one-link remote onboarding', async () => {
  const page = await read('web/connected/public/mcp/index.html');
  assert.ok(page.includes('https://mcp.getrepot.com/mcp'));
  assert.match(page, /Copy MCP URL/);
  assert.doesNotMatch(page, /git clone|npm install|--allow-root/);
});

test('production AI model is pinned to GPT-6.1 Sol rather than environment-selected Astra', async () => {
  const ai = await read('web/lib/ai.mjs');
  const mcp = await read('remote/mcp.mjs');
  assert.ok(ai.includes("REPOT_AI_MODEL = 'gpt-6.1-sol'"));
  assert.ok(ai.includes("REPOT_REASONING_EFFORT = 'medium'"));
  assert.ok(!mcp.includes("env('REPOT_AI_MODEL')"));
});
