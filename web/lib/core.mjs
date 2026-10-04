/**
 * @file Repot web-engine module for core. It supports bounded transfer analysis, provider integration, syntax adaptation, or test preservation used by the web and MCP products.
 *
 * Boundary note: keep repository context bounded and never claim execution/verification that this module did not actually perform.
 */
// Snapshot/patch primitives remain unchanged; this layer makes tests part of every transfer.
import { analyze as analyzeBase, reviewProposal as reviewBase, rank, hash, unifiedPatch, LIMITS, ProposalValidationError } from './core-base.mjs';
import { discoverTests, transplantTests, references, isTestPath, isTestSupport, isTestConfig } from './test-transfer.mjs';
import { profileProject, languageForPath, isProjectTest } from './project-profile.mjs';
import { planFeature, finalizePlan, compactPlan, selectContext } from './feature-plan.mjs';
import { discoverDartTests, transplantDartTests } from './dart-test-transfer.mjs';
export * from './core-base.mjs';
/**
 * @function bytes
 * Implements bytes for Repot's bounded web transfer pipeline.
 */
const bytes = text => Buffer.byteLength(text, 'utf8');
/**
 * Inspect project types and scoped dependency evidence before selecting bounded model context.
 * Explicit entrypoints are server-validated and survive repair/review through immutable selection.
 */
export function analyze(source, destination, feature, options = {}) {
  const base = analyzeBase(source, destination, feature);
  const production = f => !isTestPath(f.path) && !isTestSupport(f.path) && !isTestConfig(f.path) && !isProjectTest(f.path) && languageForPath(f.path);
  const ranked = rank(source.files.filter(production), base.feature);
  const sourceRoots = ranked.filter(f => f.score > 0 && f.score >= (ranked[0]?.score ?? 0) / 2).slice(0, 8).map(f => f.path);
  const destinationRoots = rank(destination.files.filter(production), base.feature).slice(0, 3).map(f => f.path);
  const plan = planFeature(source, destination, base.feature, { ...options, sourceRoots, destinationRoots, jsReferences: references });
  const testPlan = discoverDartTests(source, destination, plan.roots, plan.landing) ?? discoverTests(source, destination, plan.roots);
  plan.requiredSource = [...new Set([...plan.requiredSource, ...testPlan.requiredSource])];
  plan.requiredDestination = [...new Set([...plan.requiredDestination, ...testPlan.requiredDestination])];
  const context = { feature: base.feature, selection: plan.selection, testPlan,
    ...selectContext(source,destination,{sourcePriority:plan.requiredSource,destinationPriority:plan.requiredDestination,
      sourceFallback:rank(source.files,base.feature).slice(0,8).map(f=>f.path),
      destinationFallback:rank(destination.files,base.feature).slice(0,8).map(f=>f.path)}) };
  context.integrationPlan = compactPlan(finalizePlan(plan, context));
  return { ...base, projects: plan.projects, integrationPlan: context.integrationPlan, testPlan, context,
    contextManifest: { source: context.source.map(f => f.path), destination: context.destination.map(f => f.path) } };
}
/**
 * @function reviewProposal
 * Implements review proposal for Repot's bounded web transfer pipeline.
 */
export function reviewProposal(proposal, source, destination, context, provider = 'ai') {
  // Validate the provider's production draft before interpreting any mapping/provenance.
  const base = reviewBase(proposal, source, destination, context, provider);
  // Recompute from snapshots; a provider cannot supply or weaken the required test plan.
  const plan = analyze(source, destination, context.feature, context.selection).testPlan;
  const native = plan.adapter === 'dart';
  const transferred = native ? transplantDartTests(base.changes, source, destination, plan, context) : transplantTests(base.changes, source, destination, plan, context);
  const testTransfer = transferred.report;
  // Only the native adapter's fixed, repairable implementation diagnostics enter the
  // existing bounded repair loop. Source/setup/policy failures stay unexportable.
  if (native && testTransfer.proposalRepairCode) throw new ProposalValidationError(testTransfer.proposalRepairCode, testTransfer.proposalRepairChangeIndex);
  // Newly admitted native sources must not turn undiscovered tests into a false "none_found".
  // Dedicated adapters can replace this conservative gate as their fixtures are validated.
  const unhandled = native ? [] : source.files.filter(f => isProjectTest(f.path) && languageForPath(f.path) &&
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
    integrationPlan: context.integrationPlan ?? null,
    notice: (exportable ? '' : 'Patch export is blocked until test-transfer issues are resolved. ') + base.notice };
}
