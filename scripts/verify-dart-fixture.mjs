/**
 * Execute SDK acceptance for Repot's authored Dart/Flutter transfer fixtures.
 * Opt-in only; never accepts a customer repository or installs an SDK. This is
 * NOT a sandbox: run in a disposable environment without production credentials.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const PHASES = ['source', 'destination-before', 'destination-after'];
const DEFAULT_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 256 * 1024;

/** Keep credentials, custom registries and user package caches out of SDK children. */
export function sdkEnvironment(root, inherited = process.env) {
  const env = {
    PATH: inherited.PATH ?? '', HOME: path.join(root, '.sdk-home'),
    TMPDIR: path.join(root, '.sdk-tmp'), PUB_CACHE: path.join(root, '.pub-cache'),
    CI: 'true', DART_SUPPRESS_ANALYTICS: 'true', FLUTTER_SUPPRESS_ANALYTICS: 'true',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  };
  return env;
}

/** Run without a shell; bound time/output and kill the child process group on POSIX. */
export async function runCommand(command, args, {
  cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = OUTPUT_LIMIT,
} = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0') ||
      !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0')) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600_000 ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 128 || maxOutputBytes > 1_048_576) {
    throw new TypeError('Invalid command or execution budget.');
  }
  if (process.platform === 'win32') throw new Error('This bounded SDK runner requires Linux or macOS.');
  const started = Date.now();
  return new Promise(resolve => {
    const stdout = [], stderr = [];
    let bytes = 0, reason = null, timer, settled = false;
    const child = spawn(command, args, {cwd, env, shell: false, detached: true,
      stdio: ['ignore', 'pipe', 'pipe']});
    const stop = why => {
      reason ??= why;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({command, args: [...args], status: reason ?? (error ? 'spawn_error' : code === 0 ? 'passed' : 'failed'),
        exitCode: code, signal, error, durationMs: Date.now() - started,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')});
    };
    const collect = stream => chunk => {
      const buffer = Buffer.from(chunk), remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining) stream.push(buffer.subarray(0, remaining));
      bytes += buffer.length;
      if (bytes > maxOutputBytes) stop('output_limit');
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.once('error', error => finish(null, null, error.code ?? 'SPAWN_ERROR'));
    child.once('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  });
}

/** Hash only regular authored files; never follow links into somebody else's tree. */
async function hashes(directory, prefix = '') {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Fixture package must be a real directory.');
  const result = {};
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const relative = prefix + item.name, full = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Fixture contains a symbolic link.');
    if (item.isDirectory()) Object.assign(result, await hashes(full, relative + '/'));
    else if (item.isFile()) result[relative] = createHash('sha256').update(await readFile(full)).digest('hex');
    else throw new Error('Fixture contains a non-regular file.');
  }
  return result;
}

async function unchangedFiles(root, before) {
  const changes = [];
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('replaced root');
  } catch {
    return {status: 'failed', checkedFiles: Object.keys(before).length, changes: [{path: '.', reason: 'missing_or_replaced_root'}]};
  }
  for (const [relative, digest] of Object.entries(before)) {
    try {
      const full = path.join(root, relative);
      // Check every parent: a replaced directory symlink must not be followed.
      let parent = root;
      for (const piece of relative.split('/').slice(0, -1)) {
        parent = path.join(parent, piece);
        if (!(await lstat(parent)).isDirectory()) throw new Error('replaced parent');
      }
      if (!(await lstat(full)).isFile()) throw new Error('replaced file');
      const after = createHash('sha256').update(await readFile(full)).digest('hex');
      if (after !== digest) changes.push({path: relative, reason: 'modified'});
    } catch { changes.push({path: relative, reason: 'missing_or_replaced'}); }
  }
  return {status: changes.length ? 'failed' : 'passed', checkedFiles: Object.keys(before).length, changes};
}

const skipped = reason => ({status: 'not_run', reason});

/** Dependency injection is only for harness tests; the CLI always uses real tools. */
export async function verifyDartFixture(options, {
  materialize = async (...args) => (await import('./materialize-dart-fixture.mjs')).materializeDartFixture(...args),
  execute = runCommand,
} = {}) {
  const {output, flutter = false, allowExecution = false, timeoutMs = DEFAULT_TIMEOUT_MS} = options ?? {};
  if (allowExecution !== true) throw new Error('SDK execution requires --execute in an isolated disposable environment.');
  if (typeof output !== 'string' || !output.trim() || typeof flutter !== 'boolean' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 600_000) throw new TypeError('Invalid SDK acceptance options.');
  if (process.platform === 'win32') throw new Error('Use a disposable Linux/macOS environment for SDK acceptance.');
  const root = path.resolve(output), program = flutter ? 'flutter' : 'dart';
  // The real materializer uses mkdir without recursive:true, rejecting any existing target.
  await materialize(root, {flutter});
  if (!(await lstat(root)).isDirectory()) throw new Error('Fixture root must be a real directory.');
  for (const phase of PHASES) {
    if (!(await lstat(path.join(root, phase))).isDirectory()) throw new Error('Fixture package must be a real directory.');
  }
  const originals = await hashes(root);
  const env = sdkEnvironment(root);
  for (const folder of [env.HOME, env.TMPDIR, env.PUB_CACHE]) await mkdir(folder);
  const report = {
    schemaVersion: 1, scope: 'authored-package-fixture-sdk-acceptance',
    createdAt: new Date().toISOString(), node: process.versions.node, platform: process.platform,
    commit: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
    sdk: program, status: 'not_run', packages: [],
    verification: {analysis: 'not_run', tests: 'not_run', nativeAppBuild: 'not_run', device: 'not_run', liveAITransfer: 'not_run'},
    limits: ['Authored fixtures, not arbitrary-repository compatibility.', 'No SDK installation or production credentials provided by this runner.',
      'This process is not a security sandbox. Dependency resolution can execute toolchain hooks.'],
  };
  // Write once, even if execution throws unexpectedly; never alter structural review.json.
  try {
    const invoke = (args, cwd) => execute(program, args, {cwd, env, timeoutMs});
    report.toolchain = await invoke(['--version'], root);
    if (report.toolchain.status !== 'passed' || !(report.toolchain.stdout + report.toolchain.stderr).trim()) {
      report.status = 'blocked'; report.reason = 'SDK version command did not succeed with version output.';
      report.packages = PHASES.map(name => ({name, dependencies: skipped('SDK unavailable'), analysis: skipped('SDK unavailable'), tests: skipped('SDK unavailable')}));
    } else {
      for (const name of PHASES) {
        const cwd = path.join(root, name), record = {name};
        report.packages.push(record);
        record.dependencies = await invoke(['pub', 'get'], cwd);
        if (record.dependencies.status !== 'passed') {
          record.analysis = skipped('Dependency resolution failed'); record.tests = skipped('Dependency resolution failed');
          continue;
        }
        record.analysis = await invoke(['analyze'], cwd);
        record.tests = await invoke(['test'], cwd);
      }
      for (const check of ['analysis', 'tests']) {
        report.verification[check] = report.packages.every(p => p[check].status === 'passed') ? 'passed' : 'failed';
      }
      report.status = report.packages.every(p => ['dependencies', 'analysis', 'tests'].every(k => p[k].status === 'passed')) ? 'passed' : 'failed';
    }
  } catch (error) {
    report.status = 'failed'; report.reason = `Harness execution failed: ${error.code ?? error.name ?? 'Error'}`;
    report.verification.analysis = 'incomplete'; report.verification.tests = 'incomplete';
  }
  report.preservation = await unchangedFiles(root, originals);
  if (report.preservation.status !== 'passed') report.status = 'failed';
  await writeFile(path.join(root, 'sdk-acceptance.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  return {directory: root, report};
}

export function parseArgs(argv) {
  const [output, ...flags] = argv;
  if (!output || output.startsWith('--') || new Set(flags).size !== flags.length ||
      flags.some(f => !['--flutter', '--execute'].includes(f)) || !flags.includes('--execute')) {
    throw new Error('Usage: node scripts/verify-dart-fixture.mjs NEW_DIRECTORY --execute [--flutter]');
  }
  return {output, flutter: flags.includes('--flutter'), allowExecution: true};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const {directory, report} = await verifyDartFixture(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({directory, ...report}, null, 2));
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
