/**
 * @file Repot web-engine module for core. It supports bounded transfer analysis, provider integration, syntax adaptation, or test preservation used by the web and MCP products.
 *
 * Boundary note: keep repository context bounded and never claim execution/verification that this module did not actually perform.
 */
// Snapshot/patch primitives remain unchanged; this layer makes tests part of every transfer.
import { analyze as analyzeBase, reviewProposal as reviewBase, rank, hash, unifiedPatch, LIMITS } from './core-base.mjs';
import { discoverTests, transplantTests, references, isTestPath, isTestSupport, isTestConfig } from './test-transfer.mjs';
import { profileProject, languageForPath, isProjectTest } from './project-profile.mjs';
export * from './core-base.mjs';
/**
 * @function bytes
 * Implements bytes for Repot's bounded web transfer pipeline.
 */
const bytes = text => Buffer.byteLength(text, 'utf8');
/**
 * @function contextFiles
 * Implements context files for Repot's bounded web transfer pipeline.
 */
function contextFiles(repo, feature, priority) {
  const ranked = rank(repo.files, feature), files = new Map(repo.files.map(f => [f.path, f]));
  const chosen = new Map(); let used = 0;
  /**
   * @function add
   * Implements add for Repot's bounded web transfer pipeline.
   */
  const add = file => {
    if (!file || chosen.has(file.path) || chosen.size >= 36 || used + bytes(file.content) > LIMITS.contextBytes / 2) return;
    chosen.set(file.path, file); used += bytes(file.content);
  };
  priority.forEach(p => add(files.get(p)));
  ranked.filter(f => f.score > 0).slice(0, 8).forEach(add);
  repo.files.filter(f => /(?:^|\/)(?:package\.json|pyproject\.toml|go\.mod|Cargo\.toml|LICENSE|NOTICE|README\.md)$/.test(f.path)).slice(0, 5).forEach(add);
  for (const file of chosen.values()) for (const r of references(file, files)) if (r.target) add(files.get(r.target));
  ranked.slice(0, 8).forEach(add);
  return [...chosen.values()].map(({ path, content, hash }) => ({ path, content, hash }));
}
/**
 * @function analyze
 * Implements analyze for Repot's bounded web transfer pipeline.
 */
export function analyze(source, destination, feature) {
  const base = analyzeBase(source, destination, feature);
  const ranked = rank(source.files.filter(f => !isTestPath(f.path) && !isTestSupport(f.path) && !isTestConfig(f.path) && !isProjectTest(f.path) && languageForPath(f.path)), base.feature);
  const roots = ranked.filter(f => f.score > 0 && f.score >= (ranked[0]?.score ?? 0) / 2).slice(0, 8).map(f => f.path);
  const testPlan = discoverTests(source, destination, roots);
  const context = { feature: base.feature, testPlan,
    source: contextFiles(source, base.feature, [...roots, ...testPlan.requiredSource]),
    destination: contextFiles(destination, base.feature, testPlan.requiredDestination) };
  return { ...base, projects: { source: profileProject(source), destination: profileProject(destination) }, testPlan, context, contextManifest: { source: context.source.map(f => f.path), destination: context.destination.map(f => f.path) } };
}
/**
 * @function reviewProposal
 * Implements review proposal for Repot's bounded web transfer pipeline.
 */
export function reviewProposal(proposal, source, destination, context, provider = 'ai') {
  // Validate the provider's production draft before interpreting any mapping/provenance.
  const base = reviewBase(proposal, source, destination, context, provider);
  // Recompute from snapshots; a provider cannot supply or weaken the required test plan.
  const plan = analyze(source, destination, context.feature).testPlan;
  const transferred = transplantTests(base.changes, source, destination, plan, context);
  const testTransfer = transferred.report;
  // Newly admitted native sources must not turn undiscovered tests into a false "none_found".
  // Dedicated adapters can replace this conservative gate as their fixtures are validated.
  const unhandled = source.files.filter(f => isProjectTest(f.path) && languageForPath(f.path) &&
    !/\.[cm]?[jt]sx?$/i.test(f.path) && !plan.tests.some(t => t.path === f.path));
  if (unhandled.length) {
    testTransfer.status = 'blocked';
    testTransfer.blockers.push('Native test discovery requires a language adapter; ' + unhandled.length + ' test/support file(s) were not covered. No tests were silently dropped.');
  }
  const changes = transferred.changes.map(c => ({ ...c, before: c.before ?? null, baseHash: c.baseHash ?? null }));
  if (changes.length > 32 || changes.reduce((n, c) => n + bytes(c.content), 0) > 120000) {
    testTransfer.status = 'blocked'; testTransfer.blockers.push('Feature and tests exceed the 32-file/120KB combined patch budget. Narrow the transfer.');
  }
  const exportable = testTransfer.status !== 'blocked';
  return { ...base, id: hash(source.fingerprint + destination.fingerprint + JSON.stringify(changes)), changes,
    patch: exportable ? unifiedPatch(changes) : null, exportable, testTransfer,
    notice: (exportable ? '' : 'Patch export is blocked until test-transfer issues are resolved. ') + base.notice };
}
