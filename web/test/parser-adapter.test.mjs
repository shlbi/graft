import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, analyze, reviewProposal } from '../lib/core.mjs';
import { references } from '../lib/test-transfer.mjs';
import { parse, staticString, applyEdits } from '../lib/syntax.mjs';
import { staticConfig } from '../lib/test-config.mjs';
import { demoInput, demoProposal } from '../lib/demo.mjs';
const f = (path, content) => ({ path, content });
const pkg = (runner, extra = {}) => f('package.json', JSON.stringify({ type: 'module', devDependencies: { [runner]: '*' }, ...extra }));
function input() {
  return {
    source: { name: 'jest-source', files: [f('src/csv.mjs', 'export const csv = value => value.toUpperCase();\n'), pkg('jest'), f('test/csv.test.mjs', "import { test, expect } from '@jest/globals';\nimport { csv } from '../src/csv.mjs';\ntest('CSV', () => { expect(csv('hello')).toBe('HELLO'); });\n")] },
    destination: { name: 'vitest-destination', files: [pkg('vitest'), f('spec/existing.spec.mjs', "import {test, expect} from 'vitest'; test('existing', () => expect(2 + 2).toBe(4));\n")] }
  };
}
const proposal = { summary: 'Move csv', changes: [{ path: 'lib/csv.mjs', action: 'add', content: 'export const csv = value => value.toUpperCase();\n', reason: 'Move csv into destination', sourcePaths: ['src/csv.mjs'] }], risks: [], suggestedChecks: [] };
function run(x = input(), prop = proposal) {
  const s = snapshot(x.source), d = snapshot(x.destination), a = analyze(s, d, 'csv');
  return { analysis: a, review: reviewProposal(prop, s, d, a.context) };
}
const sourceTest = x => x.source.files.find(p => p.path === 'test/csv.test.mjs');
function blocked(x, regex) { const r = run(x).review; assert.equal(r.exportable, false); assert.equal(r.patch, null); assert.match(r.testTransfer.blockers.join('\n'), regex); }
function ref(content, others = []) { const file = f('tests/check.test.mjs', content); return references(file, new Map([file, ...others].map(f => [f.path, f]))); }

