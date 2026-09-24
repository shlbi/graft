/** Original synthetic code, not uploaded projects and not model-generated tests. */
export function runnerFixture(kind, versions) {
  if (!['named-imports', 'global-apis', 'shared-setup'].includes(kind)) throw new Error('Unknown acceptance fixture.');
  const named = kind !== 'global-apis', setup = kind === 'shared-setup';
  const feature = `export const greeting = name => 'Hello, ' + name;\n`;
  const title1 = 'greeting preserves input', title2 = 'greeting remains deterministic';
  const testText = `${named ? "import { test as check, expect as verify } from '@jest/globals';\n" : ''}import { greeting } from '../src/greeting.js';\n${setup ? "import { next } from './support/counter.js';\n" : ''}${named ? 'check' : 'test'}('${title1}', () => { ${named ? 'verify' : 'expect'}(greeting(${setup ? 'next()' : "'Ada'"})).toBe('${setup ? 'Hello, 1' : 'Hello, Ada'}'); });\n${named ? 'check' : 'test'}('${title2}', () => { ${named ? 'verify' : 'expect'}(greeting(${setup ? 'next()' : "'Ada'"})).toBe('${setup ? 'Hello, 1' : 'Hello, Ada'}'); });\n`;
  const file = (path, content) => ({ path, content });
  const source = { name: `authored/${kind}-source`, files: [
    file('package.json', JSON.stringify({ name: 'graft-synthetic-source', private: true, type: 'module', devDependencies: { jest: versions.jest } })),
    file('jest.config.mjs', `export default { testEnvironment: 'node', transform: {}${setup ? ", setupFilesAfterEnv: ['./test/setup.js']" : ''} };\n`),
    file('src/greeting.js', feature), file('test/greeting.test.js', testText)
  ] };
  if (setup) source.files.push(
    file('test/setup.js', "import { beforeEach } from '@jest/globals';\nimport { reset } from './support/counter.js';\nbeforeEach(() => { reset(); });\n"),
    file('test/support/counter.js', 'let count = 99;\nexport function reset() { count = 0; }\nexport function next() { return ++count; }\n')
  );
  const regressionName = 'existing destination count stays intact';
  const destination = { name: `authored/${kind}-destination`, files: [
    file('package.json', JSON.stringify({ name: 'graft-synthetic-destination', private: true, type: 'module', devDependencies: { vitest: versions.vitest } })),
    file('lib/count.js', 'export const count = items => items.length;\n'),
    file('spec/count.spec.js', `import { test, expect } from 'vitest';\nimport { count } from '../lib/count.js';\ntest('${regressionName}', () => { expect(count(['keep'])).toBe(1); });\n`),
    file('README.md', 'Unrelated destination text must remain byte-for-byte intact.\n')
  ] };
  return { kind, source, destination, sourceTestNames: [title1, title2], destinationTestNames: [regressionName],
    proposal: { summary: 'Transfer the greeting function with its original tests.', changes: [
      { path: 'lib/greeting.js', action: 'add', content: feature, reason: 'Place the feature alongside destination modules.', sourcePaths: ['src/greeting.js'] }
    ], risks: ['Synthetic acceptance case, not a user-project accuracy claim.'], suggestedChecks: ['Execute source, destination baseline and post-transfer suites under the actual installed runners.'] } };
}
