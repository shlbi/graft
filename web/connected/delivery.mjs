import { ensure, sha256 } from './security.mjs';
import { eligiblePath, looksSensitive, LIMITS } from '../lib/policy.mjs';
const validSha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
export const reviewDigest = review => sha256(JSON.stringify(review));
/** Validate the exact stored draft, never a browser-provided patch. No writes to the default branch. */
export function validateDelivery(job) {
  const { review, destination } = job;
  ensure(review?.exportable === true && typeof review.patch === 'string' && review.patch.length > 0 && review.testTransfer?.status !== 'blocked', 409, 'blocked_draft', 'The test-transfer gate blocks this draft.');
  ensure(review.destinationRevision === destination.commit && validSha(destination.commit) && validSha(destination.tree), 409, 'snapshot', 'Draft snapshot does not match the destination.');
  ensure(review.changes.length > 0 && review.changes.length <= 32, 422, 'patch_limit', 'Invalid draft size.');
  const seen = new Set(); let bytes = 0;
  for (const c of review.changes) {
    ensure(eligiblePath(c.path) && !c.path.split('/').some(p => ['.github', '.git'].includes(p.toLowerCase())) && ['add', 'update'].includes(c.action), 422, 'unsafe_change', 'Unsafe proposed change.');
    ensure(typeof c.content === 'string' && !looksSensitive(c.content) && !c.content.includes('\0') && Buffer.byteLength(c.content) <= LIMITS.fileBytes, 422, 'unsafe_content', 'Unsafe proposed content.');
    const key = c.path.toLowerCase();
    ensure(!seen.has(key) && ![...seen, ...Object.keys(destination.modes).map(p => p.toLowerCase())].some(p => p !== key && (p.startsWith(key + '/') || key.startsWith(p + '/'))), 422, 'collision', 'Proposed paths collide.');
    seen.add(key); bytes += Buffer.byteLength(c.content);
    if (c.action === 'update') ensure(['100644', '100755'].includes(destination.modes[c.path]) && typeof c.before === 'string' && sha256(c.before) === c.baseHash, 409, 'base_hash', 'Invalid update baseline.');
    else ensure(!Object.keys(destination.modes).some(p => p.toLowerCase() === key), 409, 'collision', 'Added file would overwrite existing content.');
  }
  ensure(bytes <= 120000, 422, 'patch_limit', 'Combined patch is too large.');
}
export async function deliver({ job, token, github, save, signal }) {
  validateDelivery(job);
  const { destination: d, review } = job, root = '/repos/' + d.name, branch = `graft/${job.id}`;
  const authorized = await github.authorize(token, job.input.sourceId, d.id, signal);
  ensure(authorized.destination.name === d.name, 409, 'repo_changed', 'Repository was renamed; analyze again.');
  const head = () => github.api(token, `${root}/git/ref/heads/${encodeURIComponent(d.branch)}`, { signal });
  const branchPath = `${root}/git/ref/heads/${encodeURIComponent(branch)}`;
  let existing = await github.api(token, branchPath, { signal, allow404: true });
  if (!existing) {
    ensure((await head()).object?.sha === d.commit, 409, 'stale_base', 'Destination changed after analysis. Create a new draft.');
    if (!job.deliveryCommit) {
      const tree = await github.api(token, `${root}/git/trees`, { method: 'POST', signal, body: { base_tree: d.tree,
        tree: review.changes.map(c => ({ path: c.path, mode: c.action === 'update' ? d.modes[c.path] : '100644', type: 'blob', content: c.content })) } });
      ensure(validSha(tree.sha), 502, 'tree', 'Invalid tree response.');
      const commit = await github.api(token, `${root}/git/commits`, { method: 'POST', signal, body: { message: 'Graft: proposed feature transfer with related tests', tree: tree.sha, parents: [d.commit] } });
      ensure(validSha(commit.sha), 502, 'commit', 'Invalid commit response.');
      job.deliveryCommit = commit.sha; job.deliveryBranch = branch; save(job); // Persist intent before the first branch write.
    }
    ensure((await head()).object?.sha === d.commit, 409, 'stale_base', 'Destination changed before publication. No branch was updated.');
    await github.api(token, `${root}/git/refs`, { method: 'POST', signal, body: { ref: 'refs/heads/' + branch, sha: job.deliveryCommit } });
    existing = await github.api(token, branchPath, { signal });
  }
  ensure(job.deliveryCommit && existing.object?.sha === job.deliveryCommit, 409, 'branch_changed', 'The delivery branch differs from this draft. Existing work was not overwritten.');
  const query = new URLSearchParams({ state: 'all', head: d.name.split('/')[0] + ':' + branch, base: d.branch, per_page: '100' });
  const prs = await github.api(token, `${root}/pulls?${query}`, { signal });
  ensure(Array.isArray(prs), 502, 'pulls', 'Invalid pull request response.');
  let pr = prs.find(p => p.head?.ref === branch && p.base?.ref === d.branch);
  if (!pr) {
    // Recheck immediately before creating the PR. Changes can still race this check; never auto-merge.
    ensure((await github.api(token, branchPath, { signal })).object?.sha === job.deliveryCommit, 409, 'branch_changed', 'The delivery branch was changed.');
    const title = 'Graft: ' + job.input.feature.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 110);
    const body = `## Proposed feature transfer\n\n**Draft only: this user-project build and tests have NOT been executed by Graft.**\n\nReview every change and run the destination checks before merging. No merge was requested.\n\nSource: ${job.source.name} at ${job.source.commit}\nDestination baseline: ${d.commit}\nReview digest: ${job.digest}\n\n${review.changes.length} files, including ${review.testTransfer.placements?.filter(p => p.kind === 'test').length || 0} test files. Test assertions are preserved by the supported transfer adapter; this is not proof the feature works in this project.\n\nExisting GitHub workflows may run on the branch or pull request, as acknowledged by the requesting user.`;
    pr = await github.api(token, `${root}/pulls`, { method: 'POST', signal, body: { title, body, head: branch, base: d.branch, draft: true } });
  }
  ensure(Number.isSafeInteger(pr.number) && pr.head?.sha === job.deliveryCommit && pr.head?.ref === branch && pr.base?.ref === d.branch && pr.html_url === `https://github.com/${d.name}/pull/${pr.number}`, 409, 'pr_changed', 'Pull request identity or commit differs from this draft. Review on GitHub.');
  return { number: pr.number, url: pr.html_url, branch, commit: job.deliveryCommit, state: pr.state, draft: pr.draft === true };
}
