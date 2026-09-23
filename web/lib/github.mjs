import { Fault, requireThat, snapshot, rank } from './core.mjs';
import { eligiblePath, LIMITS } from './policy.mjs';
export function repositoryName(input) {
  requireThat(typeof input === 'string' && input.length <= 250, 'Enter a GitHub owner/repo or repository URL.');
  let value = input.trim();
  if (value.startsWith('https://')) {
    let u; try { u = new URL(value); } catch { throw new Fault('Invalid repository URL.'); }
    requireThat(u.hostname === 'github.com' && !u.port && !u.username && !u.password && !u.search && !u.hash, 'Only direct https://github.com/owner/repo URLs are supported.');
    value = u.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  value = value.replace(/\.git$/, '');
  requireThat(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value) && !value.split('/').some(p => p === '.' || p === '..'), 'Use owner/repo, without branches, credentials, or extra URL paths.');
  return value;
}
export async function boundedJSON(response, max = 2000000) {
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) throw new Fault('Upstream response exceeded the safe size limit.', 413);
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Fault('Upstream returned invalid JSON.', 502); }
}
export async function readPublicRepository(input, feature, { fetchImpl = fetch, signal } = {}) {
  const name = repositoryName(input);
  const api = async suffix => {
    const response = await fetchImpl(`https://api.github.com/repos/${name}${suffix}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'graft-web-preview', 'x-github-api-version': '2022-11-28' },
      redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(response.status === 404 ? 'Repository unavailable. This preview reads public GitHub repositories; use a local folder for private code.' :
        [403, 429].includes(response.status) ? 'GitHub access or rate limit reached. Try local folders, or retry later.' : `GitHub returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502);
    }
    return boundedJSON(response);
  };
  const meta = await api('');
  requireThat(meta.private === false && typeof meta.default_branch === 'string', 'Only public repositories are supported through URL intake.');
  const commit = await api(`/commits/${encodeURIComponent(meta.default_branch)}`);
  requireThat(/^[a-f0-9]{40}$/.test(commit.sha) && /^[a-f0-9]{40}$/.test(commit.commit?.tree?.sha), 'Invalid upstream commit.', 502);
  const tree = await api(`/git/trees/${commit.commit.tree.sha}?recursive=1`);
  requireThat(tree.truncated === false && Array.isArray(tree.tree) && tree.tree.length <= 20000, 'Repository tree is truncated or too large. Use a smaller local directory.', 413);
  const inventory = tree.tree.filter(f => ['blob', 'commit'].includes(f.type)).map(f => f.path);
  const candidates = tree.tree.filter(f => f.type === 'blob' && ['100644', '100755'].includes(f.mode) && eligiblePath(f.path) && f.size <= LIMITS.fileBytes);
  const byPath = new Map(candidates.map(f => [f.path, f]));
  // 14 text requests per repo keeps a two-repository run bounded even without a GitHub token.
  const ordered = rank(candidates.map(f => ({ path: f.path, content: '' })), feature).map(f => f.path);
  const manifests = candidates.filter(f => /(?:^|\/)(?:package\.json|pyproject\.toml|go\.mod|Cargo\.toml|LICENSE|README\.md)$/.test(f.path)).slice(0, 4).map(f => f.path);
  const selected = [...new Set([...ordered.filter(p => rank([{ path: p, content: '' }], feature)[0].score > 0).slice(0, 8), ...manifests, ...ordered])].slice(0, 14);
  const files = [];
  for (const filePath of selected) {
    signal?.throwIfAborted();
    const entry = byPath.get(filePath);
    requireThat(/^[a-f0-9]{40}$/.test(entry.sha), 'Invalid upstream blob.', 502);
    const blob = await api(`/git/blobs/${entry.sha}`);
    requireThat(blob.encoding === 'base64' && typeof blob.content === 'string' && blob.size <= LIMITS.fileBytes, 'Invalid or oversized upstream file.', 502);
    const data = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    requireThat(data.length <= LIMITS.fileBytes, 'Upstream file is too large.', 413);
    let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { continue; }
    files.push({ path: filePath, content });
  }
  return snapshot({ name, revision: commit.sha, files, inventory });
}
