import { createHash } from 'node:crypto';
import path from 'node:path';
import { LIMITS, eligiblePath, pathShape, looksSensitive } from './policy.mjs';
export { LIMITS };
export class Fault extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const hash = value => createHash('sha256').update(value).digest('hex');
export function requireThat(ok, message, status = 400) { if (!ok) throw new Fault(message, status); }
const bytes = text => Buffer.byteLength(text, 'utf8');
export function featureText(value) {
  requireThat(typeof value === 'string' && value.trim().length >= 3 && value.length <= 1500, 'Describe a feature in 3–1500 characters.');
  requireThat(!looksSensitive(value), 'The feature description appears to contain a credential. Remove it before continuing.');
  return value.trim();
}
export function snapshot(input) {
  requireThat(input && typeof input === 'object' && typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 120, 'A repository needs a short name.');
  requireThat(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= LIMITS.files, `Choose 1–${LIMITS.files} eligible text files per repository.`);
  const files = [], skipped = [], seen = new Set();
  let total = 0;
  for (const file of input.files) {
    requireThat(file && pathShape(file.path) && typeof file.content === 'string', 'Invalid repository file or path.');
    const key = file.path.toLowerCase();
    requireThat(!seen.has(key), `Duplicate or case-colliding path: ${file.path}`); seen.add(key);
    total += bytes(file.content);
    requireThat(total <= LIMITS.snapshotBytes, 'Repository selection is too large. Select a smaller feature-focused directory.');
    if (!eligiblePath(file.path) || bytes(file.content) > LIMITS.fileBytes || file.content.includes('\0') || looksSensitive(file.content)) {
      skipped.push(file.path); continue;
    }
    files.push({ path: file.path, content: file.content, hash: hash(file.content) });
  }
  requireThat(files.length > 0, 'No eligible source text remains after size, binary, and sensitive-file filtering.');
  requireThat(input.revision == null || (typeof input.revision === 'string' && /^[a-f0-9]{40}$/.test(input.revision)), 'Invalid snapshot revision.');
  const inventory = input.inventory ?? input.files.map(f => f.path);
  requireThat(Array.isArray(inventory) && inventory.length <= 20000 && inventory.every(p => typeof p === 'string' && p.length <= 1024 && !p.includes('\0')), 'Invalid repository inventory.');
  requireThat(bytes(JSON.stringify(inventory)) <= 500000, 'Repository inventory exceeds the size limit.');
  requireThat(input.files.every(f => inventory.includes(f.path)), 'The inventory must include every supplied file.');
  const paths = [...new Set(inventory)].sort();
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const fingerprint = hash(JSON.stringify({ files: files.map(f => [f.path, f.hash]), paths }));
  return { name: input.name, files, inventory: paths, skipped, fingerprint, revision: input.revision ?? null,
    coverage: { inspected: files.length, knownPaths: paths.length, completeTextSnapshot: files.length === paths.length } };
}
const stop = new Set('a an the and or to from into in of with for it its this that move copy feature add my please make'.split(' '));
export function words(text) {
  return [...new Set(text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !stop.has(w)))];
}
export function rank(files, feature) {
  const tokens = words(feature);
  return files.map(file => {
    const filename = path.posix.basename(file.path).toLowerCase(), fullPath = file.path.toLowerCase(), body = file.content.toLowerCase();
    const matched = tokens.filter(t => fullPath.includes(t) || body.includes(t));
    const score = tokens.reduce((n, t) => n + (filename.includes(t) ? 9 : fullPath.includes(t) ? 5 : 0) + (body.includes(t) ? 2 : 0), 0);
    return { ...file, score, matched };
  }).sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function stack(repo) {
  const counts = new Map();
  const names = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', cs: 'C#', swift: 'Swift', rb: 'Ruby', php: 'PHP', cpp: 'C++' };
  for (const f of repo.files) { const name = names[f.path.split('.').pop()]; if (name) counts.set(name, (counts.get(name) ?? 0) + 1); }
  const languages = [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const frameworks = new Set();
  for (const f of repo.files.filter(f => /(?:^|\/)package\.json$/.test(f.path))) {
    try { const p = JSON.parse(f.content); for (const key of Object.keys({ ...p.dependencies, ...p.devDependencies })) {
      if (['next', 'react', 'vue', 'svelte', 'express', 'fastify', 'astro'].includes(key)) frameworks.add(key);
    } } catch { /* invalid manifest is untrusted text, never executable */ }
  }
  return { languages, frameworks: [...frameworks] };
}
function contextFiles(repo, feature, budget) {
  const ranked = rank(repo.files, feature), byPath = new Map(repo.files.map(f => [f.path, f]));
  const chosen = new Map(); let used = 0;
  const add = f => {
    if (!f || chosen.has(f.path) || chosen.size >= 18 || used + bytes(f.content) > budget) return false;
    chosen.set(f.path, f); used += bytes(f.content); return true;
  };
  ranked.filter(f => f.score > 0).slice(0, 8).forEach(add);
  repo.files.filter(f => /(?:^|\/)(?:package\.json|pyproject\.toml|go\.mod|Cargo\.toml|LICENSE|NOTICE|README\.md)$/.test(f.path)).slice(0, 5).forEach(add);
  // Bounded literal relative-import expansion; not a full dependency resolver.
  for (const file of chosen.values()) {
    for (const m of file.content.matchAll(/(?:from\s*|import\s*\(|require\s*\(|import\s*)["'](\.[^"']+)["']/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), m[1]));
      const variants = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js'].map(ext => base + ext)];
      if (/\.js$/.test(base)) variants.push(base.replace(/\.js$/, '.ts'));
      add(variants.map(p => byPath.get(p)).find(Boolean));
    }
  }
  ranked.slice(0, 8).forEach(add);
  return [...chosen.values()].map(({ path, content, hash }) => ({ path, content, hash }));
}
export function analyze(source, destination, feature) {
  feature = featureText(feature);
  requireThat(source.fingerprint !== destination.fingerprint, 'Source and destination snapshots are identical. Choose two different projects.');
  const context = { feature, source: contextFiles(source, feature, LIMITS.contextBytes / 2), destination: contextFiles(destination, feature, LIMITS.contextBytes / 2) };
  const summary = repo => ({ name: repo.name, revision: repo.revision, fingerprint: repo.fingerprint, coverage: repo.coverage, skipped: repo.skipped, stack: stack(repo) });
  return { feature, source: summary(source), destination: summary(destination),
    candidates: rank(source.files, feature).filter(f => f.score > 0).slice(0, 8).map(f => ({ path: f.path, matched: f.matched })),
    contextManifest: { source: context.source.map(f => f.path), destination: context.destination.map(f => f.path) },
    warnings: ['Discovery uses text matching and bounded relative-import expansion, not complete semantic dependency analysis.',
      'Only selected text is inspected. Missing assets, database migrations, packages, and framework wiring require review.',
      'Use source code you have permission to reuse; preserve its license and attribution.'], context };
}
const exactKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join('|') === [...keys].sort().join('|');
function strings(values, max, label) {
  requireThat(Array.isArray(values) && values.length <= max && values.every(v => typeof v === 'string' && v.length > 0 && v.length <= 600), `Invalid ${label} list.`); return values;
}
function patchLines(text, prefix) {
  if (!text) return '';
  const lines = text.split('\n'), finalNewline = text.endsWith('\n'); if (finalNewline) lines.pop();
  return lines.map((line, i) => prefix + line + '\n' + (!finalNewline && i === lines.length - 1 ? '\\ No newline at end of file\n' : '')).join('');
}
function lineCount(text) { return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; }
export function unifiedPatch(changes) {
  return changes.map(c => {
    const a = lineCount(c.before ?? ''), b = lineCount(c.content);
    return `diff --git a/${c.path} b/${c.path}\n` + (c.action === 'add' ? 'new file mode 100644\n' : '') +
      `--- ${c.action === 'add' ? '/dev/null' : 'a/' + c.path}\n+++ b/${c.path}\n` +
      `@@ -${a ? 1 : 0},${a} +${b ? 1 : 0},${b} @@\n` + patchLines(c.before ?? '', '-') + patchLines(c.content, '+');
  }).join('');
}
export function reviewProposal(proposal, source, destination, context, provider = 'ai') {
  requireThat(exactKeys(proposal, ['summary', 'changes', 'risks', 'suggestedChecks']), 'Provider returned an invalid proposal envelope.', 422);
  requireThat(typeof proposal.summary === 'string' && proposal.summary.length > 0 && proposal.summary.length <= 1500, 'Invalid proposal summary.', 422);
  requireThat(Array.isArray(proposal.changes) && proposal.changes.length > 0 && proposal.changes.length <= LIMITS.changes, 'A draft needs 1–10 file changes.', 422);
  const viewed = new Map(context.destination.map(f => [f.path, f]));
  const sourcePaths = new Set(context.source.map(f => f.path));
  const occupied = new Set(destination.inventory.map(p => p.toLowerCase()));
  const pending = new Set(); let total = 0;
  const changes = proposal.changes.map(c => {
    requireThat(exactKeys(c, ['path', 'action', 'content', 'reason', 'sourcePaths']), 'Invalid change fields.', 422);
    requireThat(eligiblePath(c.path) && ['add', 'update'].includes(c.action), 'Unsafe path or unsupported change action.', 422);
    requireThat(typeof c.content === 'string' && bytes(c.content) <= LIMITS.fileBytes && !c.content.includes('\0') && !looksSensitive(c.content), 'Unsafe or oversized generated file.', 422);
    requireThat(typeof c.reason === 'string' && c.reason.length > 0 && c.reason.length <= 600, 'Each change needs a short reason.', 422);
    requireThat(Array.isArray(c.sourcePaths) && c.sourcePaths.length > 0 && c.sourcePaths.length <= 12 && c.sourcePaths.every(p => sourcePaths.has(p)), 'Every change must cite inspected source files.', 422);
    const key = c.path.toLowerCase(); requireThat(!pending.has(key), 'Duplicate change path.', 422); pending.add(key);
    const before = viewed.get(c.path);
    if (c.action === 'add') requireThat(!occupied.has(key) && c.content.length > 0, 'An added file would overwrite an existing path or be empty.', 422);
    else requireThat(before && before.content !== c.content, 'Updates require inspected, changed destination content.', 422);
    total += bytes(c.content); requireThat(total <= 120000, 'Generated changes exceed the patch budget.', 422);
    return { ...c, before: c.action === 'add' ? null : before.content, baseHash: c.action === 'add' ? null : before.hash };
  });
  for (const c of changes) {
    const key = c.path.toLowerCase();
    requireThat(![...occupied, ...pending].some(p => p !== key && (p.startsWith(key + '/') || key.startsWith(p + '/'))), 'File/directory collision in proposed changes.', 422);
  }
  strings(proposal.risks, 12, 'risks'); strings(proposal.suggestedChecks, 12, 'suggested checks');
  const patch = unifiedPatch(changes);
  return { id: hash(source.fingerprint + destination.fingerprint + patch), provider, summary: proposal.summary,
    sourceFingerprint: source.fingerprint, destinationFingerprint: destination.fingerprint, destinationRevision: destination.revision,
    changes, patch, risks: proposal.risks, suggestedChecks: proposal.suggestedChecks,
    verification: { structure: 'passed', build: 'not_run', tests: 'not_run', integration: 'not_run' },
    notice: 'Draft only. No repository was changed and no generated code or suggested command was executed. Review the patch and run checks in an isolated checkout before merging.' };
}
