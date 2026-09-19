import test from 'node:test';
import assert from 'node:assert/strict';
import { RewriteError, rewriteAdapterImports } from '../dist/rewrite.js';

const binding = {
  sourceCapability: 'storage', sourceModule: 'src/adapters/storage.ts',
  destinationCapability: 'blob-store', destinationModule: 'src/platform/blob-store.ts',
};

test('rewrites only declared static adapter imports to destination modules', () => {
  const source = [
    "import { helper } from './helper.js';",
    "import { put } from '../../adapters/storage.js';",
    "export { remove } from '../../adapters/storage';",
  ].join('\n');
  const result = rewriteAdapterImports('src/features/upload/service.ts', source, [binding]);
  assert.match(result.content, /from '\.\/helper\.js'/);
  assert.equal(result.content.match(/\.\.\/\.\.\/platform\/blob-store\.js/g)?.length, 2);
  assert.deepEqual(result.rewritten, [
    { from: '../../adapters/storage.js', to: '../../platform/blob-store.js' },
    { from: '../../adapters/storage', to: '../../platform/blob-store.js' },
  ]);
});

test('rejects duplicate boundary bindings instead of guessing', () => {
  assert.throws(() => rewriteAdapterImports('src/x.ts', 'export {};', [binding, binding]), RewriteError);
});
