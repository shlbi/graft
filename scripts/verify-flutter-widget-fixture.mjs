/** Opt-in execution of fixed authored widget fixtures; not a hosted worker or security sandbox. */
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {evaluateTestEvidence} from './flutter-widget-evidence.mjs';

const PHASES = ['source', 'destination-before', 'destination-after', 'host-positive',
  'host-missing-route', 'host-broken-update', 'host-missing-dispose'];
const notRun = reason => ({status: 'not_run', reason});

/** Re-check every ancestor and authored file, never follow SDK-created symlinks. */
export async function checkPreservation(root, originals) {
  const changes = [];
  for (const [relative, before] of Object.entries(originals)) {
    try {
      if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('unsafe path');
      let parent = root;
      if (!(await lstat(root)).isDirectory()) throw new Error('replaced root');
      for (const piece of relative.split('/').slice(0, -1)) {
        parent = path.join(parent, piece);
        if (!(await lstat(parent)).isDirectory()) throw new Error('replaced ancestor');
      }
      const full = path.join(root, relative);
      if (!(await lstat(full)).isFile()) throw new Error('replaced file');
      const after = createHash('sha256').update(await readFile(full)).digest('hex');
      if (before !== after) changes.push({path: relative, reason: 'modified'});
    } catch { changes.push({path: relative, reason: 'missing_or_replaced'}); }
  }
  return {status: changes.length ? 'failed' : 'passed', checkedFiles: Object.keys(originals).length, changes};
}

/** Doubles are injectable only for harness tests; CLI always loads the real fixed adapters. */
export async function verifyFlutterWidgetFixture(options, {
  materialize = async output => (await import('./materialize-flutter-widget-fixture.mjs')).materializeFlutterWidgetFixture(output),
  execute = async (...args) => (await import('./verify-dart-fixture.mjs')).runCommand(...args),
  environment = async root => (await import('./verify-dart-fixture.mjs')).sdkEnvironment(root),
} = {}) {
  const {output, allowExecution = false} = options ?? {};
  if (allowExecution !== true) throw new Error('Widget SDK execution requires --execute in a disposable environment.');
  if (typeof output !== 'string' || !output.trim()) throw new TypeError('Supply a new output directory.');
  if (process.platform === 'win32') throw new Error('Use a disposable Linux/macOS environment.');
  const root = path.resolve(output);
  const fixture = await materialize(root);
  if (fixture.directory !== root || fixture.packages.map(p => p.name).join('|') !== PHASES.join('|') ||
      !Object.keys(fixture.originalFiles ?? {}).length) throw new Error('Invalid authored fixture inventory.');
  const initial = await checkPreservation(root, fixture.originalFiles);
  if (initial.status !== 'passed') throw new Error('Authored fixture changed before execution.');
  for (const name of PHASES) if (!(await lstat(path.join(root, name))).isDirectory()) throw new Error('Expected real package directory.');
  const env = await environment(root);
  // Fresh per-run home/cache, with no inherited provider or repository credentials.
  for (const field of ['HOME', 'TMPDIR', 'PUB_CACHE']) {
    if (typeof env[field] !== 'string' || !path.resolve(env[field]).startsWith(root + path.sep)) throw new Error('SDK home/cache must be inside the new fixture.');
    await mkdir(env[field]);
  }
  const report = {schemaVersion: 1, scope: 'authored-flutter-widget-and-host-acceptance',
    createdAt: new Date().toISOString(), node: process.versions.node, platform: process.platform,
    commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
    status: 'not_run', packages: [],
    verification: {widgetBehavior: 'not_run', hostRouteWiring: 'not_run', controlSensitivity: 'not_run',
      nativeAppBuild: 'not_run', device: 'not_run', liveAITransfer: 'not_run'},
    limits: ['Authored fixtures and independent test-only host probes, not customer repositories.',
      'No production execution worker, native build, emulator, external plugin, or universal integration claim.',
      'This process is not a security sandbox. SDK/dependency execution requires a disposable environment.'],
  };
  try {
    const invoke = (args, cwd) => execute('flutter', args, {cwd, env, timeoutMs: 180000, maxOutputBytes: 262144});
    report.toolchain = await invoke(['--version'], root);
    if (report.toolchain.status !== 'passed' || report.toolchain.exitCode !== 0 || report.toolchain.signal || report.toolchain.error ||
        !/Flutter \d+\.\d+/.test(report.toolchain.stdout ?? '') || !/Dart \d+\.\d+/.test(report.toolchain.stdout ?? '')) {
      report.status = 'blocked';
      report.packages = fixture.packages.map(({name}) => ({name, dependencies: notRun('SDK unavailable'), analysis: notRun('SDK unavailable'), tests: notRun('SDK unavailable'), evidence: notRun('SDK unavailable')}));
    } else {
      for (const specification of fixture.packages) {
        const {name, expected, expectedFailures} = specification;
        const cwd = path.join(root, name), record = {name, expectedTests: [...expected], expectedAssertionFailures: [...expectedFailures]};
        report.packages.push(record);
        record.dependencies = await invoke(['pub', 'get'], cwd);
        if (record.dependencies.status !== 'passed' || record.dependencies.exitCode !== 0) {
          record.analysis = notRun('Dependency resolution failed'); record.tests = notRun('Dependency resolution failed');
          record.evidence = notRun('Dependency resolution failed'); continue;
        }
        record.analysis = await invoke(['analyze', '--no-pub'], cwd);
        record.tests = await invoke(['test', '--no-pub', '--machine'], cwd);
        record.evidence = record.analysis.status === 'passed' && record.analysis.exitCode === 0
          ? evaluateTestEvidence(record.tests, expected, expectedFailures)
          : {status: 'failed', reason: 'Analysis must pass before a test outcome can satisfy acceptance.'};
      }
      const passed = name => report.packages.find(p => p.name === name)?.evidence.status === 'passed';
      report.verification.widgetBehavior = ['source', 'destination-before', 'destination-after'].every(passed) ? 'passed' : 'failed';
      report.verification.hostRouteWiring = passed('host-positive') ? 'passed' : 'failed';
      report.verification.controlSensitivity = PHASES.slice(4).every(name => report.packages.find(p => p.name === name)?.evidence.status === 'expected_failure_observed') ? 'passed' : 'failed';
      report.status = ['widgetBehavior', 'hostRouteWiring', 'controlSensitivity'].every(k => report.verification[k] === 'passed') ? 'passed' : 'failed';
    }
  } catch (error) {
    report.status = 'failed'; report.reason = `Harness execution incomplete: ${error.code ?? error.name ?? 'Error'}`;
  }
  report.preservation = await checkPreservation(root, fixture.originalFiles);
  if (report.preservation.status !== 'passed') report.status = 'failed';
  // Never promote or rewrite the engine's structural review.json.
  if (!(await lstat(root)).isDirectory()) throw new Error('Replaced fixture output root.');
  await writeFile(path.join(root, 'widget-sdk-acceptance.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  return {directory: root, report};
}

export function parseWidgetArgs(argv) {
  if (argv.length !== 2 || !argv[0] || argv[0].startsWith('--') || argv[1] !== '--execute') {
    throw new Error('Usage: node scripts/verify-flutter-widget-fixture.mjs NEW_DIRECTORY --execute');
  }
  return {output: argv[0], allowExecution: true};
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const {directory, report} = await verifyFlutterWidgetFixture(parseWidgetArgs(process.argv.slice(2)));
    console.log(JSON.stringify({directory, ...report}, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
