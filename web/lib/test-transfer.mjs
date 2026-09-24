/** Test transplant with parser-backed references and bounded, audited runner/setup adaptation. */
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { eligiblePath } from './policy.mjs';
import { parsedReferences as references, applyEdits } from './syntax.mjs';
import { adaptRunner, frameworkPair } from './runner-adapter.mjs';
import { inspectConfiguration, inspectSetupFile } from './test-config.mjs';
export { references };
const code = /\.[cm]?[jt]sx?$/i;
const testDir = /(?:^|\/)(?:tests?|__tests__|spec)\//i;
export const isTestPath = p => /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i.test(p) || (/\.[cm]?[jt]sx?$/.test(p) && /(?:^|\/)__tests__\//.test(p));
export const isTestSupport = p => testDir.test(p) || /(?:^|\/)(?:__mocks__|fixtures?|test-utils|testing)\//i.test(p);
export const isTestConfig = p => /(?:^|\/)(?:(?:jest|vitest|vite|playwright|cypress)\.config\.(?:[cm]?[jt]s|json)|(?:test[-.]?setup|setupTests|conftest)\.[cm]?[jt]sx?|conftest\.py)$/i.test(p);
const isTestFile = f => isTestPath(f.path) || (code.test(f.path) && testDir.test(f.path) && /\b(?:test|it|describe)\s*\(/.test(f.content));
const stem = p => path.posix.basename(p).replace(/\.(?:test|spec)(?=\.[^.]+$)/, '').replace(/^test_|_test(?=\.[^.]+$)/g, '').replace(/\.[^.]+$/, '');
const rootOf = p => p.match(/^(.*?(?:^|\/)(?:tests?|__tests__|spec)\/)/i)?.[1];

function environment(repo) {
  const frameworks = new Set(), dependencies = new Set(), configs = [], packages = [];
  const fileMap = new Map(repo.files.map(f => [f.path, f]));
  for (const f of repo.files) {
    if (/(?:^|\/)package\.json$/.test(f.path)) {
      packages.push(f.path);
      try {
        const p = JSON.parse(f.content), deps = { ...p.dependencies, ...p.devDependencies };
        Object.keys(deps).forEach(d => dependencies.add(d));
        for (const runner of ['vitest', 'jest', 'mocha', '@playwright/test', 'cypress']) if (deps[runner]) frameworks.add(runner);
        if (/\bnode\s+--test\b/.test(p.scripts?.test ?? '')) frameworks.add('node:test');
      } catch { /* Declarative configuration inspection reports malformed packages below. */ }
    }
    if (isTestConfig(f.path)) configs.push(f.path);
    if (isTestFile(f)) {
      const modules = new Set(references(f, fileMap).map(r => r.specifier));
      if (modules.has('node:test')) frameworks.add('node:test');
      if (modules.has('vitest')) frameworks.add('vitest');
      if (modules.has('@jest/globals')) frameworks.add('jest');
      if (modules.has('@playwright/test')) frameworks.add('@playwright/test');
    }
  }
  const tests = repo.files.filter(isTestFile);
  const roots = [...new Set(tests.map(f => rootOf(f.path) ?? '<colocated>'))];
  const markers = [...new Set(tests.map(f => f.path.match(/\.(test|spec)\.[^.]+$/)?.[1]).filter(Boolean))];
  const configuration = inspectConfiguration(repo, [...frameworks].sort(), packages);
  return { frameworks: [...frameworks].sort(), dependencies: [...dependencies].sort(), configs, packages, configuration,
    custom: configuration.issues.length > 0,
    layout: roots.length === 1 ? roots[0] : null, marker: markers.length === 1 ? markers[0] : null,
    examples: tests.slice(0, 4).map(f => f.path) };
}
export function discoverTests(source, destination, featurePaths) {
  const sf = environment(source), df = environment(destination);
  const files = new Map(source.files.map(f => [f.path, f]));
  const setup = new Set(sf.configuration.setup);
  const graph = new Map(source.files.map(f => [f.path, references(f, files)]));
  // Forward production closure then reverse reachability finds tests through wrapper/helper modules.
  const production = new Set(featurePaths.filter(p => files.has(p) && !isTestPath(p) && !isTestSupport(p) && !setup.has(p)));
  for (const p of production) for (const r of graph.get(p) ?? []) if (r.target && !isTestPath(r.target) && !isTestSupport(r.target) && !setup.has(r.target)) production.add(r.target);
  const reaches = new Set(production);
  let changed = true;
  while (changed) { changed = false; for (const [p, refs] of graph) if (!reaches.has(p) && refs.some(r => reaches.has(r.target))) { reaches.add(p); changed = true; } }
  const tests = source.files.filter(f => isTestFile(f) && (reaches.has(f.path) || [...production].some(p => stem(p) === stem(f.path))));
  const needed = new Set([...tests.map(f => f.path), ...(tests.length ? setup : [])]), issues = [];
  for (const p of needed) for (const r of graph.get(p) ?? []) {
    if (r.internal && !r.target) issues.push(`${p}: ${r.ambiguous ? 'ambiguous' : 'unread or unresolved'} dependency ${r.specifier}`);
    if (r.target && !production.has(r.target)) {
      // Never copy a second production implementation merely to make a test pass.
      if (code.test(r.target) && !isTestPath(r.target) && !isTestSupport(r.target) && !setup.has(r.target)) production.add(r.target);
      else needed.add(r.target);
    }
  }
  for (const p of production) for (const r of graph.get(p) ?? []) if (r.target && !isTestPath(r.target) && !isTestSupport(r.target) && !setup.has(r.target)) production.add(r.target);
  const aliasConfigs = [...new Set([...needed].flatMap(p => graph.get(p)?.configPaths ?? []))];
  const complete = source.inventory.filter(eligiblePath).every(p => files.has(p));
  const destinationPaths = new Set(destination.files.map(f => f.path));
  if (destination.inventory.some(p => (isTestPath(p) || isTestConfig(p) || /(?:^|\/)package\.json$/.test(p)) && !destinationPaths.has(p))) issues.push('Destination test configuration or layout is only partially inspected.');
  const unreadTests = source.inventory.filter(p => isTestPath(p) && !files.has(p));
  return { tests: tests.map(f => ({ path: f.path, evidence: reaches.has(f.path) ? 'reverse-import' : 'matching-name' })),
    support: [...needed].filter(p => !tests.some(t => t.path === p)).sort(), featurePaths: [...production].sort(),
    source: sf, destination: df, requiredSource: [...new Set([...needed, ...sf.configs, ...sf.configuration.configPaths, ...aliasConfigs, ...sf.packages])].sort(),
    requiredDestination: [...new Set([...df.examples, ...df.configs, ...df.configuration.configPaths, ...df.configuration.setup, ...df.packages])],
    issues: [...new Set(issues)], unreadTests,
    scope: complete ? 'selected-snapshot' : 'partial-snapshot',
    warnings: ['JS/TS AST references, unique constant expressions, and local tsconfig aliases are inspected; runtime-dependent and black-box tests may still need manual selection.',
      ...(!complete ? ['Partial source inspection: use a complete local snapshot to establish test coverage.'] : []),
      ...(unreadTests.length ? [`${unreadTests.length} known test file(s) were not inspected.`] : [])] };
}
function packageName(spec) { return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]; }
function relativeSpecifier(from, to, original, resource) {
  let result = path.posix.relative(path.posix.dirname(from), to);
  if (!resource && !path.posix.extname(original)) result = result.replace(/\.[cm]?[jt]sx?$/, '');
  if (!resource && /\.js$/.test(original) && /\.ts$/.test(to)) result = result.replace(/\.ts$/, '.js');
  return result.startsWith('.') ? result : './' + result;
}
/** Preserve assertion logic; audit resolved path, runner import, and setup-import edits. */
export function transplantTests(changes, source, destination, plan, context) {
  const blockers = [...plan.issues], placements = [], additions = [], adaptations = [];
  const pair = frameworkPair(plan.source, plan.destination), hooksByPath = new Map();
  const done = () => ({ changes: [...changes, ...additions], report: { status: blockers.length ? 'blocked' : plan.tests.length ? 'included' : 'none_found',
    discovered: plan.tests.length, placements, adaptations, framework: { from: pair.from ?? null, to: pair.to ?? null, conversion: pair.cross, runtimeVerification: 'not_run' }, blockers: [...new Set(blockers)], warnings: plan.warnings,
    assertionPolicy: 'Assertion text preserved. Audited edits are limited to resolved dependency arguments, framework imports, and explicit setup imports. No tests executed.',
    verification: { sourceBaseline: 'not_run', destinationBaseline: 'not_run', transferredTests: 'not_run', destinationRegression: 'not_run' } } });
  // A patch must not silently drop tests that bounded intake could not inspect.
  if (plan.scope === 'partial-snapshot') blockers.push('Test coverage is incomplete in this snapshot. Supply a complete feature-focused local directory including tests.');
  for (const c of changes) if (isTestPath(c.path) || isTestSupport(c.path) || isTestConfig(c.path) || c.sourcePaths.some(p => plan.requiredSource.includes(p))) blockers.push(`${c.path}: provider-authored test changes require review; automatic copies preserve original assertions.`);
  for (const c of changes.filter(c => /(?:^|\/)package\.json$/.test(c.path))) {
    const contract = text => { const p = JSON.parse(text ?? '{}'); return { type: p.type, jest: p.jest, scripts: Object.fromEntries(Object.entries(p.scripts ?? {}).filter(([k]) => /test|coverage/.test(k))), devDependencies: p.devDependencies }; };
    try { if (JSON.stringify(contract(c.before)) !== JSON.stringify(contract(c.content))) blockers.push(`${c.path}: changing the test environment requires review.`); } catch { blockers.push(`${c.path}: unreadable package configuration.`); }
  }
  if (!plan.tests.length) return done();
  if (!pair.valid) blockers.push('Test runners differ, are unknown, or are mixed. Only same-runner and the bounded Jest-to-Vitest adapter are supported.');
  for (const side of ['source', 'destination']) for (const problem of plan[side].configuration.issues) blockers.push(`${side} setup: ${problem}. Configuration was not overwritten.`);
  if (plan.source.configuration.setup.length && plan.destination.configuration.setup.length) blockers.push('Both projects define implicit setup; combining hook order requires explicit review.');
  if (!plan.destination.layout) blockers.push('Destination test location is missing or ambiguous. Provide an existing test layout.');
  const sourceFiles = new Map(source.files.map(f => [f.path, f]));
  const viewed = new Set(context.source.map(f => f.path));
  for (const p of plan.requiredSource) if (!viewed.has(p)) blockers.push(`Test dependency outside selected context: ${p}`);
  const mapping = new Map();
  for (const p of plan.featurePaths) {
    const cited = changes.filter(c => c.sourcePaths.includes(p));
    const exact = cited.filter(c => c.path === p);
    const sameName = cited.filter(c => path.posix.basename(c.path) === path.posix.basename(p));
    const preferred = exact.length ? exact : sameName.length ? sameName : cited;
    if (preferred.length === 1) mapping.set(p, preferred[0].path);
  }
  const taken = new Set(destination.inventory.map(p => p.toLowerCase()));
  const pending = new Set(changes.map(c => c.path.toLowerCase()));
  const root = plan.destination.layout;
  for (const t of plan.tests) {
    const srcRoot = rootOf(t.path);
    let target;
    if (root === '<colocated>') {
      const anchors = [...new Set(references(sourceFiles.get(t.path), sourceFiles).map(r => mapping.get(r.target)).filter(Boolean))];
      if (anchors.length !== 1) { blockers.push(`${t.path}: cannot choose one colocated feature location.`); continue; }
      target = anchors[0].replace(/\.[^.]+$/, '') + `.${plan.destination.marker ?? 'test'}${path.posix.extname(t.path)}`;
    } else if (root) {
      const tail = srcRoot ? t.path.slice(srcRoot.length) : t.path.replace(/^(?:src|lib)\//, '');
      target = root + tail.replace(/\.(?:test|spec)(?=\.[^.]+$)/, '.' + (plan.destination.marker ?? 'test'));
    }
    if (target && code.test(target) && !/\.(?:test|spec)\.[^.]+$/.test(target)) target = target.replace(/(\.[^.]+)$/, '.' + (plan.destination.marker ?? 'test') + '$1');
    if (target) mapping.set(t.path, target);
  }
  for (const p of plan.support) {
    const srcRoot = rootOf(p);
    const base = root === '<colocated>' ? path.posix.dirname(mapping.get(plan.tests[0].path) ?? '') + '/__graft_support__/' : root;
    if (base) mapping.set(p, base + (srcRoot ? p.slice(srcRoot.length) : '_graft/' + p));
  }
  const sourcePackages = new Set(plan.source.dependencies), destPackages = new Set(plan.destination.dependencies);
  for (const p of [...plan.tests.map(t => t.path), ...plan.support]) {
    const file = sourceFiles.get(p), target = mapping.get(p), isTest = plan.tests.some(t => t.path === p);
    if (!file || !target) { blockers.push(`${p}: no safe destination mapping.`); continue; }
    if (isTest && !code.test(p)) { blockers.push(`${p}: automatic test rewriting is currently limited to JavaScript/TypeScript.`); continue; }
    if (!eligiblePath(target) || taken.has(target.toLowerCase()) || pending.has(target.toLowerCase()) || [...taken, ...pending].some(x => x.startsWith(target.toLowerCase() + '/') || target.toLowerCase().startsWith(x + '/'))) { blockers.push(`${p}: destination collision at ${target}; existing files were preserved.`); continue; }
    const replacements = [];
    const refs = references(file, sourceFiles);
    for (const problem of refs.issues ?? []) blockers.push(`${p}: ${problem}.`);
    const adapted = code.test(p) && pair.valid ? adaptRunner(file, pair.from, pair.to) : { edits: [], issues: [], hooks: [], mode: 'unchanged' };
    for (const problem of adapted.issues) blockers.push(`${p}: ${problem}.`);
    replacements.push(...adapted.edits);
    hooksByPath.set(p, adapted.hooks);
    if (adapted.edits.length) adaptations.push({ sourcePath: p, kind: adapted.mode, editCount: adapted.edits.length });
    if (plan.source.configuration.setup.includes(p)) {
      for (const problem of inspectSetupFile(file).issues) blockers.push(`${p}: ${problem}.`);
    }
    for (const r of refs) {
      if (!r.internal) {
        const frameworkModule = pair.from === 'jest' ? '@jest/globals' : pair.from === 'vitest' ? 'vitest' : null;
        if (r.specifier === frameworkModule && pair.valid) {
          if (!sourcePackages.has(pair.from) && !sourcePackages.has(frameworkModule)) blockers.push(`${p}: source framework dependency is not declared.`);
          if (!destPackages.has(pair.to) && !destPackages.has(frameworkModule)) blockers.push(`${p}: destination framework dependency is not declared.`);
          continue;
        }
        if (!r.resource && !isBuiltin(r.specifier) && (!sourcePackages.has(packageName(r.specifier)) || !destPackages.has(packageName(r.specifier)))) blockers.push(`${p}: package or alias ${r.specifier} is not declared in both projects.`);
        continue;
      }
      const mapped = mapping.get(r.target);
      if (!mapped) { blockers.push(`${p}: dependency ${r.specifier} has no unambiguous transferred target.`); continue; }
      const value = relativeSpecifier(target, mapped, r.specifier, r.resource);
      if (value !== r.specifier) replacements.push(r.edit(value));
    }
    let content;
    try { content = applyEdits(file.content, replacements); }
    catch (error) { blockers.push(`${p}: ${error.message}`); continue; }
    if (isTest && plan.source.configuration.setup.length) {
      const imports = [];
      for (const setup of plan.source.configuration.setup) {
        const mapped = mapping.get(setup);
        if (!mapped) { blockers.push(`${p}: configured setup ${setup} has no destination mapping.`); continue; }
        if (!refs.some(r => r.target === setup)) imports.push(`import ${JSON.stringify(relativeSpecifier(target, mapped, './setup.mjs', true))};`);
      }
      if (imports.length) {
        if (content.startsWith('#!')) { blockers.push(`${p}: setup injection into hashbang tests requires review.`); continue; }
        content = imports.join('\n') + '\n' + content;
        adaptations.push({ sourcePath: p, kind: 'explicit-per-file-setup', sourceSetup: plan.source.configuration.setup });
      }
    }
    additions.push({ path: target, action: 'add', content, reason: `${isTest ? 'Preserve feature tests' : 'Include required test support'}; adapt resolved paths and supported runner/setup imports, keeping original assertions and fixture content.`, sourcePaths: [p] });
    pending.add(target.toLowerCase()); placements.push({ sourcePath: p, destinationPath: target, kind: isTest ? 'test' : 'support' });
  }
  if (pair.cross) for (const test of plan.tests) {
    const reached = new Set([test.path, ...plan.source.configuration.setup]);
    for (const p of reached) for (const r of references(sourceFiles.get(p), sourceFiles)) if (r.target && mapping.has(r.target) && !plan.featurePaths.includes(r.target)) reached.add(r.target);
    const counts = new Map();
    for (const p of reached) for (const hook of hooksByPath.get(p) ?? []) counts.set(hook, (counts.get(hook) ?? 0) + 1);
    if ([...counts.values()].some(n => n > 1)) blockers.push(`${test.path}: multiple same-phase hooks have runner-dependent order; explicit lifecycle review is required.`);
  }
  return done();
}
