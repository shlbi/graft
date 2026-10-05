/**
 * Scoped reader for authored Flutter fixtures, not an adversarial-log authenticity verifier.
 * Flutter interleaves daemon notifications and wraps widget TestFailure exceptions.
 * Those forms must be correlated, never treated as blanket permission to ignore errors.
 */
function isFlutterAssertion(message, name) {
  return message.startsWith('══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞') &&
    /\nThe following TestFailure was thrown running a test:\nExpected: [\s\S]+\n\s+Actual: /.test(message) &&
    message.includes('\nWhen the exception was thrown, this was the stack:\n') &&
    /\nThis was caught by the test expectation on the following line:\n\s+file:\/\/[^\n]+_test\.dart line \d+\n/.test(message) &&
    message.includes('\nThe test description was:\n  ' + name + '\n') && /\n═+\s*$/.test(message);
}

export function parseTestEvents(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 262144) throw new Error('Invalid machine output budget.');
  const tests = new Map(); let start = null, done = null, daemonNotifications = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^[{[]/.test(line.trimStart())) {
      if (start) throw new Error('Non-JSON output interrupted the reporter.');
      continue; // Toolchain notices may precede the machine reporter.
    }
    const event = JSON.parse(line);
    if (Array.isArray(event)) {
      // This is Flutter's separate daemon envelope, not an array of test results.
      if (!start || done || !event.length || event.length > 16 || event.some(e =>
        !e || Object.keys(e).sort().join(',') !== 'event,params' || e.event !== 'test.startedProcess' ||
        !e.params || Object.keys(e.params).join(',') !== 'vmServiceUri' ||
        !(e.params.vmServiceUri === null || typeof e.params.vmServiceUri === 'string'))) {
        throw new Error('Unsupported Flutter daemon notification.');
      }
      daemonNotifications += event.length;
      continue;
    }
    if (!event || typeof event.type !== 'string' || done) throw new Error('Malformed or post-completion event.');
    if (event.type === 'start') {
      if (start || typeof event.protocolVersion !== 'string' || !/^0\.1\.\d+$/.test(event.protocolVersion)) throw new Error('Unsupported or duplicate protocol start.');
      start = event;
    } else {
      if (!start) throw new Error('Missing protocol start.');
      if (event.type === 'testStart') {
        const t = event.test;
        if (!t || !Number.isInteger(t.id) || typeof t.name !== 'string' || tests.has(t.id)) throw new Error('Invalid or duplicate test identity.');
        tests.set(t.id, {id: t.id, name: t.name, errors: [], diagnostics: [], completion: null});
      } else if (['testDone', 'error', 'print'].includes(event.type)) {
        const t = tests.get(event.testID);
        if (!t) throw new Error('Event references an unknown test.');
        if (event.type === 'print') {
          if (typeof event.message !== 'string' || event.messageType !== 'print') throw new Error('Invalid printed test diagnostic.');
          if (event.message.startsWith('══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞')) {
            t.diagnostics.push({assertion: isFlutterAssertion(event.message, t.name), late: !!t.completion});
          }
        } else if (event.type === 'error') {
          if (typeof event.isFailure !== 'boolean') throw new Error('Unknown error classification.');
          t.errors.push({isFailure: event.isFailure, message: event.error, late: !!t.completion, priorDiagnostics: t.diagnostics.length});
        } else {
          if (t.completion || !['success', 'failure', 'error'].includes(event.result) ||
              typeof event.hidden !== 'boolean' || typeof event.skipped !== 'boolean' ||
              event.hidden && event.result !== 'success') throw new Error('Invalid test completion.');
          t.completion = {result: event.result, hidden: event.hidden, skipped: event.skipped};
        }
      } else if (event.type === 'done') {
        if (typeof event.success !== 'boolean') throw new Error('Incomplete test run.');
        done = event;
      } else if (!['suite', 'group', 'debug', 'allSuites'].includes(event.type)) {
        throw new Error('Unsupported machine reporter event.');
      }
    }
  }
  if (!start || !done || [...tests.values()].some(t => !t.completion)) throw new Error('Incomplete machine evidence.');
  return {success: done.success, protocolVersion: start.protocolVersion, daemonNotifications, tests: [...tests.values()]};
}

/** A wrapped widget failure needs a same-test TestFailure diagnostic BEFORE its error event. */
function assertionKind(t) {
  if (t.errors.some(e => e.late) || t.diagnostics.some(d => d.late)) return null;
  if (t.completion.result === 'failure' && t.errors.length && t.errors.every(e => e.isFailure) && !t.diagnostics.length) return 'dart-test-failure';
  const error = t.errors[0];
  if (t.completion.result === 'error' && t.errors.length === 1 && !error.isFailure &&
      typeof error.message === 'string' && error.message.trimEnd() === 'Test failed. See exception logs above.\nThe test description was: ' + t.name &&
      error.priorDiagnostics === 1 && t.diagnostics.length === 1 && t.diagnostics[0].assertion) return 'flutter-framework-TestFailure';
  return null;
}

/** Exact named controls, successful analysis, and matching process outcomes are all required. */
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
  const visible = parsed.tests.filter(t => !t.completion.hidden || t.errors.length || t.diagnostics.length);
  if (parsed.tests.some(t => t.completion.skipped) || visible.length !== expected.length ||
      new Set(visible.map(t => t.name)).size !== visible.length || visible.some(t => !expected.includes(t.name))) return failed('Missing, duplicate, unexpected, or skipped tests.');
  const passedTests = [], assertionFailures = [], assertionKinds = {};
  for (const t of visible) {
    if (expectedFailures.includes(t.name)) {
      const kind = assertionKind(t);
      if (!kind) return failed('Control did not fail with the expected assertion.');
      assertionFailures.push(t.name); assertionKinds[t.name] = kind;
    } else {
      if (t.completion.result !== 'success' || t.errors.length || t.diagnostics.length) return failed('An unrelated test failed or emitted a late error.');
      passedTests.push(t.name);
    }
  }
  return {status: negative ? 'expected_failure_observed' : 'passed', protocolVersion: parsed.protocolVersion,
    daemonNotifications: parsed.daemonNotifications, passedTests, assertionFailures, assertionKinds};
}
