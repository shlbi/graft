import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTypeScriptModules } from '../dist/imports.js';

test('parses static ESM imports, exports, packages, and NodeNext .js specifiers', () => {
  const graph = parseTypeScriptModules([
    { path: 'features/upload/index.ts', content: `import { run } from './service.js';\nexport { View } from './view';\nimport 'zod/v4';` },
    { path: 'features/upload/service.ts', content: `import type { Storage } from './storage.js';\nexport const run = 1;` },
    { path: 'features/upload/storage.ts', content: `export interface Storage { put(): void }` },
    { path: 'features/upload/view.tsx', content: `export const View = () => null;` },
  ]);
  assert.equal(graph.ready, true);
  assert.deepEqual(graph.modules[0], {
    path: 'features/upload/index.ts',
    imports: [
      { kind: 'internal', path: 'features/upload/service.ts' },
      { kind: 'internal', path: 'features/upload/view.tsx' },
      { kind: 'package', package: 'zod/v4' },
    ],
  });
});

test('blocks unresolved relative imports and hidden dynamic/CommonJS dependencies', () => {
  const graph = parseTypeScriptModules([
    { path: 'feature/index.ts', content: `import './missing.js';\nconst a = import('./lazy.js');\nconst b = require('hidden');` },
  ]);
  assert.equal(graph.ready, false);
  assert.deepEqual(graph.blockers.map(blocker => blocker.reason), [
    'commonjs-require',
    'dynamic-import',
    'unresolved-relative-import',
  ]);
});
