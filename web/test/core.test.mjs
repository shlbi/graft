import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { snapshot, analyze, reviewProposal, rank, stack, unifiedPatch, featureText, LIMITS } from '../lib/core.mjs';
import { eligiblePath, looksSensitive } from '../lib/policy.mjs';
import { demoInput, demoProposal, demoRun } from '../lib/demo.mjs';
const setup = () => {
  const source = snapshot(demoInput.source), destination = snapshot(demoInput.destination);
  return { source, destination, context: analyze(source, destination, 'CSV export').context };
};
const draft = proposal => { const x = setup(); return reviewProposal(proposal, x.source, x.destination, x.context); };
test('snapshot fingerprint is independent of input file order', () => {
  assert.equal(snapshot(demoInput.source).fingerprint, snapshot({ ...demoInput.source, files: [...demoInput.source.files].reverse() }).fingerprint);
});
test('fingerprint changes on content or inventory change', () => {
  const base = snapshot(demoInput.source).fingerprint;
  assert.notEqual(base, snapshot({ ...demoInput.source, files: [...demoInput.source.files, { path: 'a.py', content: 'x = 1' }] }).fingerprint);
  assert.notEqual(base, snapshot({ ...demoInput.source, inventory: [...demoInput.source.files.map(f => f.path), 'unknown.py'] }).fingerprint);
});
test('reject path traversal, absolutes, controls and portable filesystem aliases', () => {
  for (const path of ['../evil.js', '/evil.js', 'a\\b.js', 'a//b.js', './a.js', 'NUL.js', 'a./b.js', 'a\nb.js', 'a%2fb.js']) {
    assert.throws(() => snapshot({ name: 'x', files: [{ path, content: 'x' }] }));
  }
});
test('filters dependency artifacts, credentials and workflow configuration', () => {
  for (const p of ['.env', '.env.local', '.git/config', '.github/workflows/test.yml', 'node_modules/a.js', '.aws/a.json', 'vendor/a.py', 'x.pem']) assert.equal(eligiblePath(p), false, p);
  assert.ok(eligiblePath('src/app/[slug]/page.tsx'));
  assert.ok(eligiblePath('src/(auth)/login.tsx'));
  assert.ok(eligiblePath('lib/export.py'));
});
test('sensitive content and binary text are excluded', () => {
  const value = 'ghp_' + 'a'.repeat(36);
  assert.equal(looksSensitive(value), true);
  const x = snapshot({ name: 'a', files: [{ path: 'a.js', content: value }, { path: 'b.js', content: '\0' }, { path: 'c.js', content: 'export const x = 1;' }] });
  assert.deepEqual(x.skipped, ['a.js', 'b.js']); assert.equal(x.files.length, 1);
});
test('reject duplicate/case-colliding paths and missing inventory entries', () => {
  assert.throws(() => snapshot({ name: 'a', files: [{ path: 'A.js', content: 'a' }, { path: 'a.js', content: 'b' }] }), /colliding/);
  assert.throws(() => snapshot({ ...demoInput.source, inventory: [] }), /inventory/);
});
test('enforces aggregate snapshot and file-count limits', () => {
  assert.throws(() => snapshot({ name: 'a', files: Array.from({ length: 14 }, (_, i) => ({ path: `f${i}.js`, content: 'a'.repeat(60000) })) }), /too large/);
  assert.throws(() => snapshot({ name: 'a', files: Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ path: `f${i}.js`, content: 'a' })) }));
});
test('feature validation refuses blank, huge or credential-shaped text', () => {
  for (const input of ['', 'a', 'x'.repeat(1501), 'Move ghp_' + 'a'.repeat(36)]) assert.throws(() => featureText(input));
});
test('feature ranking prefers matching filenames and expands literal relative imports', () => {
  const { source, context } = setup();
  assert.equal(rank(source.files, 'CSV export')[0].path, 'src/csv.mjs');
  assert.ok(context.source.some(f => f.path === 'src/csv.mjs'));
});
test('identifies different languages without promising cross-language execution', () => {
  const py = snapshot({ name: 'py', files: [{ path: 'src/export.py', content: 'def export_csv(): pass' }] });
  assert.deepEqual(stack(py).languages, ['Python']);
  const x = analyze(py, snapshot(demoInput.destination), 'CSV export');
  assert.equal(x.candidates[0].path, 'src/export.py');
  assert.ok(x.warnings.some(x => x.includes('not complete')));
});
test('reject identical source and destination', () => { const { source } = setup(); assert.throws(() => analyze(source, source, 'csv'), /identical/); });
test('authored demo generates a review with honest verification states and input hashes', () => {
  const x = demoRun(); assert.equal(x.mode, 'synthetic-demo'); assert.equal(x.review.provider, 'authored-demo');
  assert.equal(x.review.changes.length, 2); assert.equal(x.review.verification.build, 'not_run');
  assert.equal(x.review.sourceFingerprint, x.analysis.source.fingerprint); assert.ok(x.review.changes[1].baseHash);
});
test('reject unknown provider fields, deletion, secrets and missing provenance', () => {
  const changes = demoProposal.changes;
  const invalid = [
    { ...demoProposal, execute: 'echo no' },
    { ...demoProposal, changes: [{ ...changes[0], action: 'delete' }] },
    { ...demoProposal, changes: [{ ...changes[0], path: '.github/workflows/run.yml' }] },
    { ...demoProposal, changes: [{ ...changes[0], content: 'ghp_' + 'a'.repeat(36) }] },
    { ...demoProposal, changes: [{ ...changes[0], sourcePaths: ['not-inspected.js'] }] },
    { ...demoProposal, changes: [{ ...changes[0], sourcePaths: [] }] },
    { ...demoProposal, changes: [changes[0], changes[0]] }
  ]; for (const p of invalid) assert.throws(() => draft(p));
});
test('refuse edits to unread destination files and additions over existing files', () => {
  const x = setup();
  const hidden = snapshot({ ...demoInput.destination, inventory: [...demoInput.destination.files.map(f => f.path), 'src/secret-unread.js'] });
  assert.throws(() => reviewProposal({ ...demoProposal, changes: [{ ...demoProposal.changes[0], path: 'src/secret-unread.js', action: 'update' }] }, x.source, hidden, x.context), /inspected/);
  assert.throws(() => draft({ ...demoProposal, changes: [{ ...demoProposal.changes[0], path: 'src/app.mjs' }] }), /overwrite/);
});
test('block file/directory collisions, including unread files and case aliases', () => {
  const x = setup();
  for (const existing of ['src/csv.mjs/child.js', 'src/CSV.mjs']) {
    const target = snapshot({ ...demoInput.destination, inventory: [...demoInput.destination.files.map(f => f.path), existing] });
    assert.throws(() => reviewProposal(demoProposal, x.source, target, x.context), /collision|overwrite/);
  }
});
test('context excludes over-budget content rather than silently slicing existing files', () => {
  const x = snapshot({ name: 'large', files: [{ path: 'csv.js', content: 'x'.repeat(58000) }, { path: 'README.md', content: 'csv' }] });
  const result = analyze(x, snapshot(demoInput.destination), 'csv');
  assert.ok(!result.context.source.some(f => f.path === 'csv.js'));
});
test('exported demo patch applies cleanly and the destination executes with preserved behavior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graft-demo-test-'));
  try {
    await mkdir(join(dir, 'src'));
    for (const file of demoInput.destination.files) await writeFile(join(dir, file.path), file.content);
    const patchPath = join(dir, 'graft.patch'); await writeFile(patchPath, demoRun().review.patch);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['apply', '--check', patchPath], { cwd: dir });
    execFileSync('git', ['apply', patchPath], { cwd: dir });
    const { taskCount, exportTasks } = await import(pathToFileURL(join(dir, 'src/app.mjs')));
    const tasks = [{ name: 'a,"b"', complete: true }, { name: '=SUM(A1:A2)', complete: false }];
    assert.equal(taskCount(tasks), 2);
    assert.equal(exportTasks(tasks), '"Task","Status"\r\n"a,""b""","Done"\r\n"\'=SUM(A1:A2)","Open"\r\n');
    assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), demoInput.destination.files[1].content);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('patch format preserves empty baselines, missing final newline and CRLF', async () => {
  for (const [before, content] of [['old', 'new'], ['', 'new\n'], ['one\r\ntwo\r\n', 'three\r\n'], ['old\n', '']]) {
    const dir = await mkdtemp(join(tmpdir(), 'graft-patch-test-'));
    try {
      await writeFile(join(dir, 'file.txt'), before);
      const p = join(dir, 'patch.diff'); await writeFile(p, unifiedPatch([{ path: 'file.txt', action: 'update', before, content }]));
      execFileSync('git', ['init', '-q'], { cwd: dir }); execFileSync('git', ['apply', '--check', p], { cwd: dir }); execFileSync('git', ['apply', p], { cwd: dir });
      assert.equal(await readFile(join(dir, 'file.txt'), 'utf8'), content);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
