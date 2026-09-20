import assert from 'node:assert/strict';
import test from 'node:test';
import { applyIntegrationPlan, prepareIntegrationPlan } from '../dist/integration.js';

const baseline = [
  { path: 'entry.ts', content: "const baseline = true;\n// graft:mount:upload\nconsole.log(baseline);\n" },
  { path: 'untouched.ts', content: 'export const untouched = true;\n' },
];
const mount = {
  id: 'upload-progress',
  targetPath: 'entry.ts',
  marker: '// graft:mount:upload',
  content: "const transplanted = 'upload-progress';",
};

test('prepares an exact reviewable patch and applies only its declared target', () => {
  const plan = prepareIntegrationPlan([mount], baseline);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.touchedTargets, ['entry.ts']);
  assert.equal(plan.patches[0].before, baseline[0].content);
  assert.match(plan.patches[0].after, /transplanted = 'upload-progress'/u);
  assert.equal(plan.patches[0].after.includes(mount.marker), false);

  const applied = applyIntegrationPlan(plan, baseline);
  assert.match(applied[0].content, /upload-progress/u);
  assert.equal(applied[1].content, baseline[1].content);
});

test('blocks missing, ambiguous, duplicate, and stale integration targets', () => {
  const missing = prepareIntegrationPlan([{ ...mount, marker: '// absent' }], baseline);
  assert.deepEqual(missing.blockers.map(item => item.reason), ['marker-missing']);
  assert.throws(() => applyIntegrationPlan(missing, baseline), /contains blockers/u);

  const ambiguousBaseline = [{ path: 'entry.ts', content: '// marker\n// marker\n' }];
  const ambiguous = prepareIntegrationPlan([{ ...mount, marker: '// marker' }], ambiguousBaseline);
  assert.deepEqual(ambiguous.blockers.map(item => item.reason), ['marker-ambiguous']);

  const duplicate = prepareIntegrationPlan([mount, { ...mount, id: 'upload-progress-2' }], baseline);
  assert.deepEqual(duplicate.blockers.map(item => item.reason), ['duplicate-target']);

  const ready = prepareIntegrationPlan([mount], baseline);
  const stale = baseline.map(file => file.path === 'entry.ts' ? { ...file, content: `${file.content}// user edit\n` } : file);
  assert.throws(() => applyIntegrationPlan(ready, stale), /changed after review/u);
});
