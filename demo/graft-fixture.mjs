import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPreparedTransplant, prepareTransplant } from '../dist/transplant.js';

const here = dirname(fileURLToPath(import.meta.url));

export const uploadFeature = {
  schemaVersion: 1,
  name: 'upload-processing-progress',
  entrypoints: [{ path: 'features/upload/service.ts', role: 'backend' }],
  capabilities: [
    { name: 'jobs', kind: 'jobs', contract: 'graft.jobs.v1', module: 'adapters/jobs.ts' },
    { name: 'storage', kind: 'storage', contract: 'graft.storage.v1', module: 'adapters/storage.ts' },
  ],
  assets: [],
  environment: [],
};

export const destinationInventory = {
  schemaVersion: 1,
  capabilities: [
    { name: 'task-runner', kind: 'jobs', contract: 'graft.jobs.v1', module: 'platform/task-runner.ts' },
    { name: 'blob-store', kind: 'storage', contract: 'graft.storage.v1', module: 'platform/blob-store.ts' },
  ],
};

const sourcePaths = [
  'features/upload/service.ts',
  'features/upload/types.ts',
  'adapters/jobs.ts',
  'adapters/storage.ts',
];
const destinationPaths = [
  'app.ts',
  'entry.ts',
  'platform/blob-store.ts',
  'platform/task-runner.ts',
];

async function snapshots(root, paths) {
  return Promise.all(paths.map(async path => ({ path, content: await readFile(join(root, path), 'utf8') })));
}

export async function prepareDemoTransplant() {
  const sourceSnapshots = await snapshots(join(here, 'source-app'), sourcePaths);
  const destinationSnapshots = await snapshots(join(here, 'destination-app'), destinationPaths);
  const prepared = prepareTransplant(uploadFeature, destinationInventory, sourceSnapshots, destinationSnapshots);
  return { prepared, sourceSnapshots, destinationSnapshots };
}

export async function runDemoTransplant() {
  const fixture = await prepareDemoTransplant();
  const applied = applyPreparedTransplant(fixture.prepared, fixture.sourceSnapshots, fixture.destinationSnapshots);
  return { ...fixture, applied };
}
