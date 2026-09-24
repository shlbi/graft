/** Evidence checks for original, synthetic runner-acceptance fixtures only. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const digest = text => createHash('sha256').update(text).digest('hex');
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export function discoverRunners(base = new URL('./package.json', import.meta.url)) {
  const require = createRequire(base), runners = {}, blockers = [];
  const root = dirname(base instanceof URL ? fileURLToPath(base) : base);
  for (const name of ['jest', 'vitest']) {
    try {
      const filename = require.resolve(name + '/package.json');
      ensure(filename === resolve(root, 'node_modules', name, 'package.json'), `${name} must be installed in the acceptance directory.`);
      const raw = readFileSync(filename, 'utf8'), pkg = JSON.parse(raw);
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[name];
      ensure(pkg.name === name && typeof pkg.version === 'string' && typeof bin === 'string', `Invalid ${name} package metadata.`);
      const entry = resolve(dirname(filename), bin);
      const entryBytes = readFileSync(entry);
      runners[name] = { name, version: pkg.version, entry, packageFile: filename,
        packageHash: digest(raw), entryHash: digest(entryBytes) };
    } catch (error) {
      blockers.push(`${name}: ${error.code ?? 'INVALID_PACKAGE'}; a real installed runner is required.`);
    }
  }
  return { status: blockers.length ? 'blocked' : 'ready', runners, blockers };
}

/** No zero-test, skipped-test, or runner-error result can count as a behavioral pass. */
export function verifyReport(report, exitCode, expectedNames, { negative = false, mustFail = [] } = {}) {
  ensure(report && typeof report === 'object' && !Array.isArray(report), 'Missing runner JSON report.');
  ensure(Array.isArray(expectedNames) && expectedNames.length > 0 && new Set(expectedNames).size === expectedNames.length, 'Expected test identities must be nonempty and unique.');
  ensure(Array.isArray(report.testResults) && report.testResults.length > 0, 'No test-file results.');
  const cases = report.testResults.flatMap(file => {
    ensure(Array.isArray(file.assertionResults), 'Missing assertion results.');
    ensure(!file.testExecError && !file.failureMessage?.includes('Test suite failed to run'), 'A runner/import error is not an assertion failure.');
    return file.assertionResults.map(item => ({
      name: item.fullName ?? [...(item.ancestorTitles ?? []), item.title].join(' '),
      status: item.status, failureMessages: item.failureMessages ?? []
    }));
  });
  ensure(cases.length === expectedNames.length, 'Unexpected test count; a test may be missing or duplicated.');
  ensure(JSON.stringify(cases.map(c => c.name).sort()) === JSON.stringify([...expectedNames].sort()), 'Test identities changed or were not discovered.');
  ensure(cases.every(c => ['passed', 'failed'].includes(c.status)), 'Skipped, todo, pending, or unknown test status.');
  const passed = cases.filter(c => c.status === 'passed').length, failed = cases.length - passed;
  ensure(report.numTotalTests === cases.length && report.numPassedTests === passed && report.numFailedTests === failed, 'Runner counters disagree with assertion results.');
  for (const key of ['numPendingTests', 'numTodoTests', 'numRuntimeErrorTestSuites']) ensure((report[key] ?? 0) === 0, 'Skipped tests or runtime errors are not accepted.');
  if (negative) {
    ensure(exitCode === 1 && failed > 0 && report.success === false, 'Negative control did not fail as an ordinary test failure.');
    ensure(mustFail.length > 0, 'Negative control must name the assertions it is exercising.');
    ensure(cases.filter(c => !mustFail.includes(c.name)).every(c => c.status === 'passed'), 'Negative control also broke an unrelated regression test.');
    for (const name of mustFail) {
      const item = cases.find(c => c.name === name);
      ensure(item?.status === 'failed' && item.failureMessages.some(m => typeof m === 'string' && m.length), `Negative control did not fail the expected assertion: ${name}`);
    }
  } else ensure(exitCode === 0 && failed === 0 && report.success === true, 'Acceptance tests failed.');
  return { status: negative ? 'expected_failure' : 'passed', exitCode, tests: cases.length, passed, failed,
    skipped: 0, cases: cases.map(({ name, status }) => ({ name, status })) };
}
