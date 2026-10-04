/** Harness tests: provider/materializer/SDK doubles are not native runtime evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs, sdkEnvironment, runCommand, verifyDartFixture} from './verify-dart-fixture.mjs';

const names = ['source', 'destination-before', 'destination-after'];
const passed = {status: 'passed', exitCode: 0, signal: null, error: null, durationMs: 1, stdout: 'SDK 3.test\n', stderr: ''};
async function setup(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'repot-sdk-harness-'));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const output = path.join(parent, 'new-fixture'), calls = [];
  async function materialize(root) {
    await mkdir(root);
    for (const name of names) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, 'pubspec.yaml'), 'name: fixture\n');
    }
    await writeFile(path.join(root, 'review.json'), '{"verification":{"tests":"not_run"}}\n');
  }
  async function execute(command, args, options) { calls.push({command, args, ...options}); return {...passed, command, args}; }
  return {output, calls, materialize, execute, options: {output, allowExecution: true}};
}

test('CLI requires explicit execution and rejects unknown/duplicate flags', () => {
  for (const args of [[], ['folder'], ['folder', '--flutter'], ['folder', '--execute', '--anything'], ['folder', '--execute', '--execute']]) {
    assert.throws(() => parseArgs(args), /Usage/);
  }
  assert.deepEqual(parseArgs(['folder', '--execute', '--flutter']), {output: 'folder', allowExecution: true, flutter: true});
});
test('SDK environment omits secrets, registry overrides and inherited home', () => {
  const env = sdkEnvironment('/tmp/check', {PATH: '/usr/bin', HOME: '/private', OPENAI_API_KEY: 'never-pass', PUB_HOSTED_URL: 'https://bad.example'});
  assert.equal(env.PATH, '/usr/bin'); assert.equal(env.HOME, '/tmp/check/.sdk-home');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.PUB_HOSTED_URL, undefined);
});
test('no authorization means no writes or subprocess calls', async t => {
  const f = await setup(t);
  await assert.rejects(verifyDartFixture({output: f.output}, f), /--execute/);
  assert.equal(f.calls.length, 0);
});
test('Dart checks version plus all nine package commands and preserves structural evidence', async t => {
  const f = await setup(t), {report} = await verifyDartFixture(f.options, f);
  assert.equal(report.status, 'passed'); assert.equal(f.calls.length, 10);
  assert.ok(f.calls.every(c => c.command === 'dart'));
  for (let i = 0; i < 3; i++) assert.deepEqual(f.calls.slice(1 + 3*i, 4 + 3*i).map(c => c.args), [['pub', 'get'], ['analyze'], ['test']]);
  assert.equal(report.preservation.checkedFiles, 4);
  assert.equal(report.verification.nativeAppBuild, 'not_run'); assert.equal(report.verification.device, 'not_run');
  assert.equal(JSON.parse(await readFile(path.join(f.output, 'review.json'), 'utf8')).verification.tests, 'not_run');
  assert.equal(JSON.parse(await readFile(path.join(f.output, 'sdk-acceptance.json'), 'utf8')).status, 'passed');
});
test('Flutter uses the same three package checks with flutter only', async t => {
  const f = await setup(t), {report} = await verifyDartFixture({...f.options, flutter: true}, f);
  assert.equal(report.sdk, 'flutter'); assert.equal(report.status, 'passed');
  assert.ok(f.calls.every(c => c.command === 'flutter'));
});
test('existing output directory is refused before SDK execution', async t => {
  const f = await setup(t); await mkdir(f.output); await writeFile(path.join(f.output, 'user.txt'), 'KEEP');
  await assert.rejects(verifyDartFixture(f.options, f), {code: 'EEXIST'});
  assert.equal(f.calls.length, 0); assert.equal(await readFile(path.join(f.output, 'user.txt'), 'utf8'), 'KEEP');
});
for (const status of ['spawn_error', 'timeout', 'output_limit', 'failed']) {
  test(`unavailable version (${status}) blocks all package execution`, async t => {
    const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async (...args) => ({...await f.execute(...args), status, exitCode: null})});
    assert.equal(report.status, 'blocked'); assert.equal(f.calls.length, 1);
    assert.ok(report.packages.every(p => p.tests.status === 'not_run'));
    assert.equal(report.verification.tests, 'not_run');
  });
}
test('empty version output is not evidence of an available SDK', async t => {
  const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async () => ({...passed, stdout: ''})});
  assert.equal(report.status, 'blocked');
});
test('dependency failure skips only that package while keeping other evidence', async t => {
  const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async (cmd, args, opts) => {
    const r = await f.execute(cmd, args, opts);
    return opts.cwd.endsWith('/source') && args[0] === 'pub' ? {...r, status: 'failed', exitCode: 1} : r;
  }});
  assert.equal(report.status, 'failed'); assert.equal(report.packages[0].tests.status, 'not_run');
  assert.equal(report.packages[2].tests.status, 'passed'); assert.equal(f.calls.length, 8);
});
for (const step of ['analyze', 'test']) {
  test(`${step} failure cannot become a successful acceptance`, async t => {
    const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async (cmd, args, opts) => {
      const r = await f.execute(cmd, args, opts); return args[0] === step ? {...r, status: 'failed', exitCode: 1} : r;
    }});
    assert.equal(report.status, 'failed'); assert.equal(f.calls.length, 10);
    assert.equal(report.verification[step === 'test' ? 'tests' : 'analysis'], 'failed');
  });
}
test('SDK mutation of authored files fails preservation even with zero exit codes', async t => {
  const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async (...args) => {
    const r = await f.execute(...args);
    if (args[1][0] === 'test') await writeFile(path.join(args[2].cwd, 'pubspec.yaml'), 'MODIFIED');
    return r;
  }});
  assert.equal(report.status, 'failed'); assert.equal(report.preservation.changes.length, 3);
});
test('symlinked fixture packages are refused before commands', async t => {
  const f = await setup(t);
  await assert.rejects(verifyDartFixture(f.options, {...f, materialize: async root => {
    await f.materialize(root); await rm(path.join(root, 'source'), {recursive: true});
    await symlink(path.join(root, 'destination-before'), path.join(root, 'source'));
  }}), /real directory/);
  assert.equal(f.calls.length, 0);
});
test('unexpected executor errors produce explicit incomplete evidence', async t => {
  const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async () => {throw new Error('unexpected');}});
  assert.equal(report.status, 'failed'); assert.equal(report.verification.tests, 'incomplete');
});
test('invalid option budgets and modes are refused before any command', async t => {
  const f = await setup(t);
  for (const override of [{timeoutMs: 0}, {timeoutMs: Infinity}, {flutter: 'true'}, {output: ''}]) {
    await assert.rejects(verifyDartFixture({...f.options, ...override}, f), /Invalid/);
  }
  assert.equal(f.calls.length, 0);
});
test('real subprocess captures stdout, stderr and exit code', async () => {
  const r = await runCommand(process.execPath, ['-e', 'console.log("out");console.error("err");process.exitCode=7;']);
  assert.equal(r.status, 'failed'); assert.equal(r.exitCode, 7); assert.equal(r.stdout, 'out\n'); assert.equal(r.stderr, 'err\n');
});
test('real subprocess succeeds without shell interpolation', async () => {
  const r = await runCommand(process.execPath, ['-e', 'console.log(process.argv[1]);', '$(echo not-a-shell)']);
  assert.equal(r.status, 'passed'); assert.equal(r.stdout.trim(), '$(echo not-a-shell)');
});
test('real missing executable produces spawn_error', async () => {
  const r = await runCommand('/__repot_nonexistent_sdk__', []);
  assert.equal(r.status, 'spawn_error'); assert.equal(r.error, 'ENOENT'); assert.equal(r.exitCode, null);
});
test('real subprocess timeout is not a pass', async () => {
  const r = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeoutMs: 100});
  assert.equal(r.status, 'timeout'); assert.equal(r.exitCode, null);
});
test('real excessive subprocess output is bounded and fails', async () => {
  const r = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(50000));setInterval(()=>{},1000)'], {maxOutputBytes: 1024});
  assert.equal(r.status, 'output_limit'); assert.equal(Buffer.byteLength(r.stdout + r.stderr), 1024);
});
test('command validation rejects invalid budgets and null bytes', async () => {
  await assert.rejects(runCommand('dart\0', []), /Invalid/);
  await assert.rejects(runCommand('dart', ['\0']), /Invalid/);
  await assert.rejects(runCommand('dart', [], {timeoutMs: 1}), /Invalid/);
});

test('SDK modification of the original review evidence is detected', async t => {
  const f = await setup(t), {report} = await verifyDartFixture(f.options, {...f, execute: async (...args) => {
    const r = await f.execute(...args);
    await writeFile(path.join(f.output, 'review.json'), '{"verification":{"tests":"forged"}}');
    return r;
  }});
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.preservation.changes, [{path: 'review.json', reason: 'modified'}]);
});
