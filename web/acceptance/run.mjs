/** Real Jest -> Vitest acceptance, restricted to the authored fixtures in this directory. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverRunners, digest, verifyReport } from './evidence.mjs';
import { runnerFixture } from './fixtures.mjs';
import { runProcess } from './process.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export async function acceptancePreflight() {
  const found = discoverRunners();
  // Require an isolated, locked dependency installation; do not reuse an unrelated/global runner.
  let lockHash = null;
  if (found.status === 'ready') {
    try {
      const raw = await readFile(join(here, 'package-lock.json'), 'utf8');
      const lock = JSON.parse(raw);
      const manifest = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
      for (const [name, runner] of Object.entries(found.runners)) {
        ensure(runner.packageFile === join(here, 'node_modules', name, 'package.json'), `${name} must be installed inside acceptance/node_modules.`);
        ensure(manifest.devDependencies?.[name] === runner.version, `${name} must have an exact package.json development dependency pin.`);
        const entry = lock.packages?.['node_modules/' + name];
        ensure(entry?.version === runner.version && typeof entry.integrity === 'string', `${name} does not match a pinned integrity-bearing lockfile entry.`);
      }
      lockHash = digest(raw);
    } catch (error) { found.blockers.push('Runner lock: ' + error.message); }
  }
  if (!['linux', 'darwin'].includes(process.platform)) found.blockers.push('This gate requires POSIX process-group cleanup; Windows is not verified.');
  return { ...found, status: found.blockers.length ? 'blocked' : 'ready', lockHash };
}
async function materialize(files, root) {
  for (const file of files) {
    const target = join(root, file.path);
    ensure(target.startsWith(root + '/'), 'Fixture path escaped its scratch directory.');
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content);
  }
}
async function runnerResult(name, cwd, reportFile, runners, names, options = {}) {
  const entry = runners[name].entry;
  const args = name === 'jest'
    ? ['--experimental-vm-modules', entry, '--runInBand', '--no-cache', '--ci', '--json', '--outputFile=' + reportFile]
    : [entry, 'run', '--maxWorkers=1', '--no-file-parallelism', '--reporter=json', '--outputFile=' + reportFile];
  const processResult = await runProcess(process.execPath, args, cwd);
  let report;
  try { report = JSON.parse(await readFile(reportFile, 'utf8')); }
  catch { throw new Error(`${name} did not produce its required JSON report (exit ${processResult.exitCode}).`); }
  return { ...verifyReport(report, processResult.exitCode, names, options),
    runner: name, version: runners[name].version, reportHash: digest(JSON.stringify(report)),
    stdoutHash: digest(processResult.stdout), stderrHash: digest(processResult.stderr) };
}
async function oneCase(kind, scratch, runners, core) {
  const versions = Object.fromEntries(Object.entries(runners).map(([name, runner]) => [name, runner.version]));
  const fixture = runnerFixture(kind, versions), caseDir = join(scratch, kind);
  const sourceDir = join(caseDir, 'source'), destinationDir = join(caseDir, 'destination');
  await materialize(fixture.source.files, sourceDir); await materialize(fixture.destination.files, destinationDir);
  const source = core.snapshot(fixture.source), destination = core.snapshot(fixture.destination);
  const analysis = core.analyze(source, destination, 'greeting');
  const review = core.reviewProposal(fixture.proposal, source, destination, analysis.context, 'authored-runner-acceptance');
  ensure(review.exportable && review.patch, 'Graft blocked the authored runner case: ' + review.testTransfer?.blockers.join('; '));
  const reportPath = label => join(caseDir, label + '.json');
  const sourceBaseline = await runnerResult('jest', sourceDir, reportPath('source'), runners, fixture.sourceTestNames);
  const destinationBaseline = await runnerResult('vitest', destinationDir, reportPath('baseline'), runners, fixture.destinationTestNames);
  const patchPath = join(caseDir, 'graft.patch'); await writeFile(patchPath, review.patch);
  for (const args of [['init', '--quiet'], ['apply', '--check', patchPath], ['apply', patchPath]]) {
    const result = await runProcess('git', args, destinationDir);
    ensure(result.exitCode === 0, 'Git patch check/application failed.');
  }
  for (const original of fixture.destination.files) ensure(await readFile(join(destinationDir, original.path), 'utf8') === original.content, `Destination baseline changed: ${original.path}`);
  for (const change of review.changes) ensure(await readFile(join(destinationDir, change.path), 'utf8') === change.content, `Applied bytes differ from the reviewed patch: ${change.path}`);
  const allNames = [...fixture.sourceTestNames, ...fixture.destinationTestNames];
  const destinationAfter = await runnerResult('vitest', destinationDir, reportPath('after'), runners, allNames);
  await writeFile(join(destinationDir, 'lib/greeting.js'), "export const greeting = () => 'BROKEN';\n");
  const brokenFeature = await runnerResult('vitest', destinationDir, reportPath('broken-feature'), runners, allNames,
    { negative: true, mustFail: fixture.sourceTestNames });
  await writeFile(join(destinationDir, 'lib/greeting.js'), fixture.proposal.changes[0].content);
  let removedSetup = null;
  if (kind === 'shared-setup') {
    const placement = review.testTransfer.placements.find(p => p.sourcePath === 'test/setup.js');
    ensure(placement, 'Shared setup was not transported.');
    const setupPath = join(destinationDir, placement.destinationPath), original = await readFile(setupPath, 'utf8');
    await writeFile(setupPath, '// Negative control: hook registration removed, module still imports.\n');
    removedSetup = await runnerResult('vitest', destinationDir, reportPath('missing-setup'), runners, allNames,
      { negative: true, mustFail: fixture.sourceTestNames });
    await writeFile(setupPath, original);
  }
  const recovery = await runnerResult('vitest', destinationDir, reportPath('restored'), runners, allNames);
  return { kind, sourceFingerprint: source.fingerprint, destinationFingerprint: destination.fingerprint,
    reviewId: review.id, patchHash: digest(review.patch), placements: review.testTransfer.placements,
    sourceBaseline, destinationBaseline, destinationAfter, brokenFeature, removedSetup, recovery };
}
export async function runAcceptance({ preflightOnly = false } = {}) {
  const preflight = await acceptancePreflight();
  const report = { schema: 'graft-real-runner-acceptance-v1', startedAt: new Date().toISOString(),
    status: preflight.status, scope: 'Original synthetic cases only; no uploaded repository code, paid APIs, or CI.',
    runtime: process.version, platform: process.platform, lockHash: preflight.lockHash,
    runners: Object.fromEntries(Object.entries(preflight.runners).map(([name, { version, packageHash, entryHash }]) => [name, { version, packageHash, entryHash }])),
    blockers: preflight.blockers, cases: [] };
  if (preflightOnly || preflight.status !== 'ready') return { ...report, finishedAt: new Date().toISOString() };
  let scratch;
  try {
    const core = await import('../lib/core.mjs');
    scratch = await mkdtemp(join(here, '.runner-acceptance-'));
    for (const kind of ['named-imports', 'global-apis', 'shared-setup']) report.cases.push(await oneCase(kind, scratch, preflight.runners, core));
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.blockers.push(error.message); }
  finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { preflight: { type: 'boolean', default: false }, report: { type: 'string' } }, allowPositionals: false });
    const report = await runAcceptance({ preflightOnly: values.preflight });
    const text = JSON.stringify(report, null, 2) + '\n';
    if (values.report) await writeFile(values.report, text, { flag: 'wx' });
    process.stdout.write(text);
    process.exitCode = report.status === 'passed' || (values.preflight && report.status === 'ready') ? 0 : report.status === 'blocked' ? 2 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