test('AST reference extraction ignores comments, assertion strings, templates, regex and division', () => {
  const text = "import {csv} from '../src/csv.mjs'; const rx = /from 'not-a-module'/; const n = 4 / 2; const txt = `import 'fake'`; expect(txt).toMatch(/import/);";
  const rs = ref(text, [f('src/csv.mjs', '')]);
  assert.equal(rs.length, 1); assert.equal(rs[0].target, 'src/csv.mjs'); assert.deepEqual(rs.issues, []);
});
test('literal dynamic imports and unique constant/concatenated/template paths resolve without eval', () => {
  const content = "const BASE = '../src/'; const NAME = 'csv'; await import(`${BASE}${NAME}.mjs`); const path = './fixtures/' + NAME + '.json'; readFileSync(new URL(path, import.meta.url));";
  const rs = ref(content, [f('src/csv.mjs', ''), f('tests/fixtures/csv.json', '[]')]);
  assert.deepEqual(rs.map(r => r.target), ['src/csv.mjs', 'tests/fixtures/csv.json']); assert.deepEqual(rs.issues, []);
  const edited = applyEdits(content, [rs[0].edit('../lib/csv.mjs')]);
  assert.ok(edited.includes('await import("../lib/csv.mjs")')); assert.ok(edited.includes("const BASE = '../src/'"));
});
test('runtime paths, mutable bindings, calls and shadowed const names are not evaluated', () => {
  for (const code of ["let NAME = '../src/csv.mjs'; import(NAME);", "const NAME = pick(); import(NAME);", "const NAME = '../src/csv.mjs'; function f(NAME) { return import(NAME); }", "import(process.env.MODULE);"]) {
    assert.match(ref(code).issues.join('\n'), /dynamic import/);
  }
});
test('escaped literal paths rewrite by parser spans rather than decoded string length', () => {
  const text = "import '../src/\\u0063sv.mjs'; const literal = 'unchanged';", rs = ref(text, [f('src/csv.mjs', '')]);
  assert.equal(rs[0].target, 'src/csv.mjs'); assert.equal(applyEdits(text, [rs[0].edit('../lib/long.mjs')]), "import '../lib/long.mjs'; const literal = 'unchanged';");
});
test('URL fixture constants are accepted only when not escaping or mutable through properties', () => {
  const good = "const file = new URL('./data.json', import.meta.url); readFileSync(file);";
  assert.deepEqual(ref(good, [f('tests/data.json', '{}')]).issues, []);
  assert.match(ref(good + "file.pathname = '/outside';").issues.join('\n'), /mutated/);
  assert.match(ref(good + 'other(file);').issues.join('\n'), /mutated/);
});
test('directory globs, snapshots, file-relative escape and cwd-dependent reads stay blocked', () => {
  for (const code of ["import.meta.glob('./*.js');", "readFileSync('./data.json');", "const p = process.cwd();", "expect(x).toMatchSnapshot();", "require('../../outside');"]) assert.ok(ref(code).issues.length);
});
test('invalid JS syntax is reported instead of accepting a partially recovered parser tree', () => { assert.match(ref('import { from "./x";').issues.join('\n'), /syntax/); });
test('local tsconfig paths find reverse tests and become explicit relative imports', () => {
  const x = input(); x.source.files.push(f('tsconfig.json', '{ // retained comment\n "compilerOptions": {"baseUrl":".", "paths":{"@source/*":["src/*"]}}}'));
  sourceTest(x).content = sourceTest(x).content.replace('../src/csv.mjs', '@source/csv.mjs');
  const { analysis, review: r } = run(x);
  assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n')); assert.equal(analysis.testPlan.tests[0].evidence, 'reverse-import');
  assert.ok(analysis.context.source.some(f => f.path === 'tsconfig.json'));
  assert.ok(r.changes.find(f => f.path === 'spec/csv.spec.mjs').content.includes("from '../lib/csv.mjs'"));
  assert.ok(!r.changes.some(f => f.path === 'tsconfig.json'));
});
test('inherited/multi-target/unread aliases require review', () => {
  for (const config of [{ extends: './base.json', compilerOptions: { paths: { '@source/*': ['src/*'] } } }, { compilerOptions: { paths: { '@source/*': ['src/*', 'lib/*'] } } }]) {
    const x = input(); x.source.files.push(f('tsconfig.json', JSON.stringify(config))); sourceTest(x).content = sourceTest(x).content.replace('../src/csv.mjs', '@source/csv.mjs'); blocked(x, /alias|tsconfig/);
  }
});
test('Jest named imports adapt to Vitest with assertion text preserved and verification unrun', () => {
  const x = input(), { review: r } = run(x);
  assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n'));
  assert.equal(r.changes.find(f => f.path === 'spec/csv.spec.mjs').content, sourceTest(x).content.replace("'@jest/globals'", "'vitest'").replace('../src/csv.mjs', '../lib/csv.mjs'));
  assert.equal(r.testTransfer.framework.conversion, true); assert.equal(r.testTransfer.framework.runtimeVerification, 'not_run');
  assert.deepEqual(Object.values(r.testTransfer.verification), Array(4).fill('not_run'));
});
test('Jest global tests gain explicit Vitest imports without changing destination globals', () => {
  const x = input(); sourceTest(x).content = sourceTest(x).content.replace("import { test, expect } from '@jest/globals';\n", '');
  const r = run(x).review; assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n'));
  const text = r.changes.find(c => c.path === 'spec/csv.spec.mjs').content;
  assert.match(text, /import \{ expect, test \} from 'vitest'/); assert.ok(text.includes("expect(csv('hello')).toBe('HELLO')"));
  assert.ok(!r.changes.some(c => c.path === 'package.json' || /config/.test(c.path)));
});
test('named API aliases survive cross-runner adaptation', () => {
  const x = input(); sourceTest(x).content = "import {test as check, expect as verify} from '@jest/globals'; import {csv} from '../src/csv.mjs'; check('csv', () => verify(csv('hello')).toBe('HELLO'));";
  const r = run(x).review; assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n')); assert.match(r.patch, /test as check, expect as verify/);
});
test('module mocks, timers, callback done, snapshots and unsupported assertions never get blind conversion', () => {
  for (const body of ["jest.mock('./x');", "jest.useFakeTimers();", "test('done', done => done());", "expect(1).toMatchInlineSnapshot();", "expect.extend({});", "expect(1)['toBe'](1);", "test.only('only', () => {});", "test('reference', callback);"]) {
    const x = input(); sourceTest(x).content += body; blocked(x, /review|adapter|Snapshot|callbacks/);
  }
});
test('framework namespace/default imports and shadowed assertion aliases block conversion', () => {
  for (const extra of ["import * as api from '@jest/globals';", "import api from '@jest/globals';", 'function helper(expect) { return expect; }']) {
    const x = input(); sourceTest(x).content += extra; blocked(x, /framework|shadowed/);
  }
});
test('unsupported reverse conversion is not advertised as supported', () => {
  const x = input(); [x.source, x.destination] = [x.destination, x.source]; x.source.files.push(f('src/csv.mjs', proposal.changes[0].content), f('tests/csv.test.mjs', "import {test} from 'vitest'; import{csv} from '../src/csv.mjs'; test('csv', () => csv('x'));")); blocked(x, /runners differ/);
});
test('same-runner Vitest globals normalize to explicit imports for a globals-disabled destination', () => {
  const x = input(); x.source.files[1] = pkg('vitest'); sourceTest(x).content = sourceTest(x).content.replace("import { test, expect } from '@jest/globals';\n", '');
  x.source.files.push(f('vitest.config.mjs', 'export default {test:{globals:true}};'));
  x.destination.files.push(f('vitest.config.mjs', 'export default {test:{globals:false}};'));
  const r = run(x).review; assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n')); assert.match(r.patch, /import \{ expect, test \} from 'vitest'/);
});
test('static config reads literal ESM/CJS/defineConfig/JSON but never executes it', () => {
  for (const file of [f('jest.config.mjs', "export default {testEnvironment:'node'};"), f('jest.config.cjs', "module.exports = {testEnvironment:'node'};"), f('vitest.config.ts', "import { defineConfig as config } from 'vitest/config'; export default config({test:{environment:'node'}});"), f('jest.config.json', '{"testEnvironment":"node"}')]) assert.ok(staticConfig(file));
  for (const code of ["export default fetch('https://example.invalid');", "export default {...process.env};", "process.exit(); export default {};", "import c from './config'; export default c;", 'export default {get test(){return {}}};', 'export default {__proto__:{}};', 'export default {test: {}, test: {}};']) assert.throws(() => staticConfig(f('vitest.config.mjs', code)));
});
function addSetup(x) {
  x.source.files.push(f('jest.config.mjs', "export default {testEnvironment:'node', transform:{}, setupFilesAfterEnv:['<rootDir>/test/setupTests.mjs']};"),
    f('test/setupTests.mjs', "import {beforeEach} from '@jest/globals'; import {reset} from './support/state.mjs'; beforeEach(() => { reset(); });"),
    f('test/support/state.mjs', 'export const reset = () => {};'));
}
test('configured hook setup travels with its dependency closure and becomes a per-file import', () => {
  const x = input(); addSetup(x); const { analysis, review: r } = run(x);
  assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n'));
  assert.ok(analysis.testPlan.support.includes('test/setupTests.mjs')); assert.ok(analysis.testPlan.support.includes('test/support/state.mjs'));
  assert.match(r.changes.find(c => c.path === 'spec/csv.spec.mjs').content, /^import "\.\/setupTests.mjs";/);
  assert.match(r.changes.find(c => c.path === 'spec/setupTests.mjs').content, /from 'vitest'/);
  assert.ok(!r.changes.some(c => /config/.test(c.path)));
});
test('setup side effects, implicit returns and multiple hooks block until lifecycle review', () => {
  for (const change of ["globalThis.polluted = true;", "beforeEach(() => reset());", "beforeEach(() => { return reset(); });", "beforeEach(() => { reset(); });"]) {
    const x = input(); addSetup(x); x.source.files.find(f => f.path === 'test/setupTests.mjs').content += change; blocked(x, /setup|hooks/);
  }
});
test('two implicit setup environments are not merged silently', () => {
  const x = input(); addSetup(x); x.destination.files.push(f('vitest.config.mjs', "export default {test:{setupFiles:['spec/setup.mjs']}};"), f('spec/setup.mjs', "import {beforeEach} from 'vitest'; beforeEach(() => {});")); blocked(x, /Both projects/);
});
test('missing, plural, global setup, custom transforms and environment config require review', () => {
  for (const config of [{setupFilesAfterEnv:['./missing.mjs']}, {globalSetup:'./setup.mjs'}, {setupFiles:['./setup.mjs']}, {testEnvironment:'jsdom'}, {transform:{'^.+$':'babel-jest'}}, {testMatch:['**/custom.js']}]) {
    const x = input(); x.source.files.push(f('jest.config.json', JSON.stringify(config))); blocked(x, /setup|configuration|environment/);
  }
});
test('overlapping parser edit ranges fail closed', () => { assert.throws(() => applyEdits('abcdef', [{start:1,end:4,value:'x'}, {start:2,end:5,value:'y'}]), /Overlapping/); });
test('AST-assisted transfer executes dynamic fixture imports and shared hook support, with negative control', async () => {
  const x = structuredClone(demoInput), srcTest = x.source.files.find(f => f.path === 'test/csv.test.mjs');
  srcTest.content = "import test from 'node:test'; import assert from 'node:assert/strict'; import './setupTests.mjs'; import {state} from './support/state.mjs'; const MOD = '../src/' + 'csv.mjs'; import {readFileSync} from 'node:fs'; const NAME = 'cells'; const fixture = new URL(`./fixtures/${NAME}.json`, import.meta.url); test('CSV dynamic', async () => {const {toCSV} = await import(MOD); assert.equal(state.ready, true); assert.match(toCSV(JSON.parse(readFileSync(fixture, 'utf8'))), /hello/); assert.equal(4 / 2, 2); assert.equal(`regex ${2}`, 'regex 2');});\n";
  x.source.files.push(f('test/setupTests.mjs', "import {beforeEach} from 'node:test'; import {state} from './support/state.mjs'; beforeEach(() => {state.ready = true;});"), f('test/support/state.mjs', 'export const state = {ready:false};'));
  const options = structuredClone(demoProposal); options.changes[0].path = 'lib/csv.mjs'; options.changes[1].content = options.changes[1].content.replace('./csv.mjs', '../lib/csv.mjs');
  const { review: r } = run(x, options); assert.equal(r.exportable, true, r.testTransfer.blockers.join('\n'));
  const dir = await mkdtemp(join(tmpdir(), 'graft-parser-e2e-'));
  const execute = (role, args) => execFileSync(process.execPath, ['--test', ...args], {cwd:join(dir,role),encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH},stdio:'pipe'});
  try {
    for (const role of ['source','destination']) for (const file of x[role].files) {const full=join(dir,role,file.path); await mkdir(dirname(full),{recursive:true}); await writeFile(full,file.content);}
    assert.match(execute('source',['test/csv.test.mjs','test/unrelated.test.mjs']), /# pass 2/);
    assert.match(execute('destination',['tests/task-count.test.mjs']), /# pass 1/);
    const patch=join(dir,'transfer.patch'); await writeFile(patch,r.patch);
    execFileSync('git',['init','-q'],{cwd:join(dir,'destination')});
    for (const args of [['apply','--check',patch],['apply',patch]]) execFileSync('git',args,{cwd:join(dir,'destination'),timeout:5000});
    assert.match(execute('destination',['tests/csv.test.mjs','tests/task-count.test.mjs']), /# pass 2/);
    assert.equal(await readFile(join(dir,'destination/tests/task-count.test.mjs'),'utf8'),x.destination.files.at(-1).content);
    await writeFile(join(dir,'destination/tests/setupTests.mjs'),'// deliberately broken hook\n');
    assert.throws(() => execute('destination',['tests/csv.test.mjs']));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('global framework access, import.meta and per-file environment overrides do not slip through conversion', () => {
  for (const added of ['globalThis.jest.mock("x");', 'import.meta.jest.useFakeTimers();', 'process.env.JEST_WORKER_ID;', 'window.test("x", () => {});']) {const x=input();sourceTest(x).content+=added;blocked(x,/review|adapter/);}
  const x=input();sourceTest(x).content='/** @jest-environment jsdom */\n'+sourceTest(x).content;blocked(x,/environment/);
});
test('nested declarations cannot make a genuinely global test API disappear from conversion', () => {
  const x=input();sourceTest(x).content=sourceTest(x).content.replace("import { test, expect } from '@jest/globals';\n",'')+'\nfunction helper(test) { return test; }';blocked(x,/scope review/);
});
test('framework-looking strings and comments do not make the source runner appear mixed', () => {
  const x=input();sourceTest(x).content+='\nconst doc = "import from node:test"; // import "node:test"\n';assert.equal(run(x).review.exportable,true);
});
test('parsed cache does not reuse a stale AST after file content changes', () => {
  const file=f('a.js',"const value = 'before';");const before=parse(file);file.content="const value = 'after';";const after=parse(file);
  assert.notEqual(before,after);assert.equal(staticString(after.constants.get('value'),after),'after');
});
test('nested config roots are blocked instead of guessing Vitest cwd or Jest rootDir semantics', () => {
  const x=input();x.source.files.push(f('config/jest.config.mjs',"export default {testEnvironment:'node'};"));blocked(x,/root-scoped/);
});


test('malformed declarative config and shadowed require fail closed without evaluation', () => {
  for (const body of ['null', '[]', '42']) assert.throws(() => staticConfig(f('vitest.config.json', body)), /object|configuration/);
  const files = new Map([['tsconfig.json', f('tsconfig.json', 'null')]]);
  assert.match(references(f('test/check.test.ts', "import {csv} from '@/csv';"), files).issues.join(' '), /tsconfig/);
  const x = input(); x.source.files.push(f('vitest.config.json', 'null')); blocked(x, /configuration/);
  const refs = references(f('tests/check.mjs', "function require(p) {return p;} require('../feature.mjs');"), new Map());
  assert.equal(refs.length, 0); assert.match(refs.issues.join(' '), /shadowed/);
});
