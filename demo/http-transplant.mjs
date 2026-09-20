import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyPreparedTransplant } from '../dist/transplant.js';
import { prepareDemoTransplant } from './graft-fixture.mjs';
import { createUploadHttpServer } from './upload-server.mjs';
import { createDemoWorkspace } from './workspace.mjs';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/bin/tsc');
const compilerVersion = require('typescript/package.json').version;

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

async function compile(root) {
  try {
    await execute(process.execPath, [compiler, '-p', 'tsconfig.json'], {
      cwd: root, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
      windowsHide: true, encoding: 'utf8', shell: false,
    });
  } catch (cause) {
    throw new Error(`Transplanted HTTP fixture failed to compile: ${cause.message}\n${cause.stdout ?? ''}\n${cause.stderr ?? ''}`, { cause });
  }
}

/** Build a fresh reviewed transplant, compile it, and expose the transplanted
 * feature through a local HTTP upload boundary. Only checked-in demo code runs. */
export async function createTransplantedUploadRuntime({ host = '127.0.0.1', port = 0 } = {}) {
  const fixture = await prepareDemoTransplant({ integrate: false });
  assert.equal(fixture.prepared.ready, true, 'HTTP demo requires a blocker-free review plan');
  const applied = applyPreparedTransplant(fixture.prepared, fixture.sourceSnapshots, fixture.destinationSnapshots);
  assert.equal(applied.result.some(file => file.path.startsWith('adapters/')), false, 'source adapters must not be copied');

  const workspace = await createDemoWorkspace([...applied.result, ...compileMetadata]);
  let server;
  try {
    await compile(workspace.root);
    const serviceUrl = pathToFileURL(join(workspace.root, '.compiled', 'features/upload/service.js'));
    serviceUrl.searchParams.set('runtime', String(Date.now()));
    const service = await import(serviceUrl.href);
    if (typeof service.uploadAndProcess !== 'function') throw new Error('transplanted service did not export uploadAndProcess');
    server = createUploadHttpServer({ uploadAndProcess: service.uploadAndProcess, host, port });
    return {
      async listen() { return server.listen(); },
      review: {
        feature: fixture.prepared.feature.name,
        bindings: fixture.prepared.changeSet.bindings,
        created: applied.created.map(file => file.path),
        preserved: applied.preserved,
      },
      async close() {
        await server.close();
        await workspace.close();
      },
    };
  } catch (error) {
    await server?.close().catch(() => {});
    await workspace.close();
    throw error;
  }
}

export async function runHttpTransplantDemo() {
  const runtime = await createTransplantedUploadRuntime();
  try {
    const address = await runtime.listen();
    if (!address || typeof address !== 'object') throw new Error('HTTP demo did not bind a TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    const payload = 'Graft HTTP upload proof\nactual request bytes traverse the transplanted service';
    const response = await fetch(`${base}/api/upload?name=${encodeURIComponent('proof.txt')}`, {
      method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: payload,
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.name, 'proof.txt');
    assert.equal(body.size, Buffer.byteLength(payload));
    assert.equal(body.result.fileId, 'blob-1', 'destination blob-store adapter must receive the HTTP upload');
    assert.deepEqual(body.result.progress.map(item => item.progress), [0, 50, 90, 100],
      'destination task-runner adapter must produce the progress history');
    const completed = body.result.progress.at(-1);
    assert.equal(completed.metrics.bytes, Buffer.byteLength(payload),
      'destination processor must inspect the uploaded request bytes');
    assert.equal(completed.metrics.lines, 2);
    assert.ok(completed.metrics.words >= 8);
    assert.match(completed.metrics.checksum, /^[0-9a-f]{8}$/u);
    return {
      schemaVersion: 1,
      runtime: process.version,
      typescript: compilerVersion,
      transport: 'real localhost HTTP POST with bounded raw upload body',
      review: runtime.review,
      observed: { status: response.status, uploadName: body.name, bytes: body.size, result: body.result },
      limitations: [
        'Storage is still in-memory in the authored destination demo.',
        'The destination adapter performs real bounded text metrics/checksum work, but progress checkpoints are returned synchronously and durable/background queueing is not claimed.',
        'The HTTP boundary is demo transport around the transplanted backend feature, not a framework-agnostic transplant target.',
      ],
    };
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHttpTransplantDemo().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
