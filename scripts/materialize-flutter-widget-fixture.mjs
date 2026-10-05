/** Emit authored Flutter widget transfers and independent positive/negative host probes. */
import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {flutterWidgetFixture, hostProbe, WIDGET_TEST_NAMES, PRICE_TEST_NAME,
  EXISTING_TEST_NAMES, HOST_TEST_NAMES, UNRELATED_TEST_NAME} from '../web/test/fixtures/flutter-widget-fixture.mjs';

/** Run the existing actual planner/parser/test adapter, never a provider call. */
export async function buildWidgetTransfer(options = {}) {
  const [{snapshot}, {analyze}, {reviewFromAIResponse}] = await Promise.all([
    import('../web/lib/core-base.mjs'), import('../web/lib/core.mjs'), import('../web/lib/ai.mjs'),
  ]);
  const f = flutterWidgetFixture(options);
  const source = snapshot(f.sourceInput), destination = snapshot(f.destinationInput);
  const analysis = analyze(source, destination, 'stateful cart widget pricing and store route', f.selection);
  const response = {status: 'completed', output: [{content: [{type: 'output_text', text: JSON.stringify(f.proposal)}]}]};
  const review = reviewFromAIResponse(response, {source, destination, context: analysis.context});
  return {f, source, destination, analysis, review};
}

/** A control changes one known implementation span, never a test or matcher. */
export function replaceExactly(text, before, after) {
  if (typeof text !== 'string' || !before || text.split(before).length !== 2) throw new Error('Control mutation must match exactly once.');
  return text.replace(before, after);
}

export async function materializeFlutterWidgetFixture(output) {
  if (typeof output !== 'string' || !output.trim()) throw new TypeError('Supply a new output directory.');
  const root = path.resolve(output);
  const {source, destination, review} = await buildWidgetTransfer();
  if (!review.exportable || review.testTransfer.adapter !== 'dart') throw new Error('Widget fixture did not produce an exportable native review.');
  const after = new Map(destination.files.map(f => [f.path, f.content]));
  for (const c of review.changes) after.set(c.path, c.content);
  const withHost = new Map(after);
  const probePath = 'test/repot_acceptance_host_test.dart';
  if (withHost.has(probePath) || review.changes.some(c => c.path === probePath)) throw new Error('Host probe must not be part of the transfer.');
  withHost.set(probePath, hostProbe);
  const missingRoute = new Map(withHost);
  missingRoute.set('lib/main.dart', replaceExactly(withHost.get('lib/main.dart'),
    'Widget cartPage() => const CartPanel();',
    "Widget cartPage() => const Scaffold(body: Center(child: Text('Cart not installed')));"));
  // Keep the import used so analysis succeeds: this control measures missing route wiring,
  // not an unused-import diagnostic. The decoy is never reached by the host route.
  missingRoute.set('lib/main.dart', missingRoute.get('lib/main.dart') + '\nWidget unusedCartFactory() => const CartPanel();\n');
  const brokenUpdate = new Map(withHost);
  brokenUpdate.set('lib/features/cart_panel.dart', replaceExactly(withHost.get('lib/features/cart_panel.dart'), 'units += 1;', 'units += 0;'));
  const missingDispose = new Map(withHost);
  missingDispose.set('lib/features/cart_panel.dart', replaceExactly(withHost.get('lib/features/cart_panel.dart'), '    noteController.dispose();', '    // Negative control: controller disposal omitted.'));
  const movedNames = [...WIDGET_TEST_NAMES, PRICE_TEST_NAME];
  const afterNames = [...EXISTING_TEST_NAMES, ...movedNames];
  const hostNames = [...afterNames, ...HOST_TEST_NAMES];
  const cases = [
    {name: 'source', files: new Map(source.files.map(f => [f.path, f.content])), expected: [...movedNames, UNRELATED_TEST_NAME], expectedFailures: []},
    {name: 'destination-before', files: new Map(destination.files.map(f => [f.path, f.content])), expected: [...EXISTING_TEST_NAMES], expectedFailures: []},
    {name: 'destination-after', files: after, expected: afterNames, expectedFailures: []},
    {name: 'host-positive', files: withHost, expected: hostNames, expectedFailures: []},
    {name: 'host-missing-route', files: missingRoute, expected: hostNames, expectedFailures: [...HOST_TEST_NAMES]},
    {name: 'host-broken-update', files: brokenUpdate, expected: hostNames, expectedFailures: [WIDGET_TEST_NAMES[1], ...HOST_TEST_NAMES]},
    {name: 'host-missing-dispose', files: missingDispose, expected: hostNames, expectedFailures: [WIDGET_TEST_NAMES[3]]},
  ];
  await mkdir(root); // EEXIST is intentional: no existing directory is merged or overwritten.
  const originalFiles = {};
  async function write(relative, text) {
    if (relative.split('/').some(p => !p || p === '.' || p === '..') || relative.includes('\\') || path.isAbsolute(relative)) throw new Error('Unsafe fixture path.');
    const full = path.join(root, relative);
    if (!full.startsWith(root + path.sep)) throw new Error('Escaped fixture root.');
    await mkdir(path.dirname(full), {recursive: true});
    await writeFile(full, text, {flag: 'wx'});
    originalFiles[relative] = createHash('sha256').update(text).digest('hex');
  }
  for (const c of cases) for (const [p, content] of c.files) await write(c.name + '/' + p, content);
  await write('transfer.patch', review.patch);
  await write('review.json', JSON.stringify({scope: 'authored-widget-transfer', proposal: 'authored; no AI call',
    changedFiles: review.changes.map(c => c.path), verification: review.verification,
    testTransfer: review.testTransfer, hostProbesInPatch: false}, null, 2) + '\n');
  const packages = cases.map(({name, expected, expectedFailures}) => ({name, expected, expectedFailures}));
  await write('fixture.json', JSON.stringify({schemaVersion: 1, scope: 'authored-flutter-widget-fixture', packages,
    warning: 'Generated files are not runtime verification. Negative controls are never published.'}, null, 2) + '\n');
  return {directory: root, packages, originalFiles};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [output, ...extra] = process.argv.slice(2);
  if (!output || output.startsWith('--') || extra.length) {
    console.error('Usage: node scripts/materialize-flutter-widget-fixture.mjs NEW_DIRECTORY'); process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await materializeFlutterWidgetFixture(output), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
