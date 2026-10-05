/** Authored minimal regressions matching the real CI reporter shapes, not native execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateTestEvidence, parseTestEvents} from './flutter-widget-evidence.mjs';

const name = 'host: cart route renders and updates pricing';
const notice = [{event: 'test.startedProcess', params: {vmServiceUri: null}}];
const encode = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
function report(events, negative = true) {
  return {status: negative ? 'failed' : 'passed', exitCode: negative ? 1 : 0,
    signal: null, error: null, stdout: encode(events), stderr: ''};
}
function positive() {
  return [{type: 'start', protocolVersion: '0.1.1'},
    {type: 'testStart', test: {id: 1, name}}, notice,
    {type: 'testDone', testID: 1, result: 'success', skipped: false, hidden: false},
    {type: 'done', success: true}];
}
function flutterFailure() {
  // Same wrapper/classification/layout as run 37252936076; path and stack shortened.
  const message = `══╡ EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK ╞══════════════
The following TestFailure was thrown running a test:
Expected: exactly one matching candidate
  Actual: _TextWidgetFinder:<Found 0 widgets with text "Cart": []>
   Which: means none were found but one was expected

When the exception was thrown, this was the stack:
#4 main.<anonymous closure> (file:///authored/test/host_test.dart:10:5)

This was caught by the test expectation on the following line:
  file:///authored/test/host_test.dart line 10
The test description was:
  ${name}
════════════════════════════════════════════════════════════`;
  return [{type: 'start', protocolVersion: '0.1.1'},
    {type: 'testStart', test: {id: 1, name}}, notice,
    {type: 'print', testID: 1, messageType: 'print', message},
    {type: 'error', testID: 1, isFailure: false,
      error: 'Test failed. See exception logs above.\nThe test description was: ' + name, stackTrace: ''},
    {type: 'testDone', testID: 1, result: 'error', skipped: false, hidden: false},
    {type: 'done', success: false}];
}
const evaluate = events => evaluateTestEvidence(report(events), [name], [name]);

test('interleaved Flutter daemon notification does not hide positive test evidence', () => {
  const r = evaluateTestEvidence(report(positive(), false), [name]);
  assert.equal(r.status, 'passed'); assert.equal(r.daemonNotifications, 1);
});
test('same-test Flutter TestFailure print plus wrapped error is an expected assertion', () => {
  const r = evaluate(flutterFailure());
  assert.equal(r.status, 'expected_failure_observed');
  assert.equal(r.assertionKinds[name], 'flutter-framework-TestFailure');
});
for (const [label, change] of [
  ['missing exception print', e => e.filter(x => x.type !== 'print')],
  ['runtime StateError', e => e.map(x => x.type === 'print' ? {...x, message: x.message.replace('following TestFailure', 'following StateError')} : x)],
  ['runtime FlutterError', e => e.map(x => x.type === 'print' ? {...x, message: x.message.replace('following TestFailure', 'following FlutterError')} : x)],
  ['missing Expected Actual evidence', e => e.map(x => x.type === 'print' ? {...x, message: x.message.replace('Expected:', 'Failure:')} : x)],
  ['wrong test description', e => e.map(x => x.type === 'print' ? {...x, message: x.message.replace('\n  ' + name + '\n', '\n  other test\n')} : x)],
  ['wrong error wrapper', e => e.map(x => x.type === 'error' ? {...x, error: 'SDK disconnected'} : x)],
  ['wrong wrapper test name', e => e.map(x => x.type === 'error' ? {...x, error: x.error.replace(name, 'other')} : x)],
  ['nonstring error', e => e.map(x => x.type === 'error' ? {...x, error: {message: 'bad'}} : x)],
  ['unrelated second error', e => [...e.slice(0, 5), {...e[4], error: 'late StateError'}, ...e.slice(5)]],
  ['error before diagnostic', e => [e[0], e[1], e[2], e[4], e[3], e[5], e[6]]],
  ['diagnostic after completion', e => [e[0], e[1], e[2], e[4], e[5], e[3], e[6]]],
  ['error after completion', e => [e[0], e[1], e[2], e[3], e[5], e[4], e[6]]],
  ['second framework exception', e => [...e.slice(0, 4), {...e[3], message: e[3].message.replace('TestFailure', 'StateError')}, ...e.slice(4)]],
  ['missing expectation location', e => e.map(x => x.type === 'print' ? {...x, message: x.message.replace('host_test.dart line 10', 'production.dart line 10')} : x)],
  ['exception from unknown test ID', e => e.map(x => x.type === 'print' ? {...x, testID: 99} : x)],
]) {
  test('wrapped-error control is rejected: ' + label, () => assert.equal(evaluate(change(flutterFailure())).status, 'failed'));
}
test('a diagnostic from another completed test cannot satisfy the target control', () => {
  const e = flutterFailure();
  e.splice(2, 0, {type: 'testStart', test: {id: 2, name: 'other'}});
  e.find(x => x.type === 'print').testID = 2;
  e.splice(e.length - 1, 0, {type: 'testDone', testID: 2, result: 'success', skipped: false, hidden: true});
  assert.equal(evaluate(e).status, 'failed');
});
test('a swallowed framework exception invalidates a positive test', () => {
  const e = positive(); e.splice(3, 0, flutterFailure()[3]);
  assert.equal(evaluateTestEvidence(report(e, false), [name]).status, 'failed');
});
for (const envelope of [[], [{type: 'testDone', result: 'success'}],
  [{event: 'test.error', params: {vmServiceUri: null}}],
  [{event: 'test.startedProcess', params: {vmServiceUri: null}, error: 'ignored?'}],
  [{event: 'test.startedProcess', params: {vmServiceUri: 5}}],
  [{event: 'test.startedProcess', params: {vmServiceUri: null, result: 'success'}}]]) {
  test('unknown/unsafe daemon envelope is not silently ignored: ' + JSON.stringify(envelope), () => {
    const e = positive(); e[2] = envelope;
    assert.equal(evaluateTestEvidence(report(e, false), [name]).status, 'failed');
  });
}
test('notifications before start or after completion cannot replace reporter evidence', () => {
  assert.throws(() => parseTestEvents(encode([notice, ...positive()])), /notification/);
  assert.throws(() => parseTestEvents(encode([...positive(), notice])), /notification/);
});
