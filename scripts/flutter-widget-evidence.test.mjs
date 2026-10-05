/** Reporter/harness tests use explicit SDK doubles; no native runtime success is implied. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {parseTestEvents, evaluateTestEvidence} from './flutter-widget-evidence.mjs';
import {checkPreservation, parseWidgetArgs, verifyFlutterWidgetFixture} from './verify-flutter-widget-fixture.mjs';
import {replaceExactly} from './materialize-flutter-widget-fixture.mjs';
import {flutterWidgetFixture, WIDGET_TEST_NAMES} from '../web/test/fixtures/flutter-widget-fixture.mjs';

function events(names = ['one'], failures = []) {
  return [{type: 'start', protocolVersion: '0.1.1'},
    ...names.flatMap((name, id) => [{type: 'testStart', test: {id, name}},
      ...(failures.includes(name) ? [{type: 'error', testID: id, isFailure: true}] : []),
      {type: 'testDone', testID: id, result: failures.includes(name) ? 'failure' : 'success', skipped: false, hidden: false}]),
    {type: 'done', success: !failures.length}];
}
const encode = e => e.map(x => JSON.stringify(x)).join('\n') + '\n';
const command = (e = events(), negative = false) => ({status: negative ? 'failed' : 'passed', exitCode: negative ? 1 : 0, signal: null, error: null, stdout: encode(e), stderr: ''});

test('success requires the exact completed test names', () => {
  assert.equal(evaluateTestEvidence(command(), ['one']).status, 'passed');
  assert.equal(evaluateTestEvidence(command(), ['other']).status, 'failed');
});
test('control assertion failures are reported separately from successful tests', () => {
  const r = evaluateTestEvidence(command(events(['one', 'two'], ['two']), true), ['one', 'two'], ['two']);
  assert.equal(r.status, 'expected_failure_observed'); assert.deepEqual(r.passedTests, ['one']); assert.deepEqual(r.assertionFailures, ['two']);
});
for (const kind of ['timeout', 'spawn_error', 'output_limit']) {
  test(`${kind} cannot pass a negative control`, () => {
    assert.equal(evaluateTestEvidence({...command(events(['one'], ['one']), true), status: kind}, ['one'], ['one']).status, 'failed');
  });
}
for (const [name, mutate] of [
  ['missing start', e => e.slice(1)],
  ['missing done', e => e.slice(0, -1)],
  ['incomplete done', e => e.map(x => x.type === 'done' ? {...x, success: null} : x)],
  ['future protocol', e => e.map(x => x.type === 'start' ? {...x, protocolVersion: '1.0.0'} : x)],
  ['duplicate start', e => [e[0], ...e]],
  ['duplicate test', e => [...e.slice(0, 2), e[1], ...e.slice(2)]],
  ['duplicate completion', e => [...e.slice(0, 3), e[2], ...e.slice(3)]],
  ['post-completion event', e => [...e, {type: 'print'}]],
  ['unknown test ID', e => e.map(x => x.type === 'testDone' ? {...x, testID: 99} : x)],
  ['missing completion', e => e.filter(x => x.type !== 'testDone')],
  ['invalid test result', e => e.map(x => x.type === 'testDone' ? {...x, result: 'maybe'} : x)],
]) {
  test(`malformed stream fails: ${name}`, () => assert.equal(evaluateTestEvidence(command(mutate(events())), ['one']).status, 'failed'));
}
test('skipped tests cannot pass even when exit code and done are successful', () => {
  const e = events().map(x => x.type === 'testDone' ? {...x, skipped: true} : x);
  assert.equal(evaluateTestEvidence(command(e), ['one']).status, 'failed');
});
test('a late error invalidates a previously successful test', () => {
  const e = events(); e.splice(e.length - 1, 0, {type: 'error', testID: 0, isFailure: true});
  assert.equal(evaluateTestEvidence(command(e), ['one']).status, 'failed');
});
test('expected controls reject infrastructure/non-assertion errors', () => {
  const e = events(['one'], ['one']).map(x => x.type === 'error' ? {...x, isFailure: false} : x);
  assert.equal(evaluateTestEvidence(command(e, true), ['one'], ['one']).status, 'failed');
});
test('unexpected assertion failure cannot satisfy a differently named control', () => {
  assert.equal(evaluateTestEvidence(command(events(['one', 'two'], ['two']), true), ['one', 'two'], ['one']).status, 'failed');
});
test('empty/duplicate expected tests are refused', () => {
  for (const expected of [[], ['one', 'one'], ['']]) assert.equal(evaluateTestEvidence(command(), expected).status, 'failed');
});
test('a positive exit cannot satisfy a negative expectation', () => {
  assert.equal(evaluateTestEvidence(command(), ['one'], ['one']).status, 'failed');
});
test('only successful hidden loader events are excluded from test counts', () => {
  const e = events(); e.splice(1, 0, {type: 'testStart', test: {id: 50, name: 'loader'}}, {type: 'testDone', testID: 50, result: 'success', hidden: true, skipped: false});
  assert.equal(evaluateTestEvidence(command(e), ['one']).status, 'passed');
  e.splice(e.length - 1, 0, {type: 'error', testID: 50, isFailure: false});
  assert.equal(evaluateTestEvidence(command(e), ['one']).status, 'failed');
});
test('Flutter preamble is permitted only before the reporter begins', () => {
  assert.equal(parseTestEvents('Resolving dependencies...\n' + encode(events())).success, true);
  assert.throws(() => parseTestEvents(encode(events().slice(0, 1)) + 'bad\n' + encode(events().slice(1))), /interrupted/);
});
test('reporter input budget and malformed JSON fail closed', () => {
  assert.throws(() => parseTestEvents('x'.repeat(262145)), /budget/);
  assert.throws(() => parseTestEvents('{broken JSON}'));
});
test('signal and missing assertion-error events cannot satisfy a negative control', () => {
  assert.equal(evaluateTestEvidence({...command(events(['one'], ['one']), true), signal: 'SIGKILL'}, ['one'], ['one']).status, 'failed');
  assert.equal(evaluateTestEvidence(command(events(['one'], ['one']).filter(e => e.type !== 'error'), true), ['one'], ['one']).status, 'failed');
});
test('authored fixtures contain valid Dart interpolation, four widget tests and explicit host integration', () => {
  const f = flutterWidgetFixture();
  assert.match(f.proposal.changes[0].content, /Text\('Total: \$\{priceFor\(units\)\}'\)/);
  assert.equal((f.sourceInput.files.find(f => f.path === 'test/cart_panel_test.dart').content.match(/testWidgets\(/g) ?? []).length, 4);
  assert.match(f.proposal.changes[2].content, /Widget cartPage\(\) => const CartPanel\(\)/);
  assert.equal(WIDGET_TEST_NAMES.length, 4);
});
test('fixture package roots cannot escape or become ambiguous', () => {
  for (const sourceRoot of ['..', '/tmp', 'foo/../bar', 'foo\\bar', 5]) assert.throws(() => flutterWidgetFixture({sourceRoot}), /Invalid/);
  assert.equal(flutterWidgetFixture({sourceRoot: 'packages/donor'}).sourceInput.files[0].path, 'packages/donor/pubspec.yaml');
});
test('control mutation requires exactly one implementation span', () => {
  assert.equal(replaceExactly('a b c', 'b', 'B'), 'a B c');
  assert.throws(() => replaceExactly('a b b', 'b', 'B'), /exactly once/);
  assert.throws(() => replaceExactly('a', 'b', 'B'), /exactly once/);
});
test('widget CLI accepts only a new directory and explicit execution', () => {
  assert.deepEqual(parseWidgetArgs(['new', '--execute']), {output: 'new', allowExecution: true});
  for (const args of [[], ['new'], ['new', '--flutter'], ['new', '--execute', '--execute']]) assert.throws(() => parseWidgetArgs(args), /Usage/);
});

const phases = ['source', 'destination-before', 'destination-after', 'host-positive', 'host-missing-route', 'host-broken-update', 'host-missing-dispose'];
async function setup(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'repot-widget-harness-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const output = path.join(parent, 'fresh'), calls = [];
  const packages = phases.map((name, i) => ({name, expected: ['one'], expectedFailures: i >= 4 ? ['one'] : []}));
  async function materialize(directory) {
    await mkdir(directory); const originalFiles = {};
    for (const name of [...phases, '']) {
      if (name) await mkdir(path.join(directory, name));
      const p = name ? name + '/pubspec.yaml' : 'review.json';
      const content = name ? 'name: authored\n' : '{"verification":{"tests":"not_run"}}\n';
      await writeFile(path.join(directory, p), content);
      originalFiles[p] = createHash('sha256').update(content).digest('hex');
    }
    return {directory, packages, originalFiles};
  }
  const environment = async root => ({PATH: process.env.PATH, HOME: root + '/home', TMPDIR: root + '/tmp', PUB_CACHE: root + '/cache', CI: 'true'});
  async function execute(cmd, args, opts) {
    calls.push({cmd, args, opts});
    if (args[0] === '--version') return {...command(), stdout: 'Flutter 3.47.6\nDart 3.13.5\n'};
    if (args[0] !== 'test') return {...command(), stdout: 'ok\n'};
    const p = packages.find(p => p.name === path.basename(opts.cwd));
    return command(events(p.expected, p.expectedFailures), p.expectedFailures.length > 0);
  }
  return {output, options: {output, allowExecution: true}, calls, materialize, execute, environment};
}
test('execution without explicit consent does not write or run commands', async t => {
  const f = await setup(t); await assert.rejects(verifyFlutterWidgetFixture({output: f.output}, f), /--execute/); assert.equal(f.calls.length, 0);
});
test('all seven phases need matching evidence and leave structural review unchanged', async t => {
  const f = await setup(t), {report} = await verifyFlutterWidgetFixture(f.options, f);
  assert.equal(report.status, 'passed'); assert.equal(f.calls.length, 22);
  assert.equal(report.preservation.checkedFiles, 8); assert.equal(report.verification.device, 'not_run');
  assert.equal(report.packages.filter(p => p.evidence.status === 'expected_failure_observed').length, 3);
  assert.equal(JSON.parse(await readFile(f.output + '/review.json', 'utf8')).verification.tests, 'not_run');
});
test('missing SDK blocks all package execution and rendering claims', async t => {
  const f = await setup(t), {report} = await verifyFlutterWidgetFixture(f.options, {...f, execute: async () => ({...command(), status: 'spawn_error', exitCode: null, stdout: ''})});
  assert.equal(report.status, 'blocked'); assert.ok(report.packages.every(p => p.tests.status === 'not_run'));
  assert.equal(report.verification.widgetBehavior, 'not_run');
});
test('compile/analysis failure never substitutes for an expected assertion failure', async t => {
  const f = await setup(t), {report} = await verifyFlutterWidgetFixture(f.options, {...f, execute: async (cmd, args, opts) => {
    const r = await f.execute(cmd, args, opts); return args[0] === 'analyze' && opts.cwd.endsWith('host-missing-route') ? {...r, status: 'failed', exitCode: 1} : r;
  }});
  assert.equal(report.status, 'failed'); assert.equal(report.verification.controlSensitivity, 'failed');
});
test('dependency failure skips that package but records remaining checks', async t => {
  const f = await setup(t), {report} = await verifyFlutterWidgetFixture(f.options, {...f, execute: async (cmd, args, opts) => {
    const r = await f.execute(cmd, args, opts); return args[0] === 'pub' && opts.cwd.endsWith('/source') ? {...r, status: 'failed', exitCode: 1} : r;
  }});
  assert.equal(report.status, 'failed'); assert.equal(f.calls.length, 20); assert.equal(report.packages[0].tests.status, 'not_run');
});
test('mutation of original assertions/evidence fails acceptance', async t => {
  const f = await setup(t), {report} = await verifyFlutterWidgetFixture(f.options, {...f, execute: async (...args) => {
    const r = await f.execute(...args); await writeFile(f.output + '/review.json', 'FORGED'); return r;
  }});
  assert.equal(report.status, 'failed'); assert.equal(report.preservation.status, 'failed');
});
test('existing directory is refused and untouched', async t => {
  const f = await setup(t); await mkdir(f.output); await writeFile(f.output + '/keep', 'KEEP');
  await assert.rejects(verifyFlutterWidgetFixture(f.options, f), {code: 'EEXIST'});
  assert.equal(await readFile(f.output + '/keep', 'utf8'), 'KEEP'); assert.equal(f.calls.length, 0);
});
test('preservation rejects symlink parents without reading their target', async t => {
  const f = await setup(t); const fixture = await f.materialize(f.output);
  await rm(f.output + '/source', {recursive: true}); await symlink(f.output + '/destination-before', f.output + '/source');
  const r = await checkPreservation(f.output, fixture.originalFiles);
  assert.equal(r.status, 'failed'); assert.ok(r.changes.some(c => c.path === 'source/pubspec.yaml'));
});
