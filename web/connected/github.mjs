import { createHash } from 'node:crypto';
import { ensure, HttpError } from './security.mjs';
import { snapshot } from '../lib/core-base.mjs';
import { eligiblePath, LIMITS } from '../lib/policy.mjs';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const nameOK = name => typeof name === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(name) && !name.split('/').some(p => p === '.' || p === '..');
export async function boundedResponse(response, limit = 2_000_000) {
  const chunks = []; let size = 0;
  for await (const b of response.body) { size += b.length; ensure(size <= limit, 502, 'upstream_size', 'GitHub response exceeded the size limit.'); chunks.push(b); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(502, 'upstream_json', 'GitHub returned an invalid response.'); }
}
export class GitHubClient {
  constructor(config, { fetchImpl = fetch } = {}) { this.config = config; this.fetch = fetchImpl; }
  async exchange(code, verifier, signal) {
    const r = await this.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code,
        redirect_uri: this.config.origin + '/auth/callback', code_verifier: verifier })
    });
    ensure(r.ok, 502, 'oauth_exchange', 'GitHub sign-in could not be completed.');
    const t = await boundedResponse(r, 16_384);
    ensure(!t.error && /^ghu_[A-Za-z0-9_]+$/.test(t.access_token || '') && t.token_type === 'bearer' && Number.isInteger(t.expires_in) && t.expires_in > 60 && t.expires_in <= 28800, 502, 'oauth_token', 'Use a GitHub App with expiring user tokens enabled.');
    // Refresh tokens are deliberately not retained. Reauthenticate after the bounded session expires.
    return { token: t.access_token, expiresIn: t.expires_in };
  }
  async api(token, path, { method = 'GET', body, signal, allow404 = false } = {}) {
    ensure(typeof path === 'string' && /^\/(user(?:\/|\?|$)|repos\/)/.test(path) && !/[\s\\#]/.test(path) && !path.includes('..'), 500, 'upstream_path', 'Invalid GitHub API path.');
    const r = await this.fetch('https://api.github.com' + path, { method, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { accept: 'application/vnd.github+json', 'content-type': 'application/json', authorization: `Bearer ${token}`,
        'x-github-api-version': '2026-03-10', 'user-agent': 'graft-connected-beta' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (r.status === 404 && allow404) { await r.body?.cancel(); return null; }
    if (!r.ok) {
      await r.body?.cancel();
      throw new HttpError(r.status === 401 ? 401 : r.status === 403 || r.status === 429 ? 429 : r.status === 404 ? 404 : 502,
        r.status === 401 ? 'github_auth' : 'github_request', r.status === 401 ? 'GitHub authorization expired or was revoked. Sign in again.' : `GitHub could not complete the request (HTTP ${r.status}).`);
    }
    return boundedResponse(r);
  }
  async user(token, signal) {
    const user = await this.api(token, '/user', { signal });
    ensure(Number.isSafeInteger(user.id) && user.id > 0 && typeof user.login === 'string', 502, 'github_user', 'Invalid GitHub user.');
    return { id: user.id, login: user.login };
  }
  async repositories(token, signal) {
    const all = [], seen = new Set();
    const installations = await this.api(token, '/user/installations?per_page=100', { signal });
    ensure(Array.isArray(installations.installations) && Number.isInteger(installations.total_count) && installations.total_count <= 100, 422, 'repo_limit', 'Too many installations for this beta.');
    for (const install of installations.installations) {
      if (install.app_id !== this.config.appId || install.suspended_at) continue;
      ensure(Number.isSafeInteger(install.id) && install.id > 0, 502, 'installation', 'Invalid installation.');
      for (let page = 1; page <= 10; page++) {
        const result = await this.api(token, `/user/installations/${install.id}/repositories?per_page=100&page=${page}`, { signal });
        ensure(Array.isArray(result.repositories) && Number.isInteger(result.total_count) && result.total_count <= 1000, 422, 'repo_limit', 'This beta supports up to 1,000 repositories per installation.');
        for (const r of result.repositories) {
          ensure(Number.isSafeInteger(r.id) && r.id > 0 && nameOK(r.full_name), 502, 'repo_metadata', 'Invalid repository metadata.');
          if (!seen.has(r.id)) { seen.add(r.id); all.push({ id: r.id, name: r.full_name, private: r.private === true, writable: r.permissions?.push === true, archived: r.archived === true }); }
        }
        ensure(all.length <= 1000, 422, 'repo_limit', 'This beta supports at most 1,000 repositories total.');
        if (page * 100 >= result.total_count) break;
      }
    }
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }
  async authorize(token, sourceId, destinationId, signal) {
    const repos = await this.repositories(token, signal);
    const source = repos.find(r => r.id === sourceId), destination = repos.find(r => r.id === destinationId);
    ensure(source && destination, 403, 'repo_access', 'Both repositories must be accessible to you and installed for this GitHub App.');
    ensure(destination.writable && !destination.archived, 403, 'repo_write', 'Destination requires write access and must not be archived.');
    ensure(source.id !== destination.id, 400, 'same_repo', 'Select two different repositories.');
    return { source, destination };
  }
  async readRepository(token, selected, signal) {
    ensure(nameOK(selected.name), 400, 'repo', 'Invalid repository selection.');
    const root = '/repos/' + selected.name;
    const metadata = await this.api(token, root, { signal });
    ensure(metadata.id === selected.id && nameOK(metadata.full_name) && metadata.full_name === selected.name && typeof metadata.default_branch === 'string', 409, 'repo_changed', 'Repository identity changed. Refresh the selection.');
    const commit = await this.api(token, `${root}/commits/${encodeURIComponent(metadata.default_branch)}`, { signal });
    ensure(sha(commit.sha) && sha(commit.commit?.tree?.sha), 502, 'commit', 'Invalid repository commit.');
    const tree = await this.api(token, `${root}/git/trees/${commit.commit.tree.sha}?recursive=1`, { signal });
    ensure(tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= 20000, 422, 'tree_limit', 'Repository is too large for complete inspection in this beta.');
    const inventory = tree.tree.filter(f => ['blob', 'commit'].includes(f.type)).map(f => f.path);
    const candidates = tree.tree.filter(f => f.type === 'blob' && ['100644', '100755'].includes(f.mode) && eligiblePath(f.path));
    ensure(candidates.length > 0 && candidates.length <= 160 && candidates.every(f => Number.isInteger(f.size) && f.size <= LIMITS.fileBytes) && candidates.reduce((n, f) => n + f.size, 0) <= LIMITS.snapshotBytes, 422, 'snapshot_limit', 'Complete inspection requires at most 160 eligible files, 750KB total and 60KB per file. Larger projects are not supported by this beta yet.');
    const files = [];
    for (const item of candidates) {
      signal?.throwIfAborted(); ensure(sha(item.sha), 502, 'blob', 'Invalid repository blob.');
      const blob = await this.api(token, `${root}/git/blobs/${item.sha}`, { signal });
      ensure(blob.encoding === 'base64' && typeof blob.content === 'string' && blob.size === item.size, 502, 'blob', 'Invalid repository blob response.');
      const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
      ensure(bytes.length === item.size && createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === item.sha, 502, 'blob_integrity', 'Repository blob integrity check failed.');
      try { files.push({ path: item.path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }); }
      catch { throw new HttpError(422, 'binary_file', 'An eligible source file is not UTF-8 text.'); }
    }
    const snap = snapshot({ name: metadata.full_name, revision: commit.sha, files, inventory });
    ensure(snap.skipped.length === 0, 422, 'sensitive_file', 'A selected file was filtered as unsafe. Review the repository before transferring it.');
    return { snapshot: snap, repository: { id: metadata.id, name: metadata.full_name, branch: metadata.default_branch,
      commit: commit.sha, tree: commit.commit.tree.sha, modes: Object.fromEntries(tree.tree.filter(f => f.type === 'blob').map(f => [f.path, f.mode])) } };
  }
}
