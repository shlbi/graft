/**
 * Fail-closed evidence reader for authored Flutter tests, not a general test protocol implementation.
 * Tracks late errors and skipped/hidden tests. Neither exit zero nor a generic failure is enough.
 * Protocol: dart-lang/test pkgs/test/doc/json_reporter.md.
 */
export function parseTestEvents(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 262144) throw new Error('Invalid machine output budget.');
  const tests = new Map(); let start = null, done = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!line.trimStart().startsWith('{')) {
      if (start) throw new Error('Non-JSON output interrupted the reporter.');
      continue; // Flutter may emit dependency/toolchain notices before the reporter begins.
    }
    const event = JSON.parse(line);
    if (!event || typeof event.type !== 'string' || done) throw new Error('Malformed or post-completion event.');
    if (event.type === 'start') {
      if (start || typeof event.protocolVersion !== 'string' || !event.protocolVersion.startsWith('0.1.')) throw new Error('Unsupported or duplicate protocol start.');
      start = event;
    } else {
      if (!start) throw new Error('Missing protocol start.');
      if (event.type === 'testStart') {
        const t = event.test;
        if (!t || !Number.isInteger(t.id) || typeof t.name !== 'string' || tests.has(t.id)) throw new Error('Invalid or duplicate test identity.');
        tests.set(t.id, {id: t.id, name: t.name, errors: [], completion: null});
      } else if (event.type === 'testDone' || event.type === 'error') {
        const t = tests.get(event.testID);
        if (!t) throw new Error('Event references an unknown test.');
        if (event.type === 'error') {
          if (typeof event.isFailure !== 'boolean') throw new Error('Unknown error classification.');
          t.errors.push({isFailure: event.isFailure});
        } else {
          if (t.completion || !['success', 'failure', 'error'].includes(event.result) ||
              typeof event.hidden !== 'boolean' || typeof event.skipped !== 'boolean') throw new Error('Invalid test completion.');
          t.completion = {result: event.result, hidden: event.hidden, skipped: event.skipped};
        }
      } else if (event.type === 'done') {
        if (typeof event.success !== 'boolean') throw new Error('Incomplete test run.');
        done = event;
      }
      // Other protocol events (suite/group/debug/print) carry no acceptance decision.
    }
  }
  if (!start || !done || [...tests.values()].some(t => !t.completion)) throw new Error('Incomplete machine evidence.');
  return {success: done.success, protocolVersion: start.protocolVersion, tests: [...tests.values()]};
}

/** Negative controls require the exact expected assertion failures, not a build/SDK crash. */
export function evaluateTestEvidence(command, expected, expectedFailures = []) {
  const failed = reason => ({status: 'failed', reason, passedTests: [], assertionFailures: []});
  if (!Array.isArray(expected) || !expected.length || expected.some(n => typeof n !== 'string' || !n) ||
      new Set(expected).size !== expected.length || !Array.isArray(expectedFailures) ||
      new Set(expectedFailures).size !== expectedFailures.length || expectedFailures.some(n => !expected.includes(n))) return failed('Invalid authored test expectations.');
  const negative = expectedFailures.length > 0;
  if (!command || command.signal || command.error ||
      (negative ? command.status !== 'failed' || !Number.isInteger(command.exitCode) || command.exitCode <= 0
        : command.status !== 'passed' || command.exitCode !== 0)) return failed('Unexpected process outcome; not matching test evidence.');
  let parsed;
  try { parsed = parseTestEvents(command.stdout); } catch (error) { return failed(error.message); }
  if (parsed.success !== !negative) return failed('Reporter outcome does not match the control.');
  const visible = parsed.tests.filter(t => !t.completion.hidden || t.errors.length);
  if (parsed.tests.some(t => t.completion.skipped) || visible.length !== expected.length ||
      new Set(visible.map(t => t.name)).size !== visible.length || visible.some(t => !expected.includes(t.name))) return failed('Missing, duplicate, unexpected, or skipped tests.');
  const passedTests = [], assertionFailures = [];
  for (const t of visible) {
    if (expectedFailures.includes(t.name)) {
      if (t.completion.result !== 'failure' || !t.errors.length || t.errors.some(e => !e.isFailure)) return failed('Control did not fail with the expected assertion.');
      assertionFailures.push(t.name);
    } else {
      if (t.completion.result !== 'success' || t.errors.length) return failed('An unrelated test failed or emitted a late error.');
      passedTests.push(t.name);
    }
  }
  return {status: negative ? 'expected_failure_observed' : 'passed', protocolVersion: parsed.protocolVersion, passedTests, assertionFailures};
}
