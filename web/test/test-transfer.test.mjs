import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, analyze, reviewProposal } from '../lib/core.mjs';
import { discoverTests, references, isTestPath } from '../lib/test-transfer.mjs';
import { demoInput, demoProposal, demoRun } from '../lib/demo.mjs';
const clone = () => structuredClone(demoInput);
function review(input = clone(), proposal = demoProposal) {
  const source = snapshot(input.source), destination = snapshot(input.destination);
  const analysis = analyze(source, destination, 'CSV export');
  return reviewProposal(proposal, source, destination, analysis.context);
}
const addSource = (input, path, content) => input.source.files.push({ path, content });
const editSource = (input, path, content) => input.source.files.find(f => f.path === path).content = content;
const assertBlocked = (result, message) => { assert.equal(result.exportable, false); assert.equal(result.patch, null); assert.equal(result.testTransfer.status, 'blocked'); assert.match(result.testTransfer.blockers.join('\n'), message); };

test('discovers reverse references, required helpers and fixtures, not unrelated tests', () => {
  const { analysis, review: r } = demoRun();
  assert.deepEqual(analysis.testPlan.tests, [{ path: 'test/csv.test.mjs', evidence: 'reverse-import' }]);
  assert.deepEqual(analysis.testPlan.support, ['test/fixtures/cells.json', 'test/support/rows.mjs']);
  assert.equal(r.testTransfer.status, 'included'); assert.equal(r.exportable, true);
  assert.ok(r.changes.some(c => c.path === 'tests/csv.test.mjs'));
  assert.ok(!r.changes.some(c => /unrelated/.test(c.path)));
  assert.equal(r.changes.find(c => c.path === 'tests/task-count.test.mjs'), undefined);
});
test('required test files and destination examples are in AI context, without executing them', () => {
  const s = snapshot(demoInput.source), d = snapshot(demoInput.destination), a = analyze(s, d, 'CSV export');
  for (const p of a.testPlan.requiredSource) assert.ok(a.context.source.some(f => f.path === p));
  for (const p of a.testPlan.requiredDestination) assert.ok(a.context.destination.some(f => f.path === p));
  assert.deepEqual(Object.values(demoRun().review.testTransfer.verification), Array(4).fill('not_run'));
});
test('literal import/require/re-export/URL references are resolved, without interpreting code', () => {
  const files = new Map(['src/a.ts', 'test/f.json', 'test/b.mjs'].map(p => [p, {}]));
  const file = { path: 'test/x.test.mjs', content: `import {x} from '../src/a.js'; export * from './b.mjs'; const b = require('./b.mjs'); const f = new URL('./f.json', import.meta.url);` };
  assert.deepEqual(references(file, files).map(r => r.target), ['src/a.ts', 'test/b.mjs', 'test/b.mjs', 'test/f.json']);
});
test('reverse graph finds tests through wrapper modules and handles circular helpers', () => {
  const x = clone();
  editSource(x, 'test/csv.test.mjs', `import test from 'node:test'; import { toCSV } from './wrap.mjs'; test('works', () => toCSV([]));`);
  addSource(x, 'test/wrap.mjs', `export { toCSV } from '../src/csv.mjs'; import './cycle.mjs';`);
  addSource(x, 'test/cycle.mjs', `import './wrap.mjs';`);
  const r = review(x); assert.equal(r.exportable, true);
  assert.equal(r.testTransfer.discovered, 1);
  assert.ok(r.changes.some(c => c.path === 'tests/cycle.mjs'));
});
test('separate destination directory and spec suffix are inferred from existing tests', () => {
  const x = clone(); x.destination.files.at(-1).path = 'spec/task-count.spec.mjs';
  const r = review(x); assert.equal(r.exportable, true);
  assert.ok(r.changes.some(c => c.path === 'spec/csv.spec.mjs'));
  assert.ok(r.changes.some(c => c.path === 'spec/fixtures/cells.json'));
});
test('colocated destination tests follow the moved feature and rewrite imports only', () => {
  const x = clone(); x.destination.files.at(-1).path = 'src/app.test.mjs';
  const proposal = structuredClone(demoProposal);
  proposal.changes[0].path = 'lib/serialize.mjs';
  proposal.changes[1].sourcePaths = ['src/app.mjs'];
  proposal.changes[1].content = proposal.changes[1].content.replace("'./csv.mjs'", "'../lib/serialize.mjs'");
  const r = review(x, proposal); assert.equal(r.exportable, true);
  const moved = r.changes.find(c => c.path === 'lib/serialize.test.mjs');
  assert.ok(moved); assert.match(moved.content, /from '\.\/serialize.mjs'/);
  assert.match(moved.content, /assert\.equal\(toCSV\(rows\)/);
});
test('original test bodies and fixture bytes are preserved exactly when relative paths do not change', () => {
  const r = review();
  for (const p of r.testTransfer.placements) assert.equal(r.changes.find(c => c.path === p.destinationPath).content, demoInput.source.files.find(f => f.path === p.sourcePath).content);
});
test('cross-runner transfers block export rather than pretending to convert assertions', () => {
  const x = clone(); x.destination.files.at(-1).content = `import { test } from 'vitest'; test('existing', () => {});`;
  assertBlocked(review(x), /runners differ/);
});
test('same-runner explicit Vitest imports produce a reviewable TS patch (runner not executed)', () => {
  const source = snapshot({ name: 's', files: [
    { path: 'src/csv.ts', content: 'export const csv = () => 1;' },
    { path: 'tests/csv.test.ts', content: `import {test, expect} from 'vitest'; import {csv} from '../src/csv'; test('csv', () => expect(csv()).toBe(1));` },
    { path: 'package.json', content: '{"devDependencies":{"vitest":"^3.0.0"}}' }
  ] });
  const destination = snapshot({ name: 'd', files: [
    { path: 'spec/other.spec.ts', content: `import { test } from 'vitest'; test('existing', () => {});` },
    { path: 'package.json', content: '{"devDependencies":{"vitest":"^3.0.0"}}' }
  ] });
  const a = analyze(source, destination, 'csv');
  const r = reviewProposal({ summary: 'csv', changes: [{ path: 'lib/serialize.ts', action: 'add', content: 'export const csv = () => 1;', reason: 'move serializer', sourcePaths: ['src/csv.ts'] }], risks: [], suggestedChecks: [] }, source, destination, a.context);
  assert.equal(r.exportable, true); assert.match(r.patch, /from '\.\.\/lib\/serialize'/);
  assert.ok(r.changes.some(c => c.path === 'spec/csv.spec.ts')); assert.equal(r.verification.tests, 'not_run');
});
test('missing or mixed destination layouts block export', () => {
  const x = clone(); x.destination.files.pop(); assertBlocked(review(x), /location|runner/);
  const y = clone(); y.destination.files.push({ path: 'src/other.test.mjs', content: "import test from 'node:test';" });
  assertBlocked(review(y), /ambiguous/);
});
test('source setup/configuration and multiple package scopes require explicit review', () => {
  for (const extra of [
    [{ path: 'vitest.config.ts', content: 'export default {};' }],
    [{ path: 'package.json', content: '{}' }, { path: 'packages/a/package.json', content: '{}' }]
  ]) { const x = clone(); x.source.files.push(...extra); assertBlocked(review(x), /setup|multiple packages/); }
});
test('unread test files and incomplete eligible snapshots block, excluded dependencies do not', () => {
  const x = clone(); x.source.inventory = [...x.source.files.map(f => f.path), 'test/hidden.test.mjs'];
  assertBlocked(review(x), /coverage is incomplete/);
  const y = clone(); y.source.inventory = [...y.source.files.map(f => f.path), 'node_modules/not-copied.js', '.env'];
  assert.equal(review(y).exportable, true);
});
test('unresolved helper and ambiguous module resolution block test transfer', () => {
  const x = clone(); editSource(x, 'test/support/rows.mjs', `export { rows } from './missing.mjs';`);
  assertBlocked(review(x), /unresolved|unambiguous/);
  const y = clone(); editSource(y, 'test/support/rows.mjs', `export { rows } from './rows';`);
  addSource(y, 'test/support/rows.js', 'export const rows = [];'); addSource(y, 'test/support/rows.ts', 'export const rows = [];');
  assertBlocked(review(y), /ambiguous/);
});
test('dynamic imports and working-directory fixture reads are never silently rewritten', () => {
  for (const statement of [`await import(moduleName);`, `readFileSync('./fixture.json');`, `const p = __dirname;`, `vi.mock('./foo');`, `expect(result).toMatchSnapshot();`]) {
    const x = clone(); x.source.files.find(f => f.path === 'test/csv.test.mjs').content += statement;
    assertBlocked(review(x), /dynamic|fixtures|snapshots/);
  }
});
test('test/fixture collisions including case and file-directory aliases preserve existing paths', () => {
  for (const existing of ['tests/csv.test.mjs', 'tests/CSV.test.mjs', 'tests/fixtures/cells.json', 'tests/fixtures/cells.json/nested.txt', 'tests/fixtures']) {
    const x = clone(); x.destination.inventory = [...x.destination.files.map(f => f.path), existing];
    assertBlocked(review(x), /collision/);
  }
});
test('ambiguous production path mappings block rather than guess a tested implementation', () => {
  const proposal = structuredClone(demoProposal); proposal.changes[0].path = 'lib/first.mjs';
  proposal.changes.push({ ...proposal.changes[0], path: 'lib/second.mjs' });
  assertBlocked(review(clone(), proposal), /unambiguous/);
});
test('undeclared packages and path aliases in tests block rather than invent a dependency', () => {
  const x = clone(); x.source.files.find(f => f.path === 'test/csv.test.mjs').content += `\nimport 'missing-test-library';`;
  assertBlocked(review(x), /package or alias/);
});
test('AI-authored replacement tests cannot remove assertions or bypass automatic inclusion', () => {
  const proposal = structuredClone(demoProposal);
  proposal.changes.push({ path: 'tests/fake.test.mjs', action: 'add', content: "import test from 'node:test'; test.skip('removed', () => {});", reason: 'fake pass', sourcePaths: ['src/csv.mjs'] });
  assertBlocked(review(clone(), proposal), /provider-authored test changes/);
});
test('source test context overflow blocks patch rather than silently omitting tests', () => {
  const x = clone(); const f = x.source.files.find(f => f.path === 'test/csv.test.mjs');
  f.content += '\n//' + 'x'.repeat(56000); assertBlocked(review(x), /outside selected context/);
});
test('combined change budget cannot discard tests silently', () => {
  const x = clone();
  for (let i = 0; i < 31; i++) addSource(x, `test/extra${i}.test.mjs`, `import test from 'node:test'; import { toCSV } from '../src/csv.mjs'; test('csv ${i}', () => toCSV([]));`);
  assertBlocked(review(x, { ...demoProposal, changes: [demoProposal.changes[0]] }), /budget/);
});
test('filename-related Python tests are reported but not advertised as automatic JS conversion', () => {
  const s = snapshot({ name: 'py', files: [{ path: 'csv.py', content: 'def csv(): pass' }, { path: 'tests/test_csv.py', content: 'def test_csv(): assert True' }] });
  const plan = discoverTests(s, snapshot(demoInput.destination), ['csv.py']);
  assert.equal(plan.tests[0].path, 'tests/test_csv.py'); assert.equal(plan.tests[0].evidence, 'matching-name'); assert.equal(isTestPath('test/foo_test.go'), true);
});
test('no discovered tests is reported as none_found, not a passing suite', () => {
  const x = clone(); x.source.files = x.source.files.filter(f => !f.path.startsWith('test/'));
  const r = review(x); assert.equal(r.testTransfer.status, 'none_found'); assert.equal(r.verification.tests, 'not_run');
});
test('actual sample source and destination baselines pass; applied patch carries working tests and preserves regression suite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graft-tests-e2e-'));
  try {
    for (const role of ['source', 'destination']) for (const f of demoInput[role].files) {
      const target = join(dir, role, f.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, f.content);
    }
    const options = role => ({ cwd: join(dir, role), timeout: 10000, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot ?? '' } });
    const sourceBaseline = execFileSync(process.execPath, ['--test', 'test/csv.test.mjs', 'test/unrelated.test.mjs'], options('source'));
    const destinationBaseline = execFileSync(process.execPath, ['--test', 'tests/task-count.test.mjs'], options('destination'));
    assert.match(sourceBaseline, /# fail 0/); assert.match(destinationBaseline, /# tests 1/);
    const r = demoRun().review, patchPath = join(dir, 'transfer.patch'); await writeFile(patchPath, r.patch);
    execFileSync('git', ['init', '-q'], options('destination'));
    execFileSync('git', ['apply', '--check', patchPath], options('destination'));
    execFileSync('git', ['apply', patchPath], options('destination'));
    const result = execFileSync(process.execPath, ['--test', 'tests/csv.test.mjs', 'tests/task-count.test.mjs'], options('destination'));
    assert.match(result, /# tests 2/); assert.match(result, /# pass 2/); assert.match(result, /# fail 0/);
    assert.equal(await readFile(join(dir, 'destination/tests/task-count.test.mjs'), 'utf8'), demoInput.destination.files.at(-1).content);
    assert.equal(await readFile(join(dir, 'destination/README.md'), 'utf8'), demoInput.destination.files[1].content);
    // Negative control: transported assertions actually detect a broken serializer.
    await writeFile(join(dir, 'destination/src/csv.mjs'), "export const toCSV = () => '';\n");
    assert.throws(() => execFileSync(process.execPath, ['--test', 'tests/csv.test.mjs'], { ...options('destination'), stdio: 'pipe' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('does not rewrite import-like text inside assertions or comments', () => {
  const x = clone();
  editSource(x, 'test/csv.test.mjs', `import test from 'node:test'; import assert from 'node:assert/strict'; import {toCSV} from '../src/csv.mjs';\n// import './not-a-real-dependency.mjs';\ntest('literal stays intact', () => { assert.equal("import './not-a-real-dependency.mjs';", "import './not-a-real-dependency.mjs';"); assert.ok(toCSV([])); });`);
  const r = review(x); assert.equal(r.exportable, true);
  assert.ok(r.changes.find(c => c.path === 'tests/csv.test.mjs').content.includes('assert.equal("import \'./not-a-real-dependency.mjs\';"'));
});
test('ambiguous lexer constructs and computed fixture paths require review rather than editing assertion text', () => {
  for (const text of ['const rx = /from "foo"/;', 'const text = `a template`;', 'readFileSync(fixturePath);']) {
    const x = clone(); x.source.files.find(f => f.path === 'test/csv.test.mjs').content += text;
    assertBlocked(review(x), /parser-backed|fixture reads/);
  }
});
test('plain node tests under test directories are found by their actual test calls', () => {
  const x = clone(); x.source.files.find(f => f.path === 'test/csv.test.mjs').path = 'test/check-csv.mjs';
  const r = review(x); assert.equal(r.testTransfer.discovered, 1); assert.equal(r.exportable, true);
  assert.ok(r.changes.some(c => c.path === 'tests/check-csv.test.mjs'));
});
test('unread destination test layout prevents a false placement decision', () => {
  const x = clone(); x.destination.inventory = [...x.destination.files.map(f => f.path), 'another/tests/check.test.mjs'];
  assertBlocked(review(x), /Destination test configuration or layout/);
});
test('provider cannot replace destination test scripts with a fake success command', () => {
  const x = clone(); x.destination.files.push({ path: 'package.json', content: '{"scripts":{"test":"node --test"}}' });
  const proposal = structuredClone(demoProposal);
  proposal.changes.push({ path: 'package.json', action: 'update', content: '{"scripts":{"test":"echo passed"}}', reason: 'pretend check', sourcePaths: ['src/csv.mjs'] });
  assertBlocked(review(x, proposal), /test environment/);
});

test('tests of a production wrapper target the destination implementation, never a copied source duplicate', () => {
  const x = clone(); addSource(x, 'test/report.test.mjs', `import test from 'node:test'; import { exportReport } from '../src/app.mjs'; test('report', () => exportReport([]));`);
  const r = review(x);
  assert.ok(!r.testTransfer.placements.some(p => p.sourcePath === 'src/app.mjs'));
  assert.ok(r.changes.find(c => c.path === 'tests/report.test.mjs').content.includes("from '../src/app.mjs'"));
  assert.equal(r.verification.tests, 'not_run');
});
