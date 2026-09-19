import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTypeScriptFeature } from '../dist/pipeline.js';

const feature = {
  schemaVersion: 1,
  name: 'upload-jobs',
  entrypoints: [{ path: 'src/features/upload/index.ts', role: 'backend' }],
  capabilities: [{ name: 'storage', kind: 'storage', contract: 'blob-v1', module: 'src/adapters/storage.ts' }],
  assets: [], environment: [],
};

test('connects parsed TypeScript imports into feature closure analysis', () => {
  const result = analyzeTypeScriptFeature(feature, [
    { path: 'src/features/upload/index.ts', content: "import './helper.js'; import { put } from '../../adapters/storage.js';" },
    { path: 'src/features/upload/helper.ts', content: 'export const helper = true;' },
    { path: 'src/adapters/storage.ts', content: 'export const put = () => undefined;' },
  ]);
  assert.equal(result.ready, true);
  assert.deepEqual(result.parseBlockers, []);
  assert.deepEqual(result.closure?.files, ['src/features/upload/helper.ts', 'src/features/upload/index.ts']);
  assert.deepEqual(result.closure?.boundaryModules, ['src/adapters/storage.ts']);
});

test('refuses to analyze a closure when parsing found unsupported dependency edges', () => {
  const result = analyzeTypeScriptFeature(feature, [
    { path: 'src/features/upload/index.ts', content: "await import('./helper.js');" },
    { path: 'src/features/upload/helper.ts', content: 'export const helper = true;' },
  ]);
  assert.equal(result.ready, false);
  assert.equal(result.closure, null);
  assert.equal(result.parseBlockers[0]?.reason, 'dynamic-import');
});
