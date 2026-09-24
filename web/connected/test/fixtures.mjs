import { createHash } from 'node:crypto';
import { readConfig } from '../security.mjs';
import { GitHubClient } from '../github.mjs';
import { snapshot, analyze, reviewProposal } from '../../lib/core-base.mjs';
export function config(extra = {}) {
  return readConfig({ GRAFT_ENV: 'development', GRAFT_PUBLIC_URL: 'http://127.0.0.1:4319', GRAFT_ALLOWED_USER_IDS: '1,2',
    GRAFT_GITHUB_CLIENT_ID: 'test-client', GRAFT_GITHUB_CLIENT_SECRET: 'not-a-secret-test-client-only', GRAFT_GITHUB_APP_ID: '99',
    GRAFT_DATA_KEY: '11'.repeat(32), GRAFT_WEBHOOK_SECRET: 'test-webhook-secret-for-unit-tests-only',
    GRAFT_ENABLE_PR_WRITES: 'true', OPENAI_API_KEY: 'unit-test-only', GRAFT_AI_MODEL: 'unit-test', ...extra });
}
export const gitBlob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
export const sourceFiles = [{ path: 'src/greeting.js', content: "export const greeting = name => 'Hello ' + name;\n" }];
export const destinationFiles = [{ path: 'src/count.js', content: 'export const count = rows => rows.length;\n' }];
export const ids = { base: 'a'.repeat(40), tree: 'b'.repeat(40), newTree: 'c'.repeat(40), newCommit: 'd'.repeat(40) };
/** A controlled provider boundary for auth/delivery tests. Not evidence of live AI or cross-runner execution. */
export async function fixtureDraft(s, d, feature) {
  const analysis = analyze(s, d, feature);
  const review = reviewProposal({ summary: 'Authored gateway acceptance fixture', changes: [{ path: 'src/greeting.js', action: 'add', content: sourceFiles[0].content, reason: 'Authored test-only transfer', sourcePaths: ['src/greeting.js'] }], risks: [], suggestedChecks: [] }, s, d, analysis.context, 'authored-gateway-test');
  return { analysis, review: { ...review, exportable: true, testTransfer: { status: 'none_found', placements: [], blockers: [] } } };
}
export function fakeGitHub(cfg) {
  const calls = [], branches = new Map(), prs = [], tokens = new Map([['ghu_alice', { id: 1, login: 'alice' }], ['ghu_bob', { id: 2, login: 'bob' }]]);
  const metadata = (id, name) => ({ id, full_name: name, private: true, archived: false, default_branch: 'main', permissions: { push: true } });
  const source = metadata(10, 'demo/source'), destination = metadata(20, 'demo/destination');
  const blobs = new Map([...sourceFiles, ...destinationFiles].map(f => [gitBlob(f.content), f.content]));
  const state = { calls, branches, prs, head: ids.base, deny: false, losePRResponse: false, loseBranchResponse: false, user: { id: 1, login: 'alice' }, countRepos: 0 };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const fetchImpl = async (url, options) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : undefined, method = options.method || 'GET';
    calls.push({ path: u.pathname + u.search, method, body, options });
    if (u.pathname === '/login/oauth/access_token') return json({ access_token: state.user.id === 1 ? 'ghu_alice' : 'ghu_bob', token_type: 'bearer', expires_in: 28800, refresh_token: 'NEVER_STORE_THIS' });
    if (state.deny) return json({ message: 'denied' }, 401);
    if (u.pathname === '/user') return json(tokens.get(options.headers.authorization?.slice(7)) || state.user);
    if (u.pathname === '/user/installations') return json({ total_count: 1, installations: [{ id: 7, app_id: 99, suspended_at: null }] });
    if (u.pathname === '/user/installations/7/repositories') { state.countRepos++; return json({ total_count: 2, repositories: [source, destination] }); }
    const match = u.pathname.match(/^\/repos\/demo\/(source|destination)(.*)$/);
    if (!match) return json({}, 404);
    const [, which, suffix] = match;
    if (!suffix) return json(which === 'source' ? source : destination);
    if (suffix === '/commits/main') return json({ sha: ids.base, commit: { tree: { sha: ids.tree } } });
    if (suffix === `/git/trees/${ids.tree}`) return json({ truncated: false, tree: (which === 'source' ? sourceFiles : destinationFiles).map(f => ({ path: f.path, mode: '100644', type: 'blob', size: Buffer.byteLength(f.content), sha: gitBlob(f.content) })) });
    if (suffix.startsWith('/git/blobs/')) { const text = blobs.get(suffix.split('/').at(-1)); return json({ encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') }); }
    if (suffix === '/git/ref/heads/main') return json({ object: { sha: state.head } });
    if (suffix.startsWith('/git/ref/heads/')) { const branch = decodeURIComponent(suffix.slice('/git/ref/heads/'.length)); return branches.has(branch) ? json({ object: { sha: branches.get(branch) } }) : json({}, 404); }
    if (suffix === '/git/trees' && method === 'POST') return json({ sha: ids.newTree });
    if (suffix === '/git/commits' && method === 'POST') return json({ sha: ids.newCommit });
    if (suffix === '/git/refs' && method === 'POST') {
      const b = body.ref.slice('refs/heads/'.length); if (branches.has(b)) return json({}, 422); branches.set(b, body.sha);
      if (state.loseBranchResponse) { state.loseBranchResponse = false; throw new Error('Connection lost after branch creation'); }
      return json({ ref: body.ref, object: { sha: body.sha } });
    }
    if (suffix === '/pulls' && method === 'GET') return json(prs);
    if (suffix === '/pulls' && method === 'POST') {
      const pr = { number: 1, html_url: 'https://github.com/demo/destination/pull/1', head: { ref: body.head, sha: ids.newCommit }, base: { ref: body.base }, draft: true, state: 'open' }; prs.push(pr);
      if (state.losePRResponse) { state.losePRResponse = false; throw new Error('Connection lost after PR creation'); } return json(pr);
    }
    return json({}, 404);
  };
  return { ...state, state, client: new GitHubClient(cfg, { fetchImpl }), fetchImpl };
}
