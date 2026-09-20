import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPreparedTransplant, prepareTransplant, TransplantError } from '../dist/transplant.js';

const feature = {
  schemaVersion: 1,
  name: 'upload-processing-progress',
  entrypoints: [{ path: 'feature/service.ts', role: 'backend' }],
  capabilities: [
    { name: 'jobs', kind: 'jobs', contract: 'graft.jobs.v1', module: 'adapters/jobs.ts' },
    { name: 'storage', kind: 'storage', contract: 'graft.storage.v1', module: 'adapters/storage.ts' },
  ],
  assets: [],
  environment: [],
};

const inventory = {
  schemaVersion: 1,
  capabilities: [
    { name: 'task-runner', kind: 'jobs', contract: 'graft.jobs.v1', module: 'platform/tasks.ts' },
    { name: 'blob-store', kind: 'storage', contract: 'graft.storage.v1', module: 'platform/blob.ts' },
  ],
};

const source = [
  {
    path: 'feature/service.ts',
    content: "import { runProcessingJob } from '../adapters/jobs.js';\nimport { storeUpload } from '../adapters/storage.js';\nexport async function run() { const file = await storeUpload('x', 'y'); return runProcessingJob(file.id); }\n",
  },
  { path: 'adapters/jobs.ts', content: 'export async function runProcessingJob(id: string) { return [id]; }\n' },
  { path: 'adapters/storage.ts', content: "export async function storeUpload(name: string, content: string) { return { id: name, content }; }\n" },
];
const destination = [
  { path: 'app.ts', content: "export const existing = 'preserve-me';\n" },
  { path: 'platform/blob.ts', content: "export async function storeUpload(name: string, content: string) { return { id: 'blob-' + name, content }; }\n" },
  { path: 'platform/tasks.ts', content: 'export async function runProcessingJob(id: string) { return [id, 100]; }\n' },
];

test('prepares a reviewable plan and applies rewritten adapter bindings without touching existing files', () => {
  const prepared = prepareTransplant(feature, inventory, source, destination);
  assert.equal(prepared.ready, true);
  assert.deepEqual(prepared.analysis.closure?.files, ['feature/service.ts']);
  assert.equal(prepared.plan?.mappings.length, 2);
  assert.deepEqual(prepared.changeSet?.touchedTargets, ['feature/service.ts']);

  const applied = applyPreparedTransplant(prepared, source, destination);
  assert.deepEqual(applied.preserved, ['app.ts', 'platform/blob.ts', 'platform/tasks.ts']);
  assert.equal(applied.created.length, 1);
  assert.match(applied.created[0].content, /\.\.\/platform\/blob\.js/u);
  assert.match(applied.created[0].content, /\.\.\/platform\/tasks\.js/u);
  assert.equal(applied.result.find(file => file.path === 'app.ts')?.content, "export const existing = 'preserve-me';\n");
});

test('refuses application when preparation has unresolved destination capabilities', () => {
  const prepared = prepareTransplant(feature, { schemaVersion: 1, capabilities: [] }, source, destination);
  assert.equal(prepared.ready, false);
  assert.equal(prepared.plan?.blockers.length, 2);
  assert.throws(() => applyPreparedTransplant(prepared, source, destination), TransplantError);
});
