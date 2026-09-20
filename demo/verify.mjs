import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyPreparedTransplant } from '../dist/transplant.js';
import { prepareDemoTransplant, readSourceDemoSnapshots } from './graft-fixture.mjs';
import { createDemoWorkspace } from './workspace.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const compilerVersion = require('typescript/package.json').version;

// This is an executable test of authored fixtures, NOT an untrusted-code sandbox.
const compileMetadata = [
  { path: 'package.json', content: JSON.stringify({ private: true, type: 'module' }) },
  {
    path: 'tsconfig.json',
    content: JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
        rootDir: '.', outDir: '.compiled', strict: true,
        noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        forceConsistentCasingInFileNames: true, skipLibCheck: true, noEmitOnError: true,
      },
      include: ['**/*.ts'], exclude: ['.compiled', 'node_modules'],
    }),
  },
];

async function compileAndRun(root) {
  const options = {
    cwd: root, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
    windowsHide: true, encoding: 'utf8', shell: false,
  };
  try {
    await execute(process.execPath, [compiler, '-p', 'tsconfig.json'], options);
    const { stdout } = await execute(process.execPath, [join(root, '.compiled', 'entry.js')], options);
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`Fixture compile/run failed: ${cause.message}\n${cause.stdout ?? ''}\n${cause.stderr ?? ''}`, { cause });
  }
}

/**
 * Execute source -> destination baseline -> reviewed transplant -> compile/run
 * -> clean reset. Every run uses a fresh process, so adapter module state cannot
 * accidentally leak between cycles. Only checked-in, authored fixture code runs.
 */
export async function verifyDemo({ cycles = 2, fixture: reviewedFixture } = {}) {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 3) {
    throw new Error('cycles must be an integer between 1 and 3');
  }
  const fixture = reviewedFixture ?? await prepareDemoTransplant({ integrate: true });
  assert.equal(fixture.prepared.ready, true, 'fixture must have a blocker-free review plan');
  const applied = applyPreparedTransplant(fixture.prepared, fixture.sourceSnapshots, fixture.destinationSnapshots);
  assert.deepEqual(applied.updated.map(patch => patch.targetPath), ['entry.ts']);
  assert.deepEqual(applied.created.map(file => file.path), ['features/upload/service.ts', 'features/upload/types.ts']);
  assert.deepEqual(applied.preserved, ['app.ts', 'platform/blob-store.ts', 'platform/task-runner.ts']);
  assert.equal(applied.result.some(file => file.path.startsWith('adapters/')), false, 'source adapters must not be copied');
  for (const path of applied.preserved) {
    assert.equal(applied.result.find(file => file.path === path).content,
      fixture.destinationSnapshots.find(file => file.path === path).content);
  }

  const workspaces = [];
  try {
    const sourceWorkspace = await createDemoWorkspace([...await readSourceDemoSnapshots(), ...compileMetadata]);
    workspaces.push(sourceWorkspace);
    const destinationWorkspace = await createDemoWorkspace([...fixture.destinationSnapshots, ...compileMetadata]);
    workspaces.push(destinationWorkspace);
    const source = await compileAndRun(sourceWorkspace.root);
    assert.equal(source.result.fileId, 'upload-1');
    assert.deepEqual(source.result.progress.map(item => item.progress), [0, 35, 75, 100]);
    const before = await compileAndRun(destinationWorkspace.root);
    assert.equal(before.hasUploadFeature, false);
    const runs = [];
    for (let cycle = 1; cycle <= cycles; cycle++) {
      await destinationWorkspace.apply([...applied.result, ...compileMetadata]);
      const after = await compileAndRun(destinationWorkspace.root);
      assert.equal(after.hasUploadFeature, true);
      assert.equal(after.result.fileId, 'blob-1', 'destination storage adapter must be used');
      assert.deepEqual(after.result.progress.map(item => item.progress), [0, 50, 90, 100],
        'destination job adapter must be used, not copied source infrastructure');
      assert.equal(after.result.name, 'quarterly-notes.txt');
      for (const path of applied.preserved) {
        assert.equal(await destinationWorkspace.read(path), fixture.destinationSnapshots.find(file => file.path === path).content);
      }
      await destinationWorkspace.reset();
      for (const file of fixture.destinationSnapshots) {
        assert.equal(await destinationWorkspace.read(file.path), file.content);
      }
      await assert.rejects(destinationWorkspace.read('features/upload/service.ts'), { code: 'ENOENT' });
      await assert.rejects(destinationWorkspace.read('.compiled/entry.js'), { code: 'ENOENT' });
      const reset = await compileAndRun(destinationWorkspace.root);
      assert.deepEqual(reset, before, 'reset must restore the exact runnable baseline');
      runs.push({ cycle, after, reset, compiled: true, cleanReset: true });
    }
    assert.deepEqual(runs.map(run => run.after), Array(cycles).fill(runs[0].after));
    return {
      schemaVersion: 1, feature: fixture.prepared.feature.name,
      runtime: process.version, typescript: compilerVersion,
      scope: 'authored TypeScript CLI fixtures; in-memory storage and simulated job progress',
      review: {
        touchedTargets: fixture.prepared.touchedTargets,
        bindings: fixture.prepared.changeSet.bindings,
        created: applied.created.map(file => file.path),
        updated: applied.updated.map(patch => patch.targetPath),
        preserved: applied.preserved,
      },
      source, before, runs,
      limitations: [
        'This CLI report does not exercise HTTP or the browser. Text metrics use in-memory adapters; no durable queue or database is provided.',
        'A contract label does not prove adapter compatibility; the compiler and runtime checks validate this fixture only.',
        'Temporary directories are not isolation for arbitrary third-party scripts.',
        'Windows behavior has not been verified in this Linux execution environment.',
      ],
    };
  } finally {
    await Promise.all(workspaces.map(workspace => workspace.close()));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyDemo().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
