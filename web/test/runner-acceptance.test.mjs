// Gate-policy tests, NOT Jest/Vitest execution and NOT a substitute for the acceptance run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReport, discoverRunners } from '../acceptance/evidence.mjs';
import { runnerFixture } from '../acceptance/fixtures.mjs';
import { runProcess } from '../acceptance/process.mjs';
function report(statuses = ['passed', 'passed']) {
  return { success: statuses.every(s => s === 'passed'), numTotalTests: 2,
    numPassedTests: statuses.filter(s => s === 'passed').length, numFailedTests: statuses.filter(s => s === 'failed').length,
    numPendingTests: 0, numTodoTests: 0, testResults: [{ assertionResults: statuses.map((status, i) => ({ fullName: ['feature', 'regression'][i], status, failureMessages: status === 'failed' ? ['expected behavior was not observed'] : [] })) }] };
}
const names = ['feature', 'regression'];
test('gate accepts complete passing identities and consistent real-runner-shaped counters', () => {
  assert.equal(verifyReport(report(), 0, names).passed, 2);
});
test('gate rejects a green zero-test result', () => {
  assert.throws(() => verifyReport({ success: true, numTotalTests: 0, testResults: [] }, 0, names), /No test-file/);
});
test('gate rejects missing, renamed and duplicated tests', () => {
  for (const replacement of ['other', 'feature']) {
    const r = report(); r.testResults[0].assertionResults[1].fullName = replacement;
    assert.throws(() => verifyReport(r, 0, names), /identities/);
  }
});
test('gate rejects skips and counter inflation', () => {
  assert.throws(() => verifyReport(report(['passed', 'pending']), 0, names), /Skipped/);
  const r = report(); r.numPassedTests = 3; assert.throws(() => verifyReport(r, 0, names), /counters/);
});
test('gate rejects exit errors even with green JSON', () => {
  for (const code of [1, null, 137]) assert.throws(() => verifyReport(report(), code, names), /failed/);
});
test('negative control requires the expected assertion failure, not a crash', () => {
  const options = { negative: true, mustFail: ['feature'] };
  assert.equal(verifyReport(report(['failed', 'passed']), 1, names, options).status, 'expected_failure');
  assert.throws(() => verifyReport(report(['passed', 'failed']), 1, names, options), /unrelated regression/);
  const r = report(['failed', 'passed']); r.numRuntimeErrorTestSuites = 1;
  assert.throws(() => verifyReport(r, 1, names, options), /runtime errors/);
  assert.throws(() => verifyReport(report(['failed', 'passed']), 2, names, options), /ordinary test failure/);
});
test('negative control rejects missing failure details and suite import errors', () => {
  const r = report(['failed', 'passed']); r.testResults[0].assertionResults[0].failureMessages = [];
  assert.throws(() => verifyReport(r, 1, names, { negative: true, mustFail: ['feature'] }), /expected assertion/);
  r.testResults[0].testExecError = { message: 'cannot import' };
  assert.throws(() => verifyReport(r, 1, names), /runner\/import error/);
});
test('fixture catalog has named, global and setup cases with preserved destination regression', () => {
  for (const kind of ['named-imports', 'global-apis', 'shared-setup']) {
    const f = runnerFixture(kind, { jest: 'metadata-only', vitest: 'metadata-only' });
    assert.equal(f.sourceTestNames.length, 2); assert.equal(f.destinationTestNames.length, 1);
    assert.equal(f.proposal.changes.length, 1); assert.equal(f.proposal.changes[0].path, 'lib/greeting.js');
    assert.equal(f.source.files.some(x => x.path === 'test/setup.js'), kind === 'shared-setup');
  }
  assert.throws(() => runnerFixture('uploaded-repository', {}), /Unknown/);
});
test('runner discovery reports missing packages without installing or simulating them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graft-runner-preflight-'));
  try {
    const r = discoverRunners(pathToFileURL(join(dir, 'package.json')));
    assert.equal(r.status, 'blocked'); assert.equal(r.blockers.length, 2); assert.deepEqual(r.runners, {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('fixture process helper captures exit status and does not inherit provider keys', async () => {
  const r = await runProcess(process.execPath, ['-e', "console.log(JSON.stringify({key:process.env.GRAFT_ACCEPTANCE_SENTINEL,opts:process.env.NODE_OPTIONS})); process.exitCode=3"], tmpdir());
  assert.equal(r.exitCode, 3); assert.deepEqual(JSON.parse(r.stdout), {});
});
test('fixture process helper stops excessive output', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))"], tmpdir(), { maxBytes: 100 }), /output limit/);
});
test('fixture process helper stops a hanging process', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], tmpdir(), { timeout: 150 }), /exceeded/);
});

test('negative control cannot hide a broken destination regression', () => {
  assert.throws(() => verifyReport(report(['failed', 'failed']), 1, names, { negative: true, mustFail: ['feature'] }), /unrelated regression/);
});
