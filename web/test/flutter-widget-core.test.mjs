/** Real core/parser/adapter and Git checks. Authored proposal; no AI or native SDK execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {snapshot, analyze, reviewProposal, ProposalValidationError} from '../lib/core.mjs';
import {dartDirectives} from '../lib/source-graph.mjs';
import {buildWidgetTransfer, materializeFlutterWidgetFixture} from '../../scripts/materialize-flutter-widget-fixture.mjs';
import {flutterWidgetFixture, hostProbe} from './fixtures/flutter-widget-fixture.mjs';

function mask(text) {
  let result = text;
  for (const r of dartDirectives({content: text}).directives.toReversed()) result = result.slice(0, r.start) + '<URI>' + result.slice(r.end);
  return result;
}
function draft(f) {
  const source = snapshot(f.sourceInput), destination = snapshot(f.destinationInput);
  const a = analyze(source, destination, 'stateful cart widget pricing', f.selection);
  return reviewProposal(f.proposal, source, destination, a.context);
}
for (const options of [{}, {sourceRoot: 'packages/donor', destinationRoot: 'apps/store'}]) {
  test('actual pipeline preserves widget tests and host update: ' + JSON.stringify(options), async () => {
    const {f, source, destination, analysis, review} = await buildWidgetTransfer(options);
    assert.equal(analysis.integrationPlan.contextCoverage.complete, true);
    assert.equal(review.exportable, true, JSON.stringify(review.testTransfer.blockers));
    assert.equal(review.changes.length, 6); assert.equal(review.testTransfer.discovered, 2);
    for (const p of review.testTransfer.placements) {
      assert.equal(mask(source.files.find(f => f.path === p.sourcePath).content), mask(review.changes.find(f => f.path === p.destinationPath).content));
      assert.ok(p.destinationPath.startsWith(f.d('test/repot_')));
    }
    assert.ok(review.changes.some(c => c.path === f.d('lib/main.dart') && c.action === 'update'));
    assert.ok(!review.changes.some(c => c.path === f.d('test/cart_panel_test.dart')));
    assert.ok(!review.changes.some(c => c.path.includes('unrelated_test') || c.content === hostProbe));
    assert.deepEqual(review.verification, {structure: 'passed', build: 'not_run', tests: 'not_run', integration: 'not_run'});
    assert.equal(destination.files.find(f => f.path.endsWith('README.md')).content, 'EXISTING_WIDGET_STORE_SENTINEL\n');
  });
}
test('an unwired but structurally valid widget remains explicitly runtime-unverified', () => {
  const f = flutterWidgetFixture(); f.proposal.changes.pop();
  const r = draft(f); assert.equal(r.exportable, true); assert.equal(r.verification.integration, 'not_run');
});
test('bad destination imports retain the existing bounded-repair diagnostic', () => {
  const f = flutterWidgetFixture(); f.proposal.changes[0].content = f.proposal.changes[0].content.replace("import 'price.dart';", "import 'absent.dart';");
  assert.throws(() => draft(f), e => e instanceof ProposalValidationError && e.diagnostic.code === 'proposal_dart_import' && e.diagnostic.repairable);
});
test('missing transitive production mapping cannot be replaced by a test helper', () => {
  const f = flutterWidgetFixture(); f.proposal.changes.splice(1, 1);
  assert.throws(() => draft(f), e => e instanceof ProposalValidationError && e.diagnostic.code === 'proposal_dart_mapping');
});
test('platform-channel setup is still blocked rather than inferred from widget checks', () => {
  const f = flutterWidgetFixture(); f.sourceInput.files[1].content += '\nfinal channel = MethodChannel("native-cart");\n';
  const r = draft(f); assert.equal(r.exportable, false); assert.match(r.testTransfer.blockers.join(' '), /resource_or_platform_setup_required/);
});
test('provider-authored replacement tests remain forbidden', () => {
  const f = flutterWidgetFixture(); f.proposal.changes.push({path: 'test/fake_test.dart', action: 'add', content: 'void main() {}\n', reason: 'Fake replacement', sourcePaths: ['lib/cart_panel.dart']});
  const r = draft(f); assert.equal(r.exportable, false); assert.match(r.testTransfer.blockers.join(' '), /model_must_not_modify_tests/);
});
test('materialized controls change implementation only; host probes never enter the patch', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'repot-widget-core-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const result = await materializeFlutterWidgetFixture(path.join(parent, 'fresh'));
  assert.equal(result.packages.length, 7);
  const review = JSON.parse(await readFile(result.directory + '/review.json', 'utf8'));
  assert.equal(review.hostProbesInPatch, false); assert.equal(review.verification.tests, 'not_run');
  const patch = await readFile(result.directory + '/transfer.patch', 'utf8');
  assert.ok(!patch.includes('repot_acceptance_host_test.dart'));
  for (const placement of review.testTransfer.placements) {
    const p = placement.destinationPath;
    const positive = await readFile(result.directory + '/host-positive/' + p, 'utf8');
    for (const control of ['host-missing-route', 'host-broken-update', 'host-missing-dispose']) assert.equal(await readFile(result.directory + '/' + control + '/' + p, 'utf8'), positive);
  }
  await assert.rejects(materializeFlutterWidgetFixture(result.directory), {code: 'EEXIST'});
});
test('real Git applies the widget transfer and changes only the intended existing host file', async t => {
  const {destination, review} = await buildWidgetTransfer();
  const root = await mkdtemp(path.join(os.tmpdir(), 'repot-widget-git-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const f of destination.files) {const p = path.join(root, f.path); await mkdir(path.dirname(p), {recursive: true}); await writeFile(p, f.content);}
  function git(args, input) {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', input, timeout: 10000,
      env: {PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0'}});
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  }
  git(['-c', 'init.defaultBranch=main', 'init', '-q']); git(['add', '--all']);
  git(['apply', '--check', '--index'], review.patch); git(['apply', '--index'], review.patch);
  for (const f of destination.files.filter(f => f.path !== 'lib/main.dart')) assert.equal(await readFile(path.join(root, f.path), 'utf8'), f.content);
  for (const c of review.changes) assert.equal(await readFile(path.join(root, c.path), 'utf8'), c.content);
});
