/** Conservative test transplant: no source execution, framework conversion, or assertion edits. */
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { eligiblePath } from './policy.mjs';
const code = /\.[cm]?[jt]sx?$/i;
const testDir = /(?:^|\/)(?:tests?|__tests__|spec)\//i;
export const isTestPath = p => /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:py|go)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i.test(p) || (/\.[cm]?[jt]sx?$/.test(p) && /(?:^|\/)__tests__\//.test(p));
export const isTestSupport = p => testDir.test(p) || /(?:^|\/)(?:__mocks__|fixtures?|test-utils|testing)\//i.test(p);
export const isTestConfig = p => /(?:^|\/)(?:(?:jest|vitest|vite|playwright|cypress)\.config\.[cm]?[jt]s|(?:test[-.]?setup|setupTests|conftest)\.[cm]?[jt]sx?|conftest\.py)$/i.test(p);
const isTestFile = f => isTestPath(f.path) || (code.test(f.path) && testDir.test(f.path) && /\b(?:test|it|describe)\s*\(/.test(f.content));
const stem = p => path.posix.basename(p).replace(/\.(?:test|spec)(?=\.[^.]+$)/, '').replace(/^test_|_test(?=\.[^.]+$)/g, '').replace(/\.[^.]+$/, '');
const rootOf = p => p.match(/^(.*?(?:^|\/)(?:tests?|__tests__|spec)\/)/i)?.[1];

// A small conservative lexer prevents rewriting apparent imports inside assertions/comments.
// Templates and regular-expression/division tokens need manual review in copied JS/TS.
function lex(text) {
  const tokens = [], issues = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); if (end < 0) issues.push('unterminated comment'); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const start = ++i; let escaped = false;
      while (i < text.length && text[i] !== c) { if (text[i] === '\\') { escaped = true; i += 2; } else i++; }
      if (i >= text.length) issues.push('unterminated literal');
      if (c === '`') issues.push('template literal requires parser-backed review');
      tokens.push({ kind: c === '`' ? 'template' : 'string', value: text.slice(start, i), offset: start, escaped }); i++; continue;
    }
    if (c === '/') {
      issues.push('regex or division requires parser-backed review');
      // Do not interpret regex text as import syntax, even when it contains quotes.
      i++; while (i < text.length && !['/', '\n'].includes(text[i])) { if (text[i] === '\\') i += 2; else i++; } if (text[i] === '/') i++; continue;
    }
    if (/[\w$]/.test(c)) { const start = i++; while (i < text.length && /[\w$]/.test(text[i])) i++; tokens.push({ kind: 'word', value: text.slice(start, i) }); continue; }
    tokens.push({ kind: 'punct', value: c }); i++;
  }
  return { tokens, issues };
}

/** Literal imports/re-exports/require and import.meta.url-relative fixture references only. */
export function references(file, files) {
  const refs = [];
  if (!code.test(file.path)) return refs;
  const { tokens: ts, issues } = lex(file.content);
  const value = i => ts[i]?.value;
  const add = (token, resource = false) => {
    if (!token || token.kind !== 'string') return;
    if (token.escaped) { issues.push('escaped module/resource specifier'); return; }
    const specifier = token.value;
    let target = null, ambiguous = false;
    if (specifier.startsWith('.')) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
      const candidates = [...new Set(files.has(base) ? [base] : [base.replace(/\.js$/, '.ts'), base.replace(/\.jsx$/, '.tsx'), ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'].map(ext => base + ext)].filter(p => files.has(p)))];
      target = candidates.length === 1 ? candidates[0] : null; ambiguous = candidates.length > 1;
    }
    if (!refs.some(r => r.offset === token.offset)) refs.push({ specifier, offset: token.offset, target, ambiguous, resource });
  };
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].kind !== 'word' || value(i - 1) === '.') continue;
    const word = value(i);
    if (word === 'import' || word === 'require') {
      if (value(i + 1) === '(') {
        if (ts[i + 2]?.kind === 'string' && [')', ','].includes(value(i + 3))) add(ts[i + 2]);
        else issues.push('dynamic import/require');
      } else if (word === 'import' && ts[i + 1]?.kind === 'string') add(ts[i + 1]);
    }
    if (['import', 'export'].includes(word) && !['(', '.'].includes(value(i + 1))) {
      for (let j = i + 1; j < Math.min(ts.length, i + 200) && value(j) !== ';'; j++) {
        if (value(j) === 'from' && ts[j]?.kind === 'word') { add(ts[j + 1]); break; }
      }
    }
    if (word === 'new' && value(i + 1) === 'URL' && value(i + 2) === '(' && ts[i + 3]?.kind === 'string' && ts.slice(i + 4, i + 11).map(t => t.value).join('') === ',import.meta.url)') add(ts[i + 3], true);
  }
  Object.defineProperty(refs, 'issues', { value: [...new Set(issues)] });
  return refs;
}

function environment(repo) {
  const frameworks = new Set(), dependencies = new Set(), configs = [], packages = [];
  let custom = false;
  for (const f of repo.files) {
    if (/(?:^|\/)package\.json$/.test(f.path)) {
      packages.push(f.path);
      try {
        const p = JSON.parse(f.content), deps = { ...p.dependencies, ...p.devDependencies };
        Object.keys(deps).forEach(d => dependencies.add(d));
        for (const runner of ['vitest', 'jest', 'mocha', '@playwright/test', 'cypress']) if (deps[runner]) frameworks.add(runner);
        if (/\bnode\s+--test\b/.test(p.scripts?.test ?? '')) frameworks.add('node:test');
        if (p.jest || p.workspaces || p.scripts?.test?.match(/--(?:require|import|loader|setup)/)) custom = true;
      } catch { custom = true; }
    }
    if (isTestConfig(f.path)) configs.push(f.path);
    if (isTestFile(f)) {
      if (/['"]node:test['"]/.test(f.content)) frameworks.add('node:test');
      if (/['"]vitest['"]/.test(f.content)) frameworks.add('vitest');
      if (/['"]@jest\/globals['"]/.test(f.content)) frameworks.add('jest');
      if (/['"]@playwright\/test['"]/.test(f.content)) frameworks.add('@playwright/test');
    }
  }
  const tests = repo.files.filter(isTestFile);
  const roots = [...new Set(tests.map(f => rootOf(f.path) ?? '<colocated>'))];
  const markers = [...new Set(tests.map(f => f.path.match(/\.(test|spec)\.[^.]+$/)?.[1]).filter(Boolean))];
  return { frameworks: [...frameworks].sort(), dependencies: [...dependencies].sort(), configs, packages,
    custom: custom || configs.length > 0 || packages.length > 1,
    layout: roots.length === 1 ? roots[0] : null, marker: markers.length === 1 ? markers[0] : null,
    examples: tests.slice(0, 4).map(f => f.path) };
}
export function discoverTests(source, destination, featurePaths) {
  const files = new Map(source.files.map(f => [f.path, f]));
  const graph = new Map(source.files.map(f => [f.path, references(f, files)]));
  // Forward production closure then reverse reachability finds tests through wrapper/helper modules.
  const production = new Set(featurePaths.filter(p => files.has(p) && !isTestPath(p) && !isTestSupport(p)));
  for (const p of production) for (const r of graph.get(p) ?? []) if (r.target && !isTestPath(r.target) && !isTestSupport(r.target)) production.add(r.target);
  const reaches = new Set(production);
  let changed = true;
  while (changed) { changed = false; for (const [p, refs] of graph) if (!reaches.has(p) && refs.some(r => reaches.has(r.target))) { reaches.add(p); changed = true; } }
  const tests = source.files.filter(f => isTestFile(f) && (reaches.has(f.path) || [...production].some(p => stem(p) === stem(f.path))));
  const needed = new Set(tests.map(f => f.path)), issues = [];
  for (const p of needed) for (const r of graph.get(p) ?? []) {
    if (r.specifier.startsWith('.') && !r.target) issues.push(`${p}: ${r.ambiguous ? 'ambiguous' : 'unread or unresolved'} dependency ${r.specifier}`);
    if (r.target && !production.has(r.target)) {
      // Never copy a second production implementation merely to make a test pass.
      if (code.test(r.target) && !isTestPath(r.target) && !isTestSupport(r.target)) production.add(r.target);
      else needed.add(r.target);
    }
  }
  for (const p of production) for (const r of graph.get(p) ?? []) if (r.target && !isTestPath(r.target) && !isTestSupport(r.target)) production.add(r.target);
  const sf = environment(source), df = environment(destination);
  const complete = source.inventory.filter(eligiblePath).every(p => files.has(p));
  const destinationPaths = new Set(destination.files.map(f => f.path));
  if (destination.inventory.some(p => (isTestPath(p) || isTestConfig(p) || /(?:^|\/)package\.json$/.test(p)) && !destinationPaths.has(p))) issues.push('Destination test configuration or layout is only partially inspected.');
  const unreadTests = source.inventory.filter(p => isTestPath(p) && !files.has(p));
  return { tests: tests.map(f => ({ path: f.path, evidence: reaches.has(f.path) ? 'reverse-import' : 'matching-name' })),
    support: [...needed].filter(p => !tests.some(t => t.path === p)).sort(), featurePaths: [...production].sort(),
    source: sf, destination: df, requiredSource: [...needed, ...sf.configs].sort(),
    requiredDestination: [...df.examples, ...df.configs, ...df.packages],
    issues: [...new Set(issues)], unreadTests,
    scope: complete ? 'selected-snapshot' : 'partial-snapshot',
    warnings: ['Literal JS/TS references and filename matching are bounded heuristics; dynamic, aliased, and black-box tests may need manual selection.',
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
/** Copy original test assertions byte-for-byte; only literal module/resource paths may change. */
export function transplantTests(changes, source, destination, plan, context) {
  const blockers = [...plan.issues], placements = [], additions = [];
  const done = () => ({ changes: [...changes, ...additions], report: { status: blockers.length ? 'blocked' : plan.tests.length ? 'included' : 'none_found',
    discovered: plan.tests.length, placements, blockers: [...new Set(blockers)], warnings: plan.warnings,
    assertionPolicy: 'Original test bodies preserved; only resolved literal paths rewritten. No tests executed.',
    verification: { sourceBaseline: 'not_run', destinationBaseline: 'not_run', transferredTests: 'not_run', destinationRegression: 'not_run' } } });
  // A patch must not silently drop tests that bounded intake could not inspect.
  if (plan.scope === 'partial-snapshot') blockers.push('Test coverage is incomplete in this snapshot. Supply a complete feature-focused local directory including tests.');
  for (const c of changes) if (isTestPath(c.path) || isTestSupport(c.path) || isTestConfig(c.path) || c.sourcePaths.some(p => plan.requiredSource.includes(p))) blockers.push(`${c.path}: provider-authored test changes require review; automatic copies preserve original assertions.`);
  for (const c of changes.filter(c => /(?:^|\/)package\.json$/.test(c.path))) {
    const contract = text => { const p = JSON.parse(text ?? '{}'); return { type: p.type, jest: p.jest, scripts: Object.fromEntries(Object.entries(p.scripts ?? {}).filter(([k]) => /test|coverage/.test(k))), devDependencies: p.devDependencies }; };
    try { if (JSON.stringify(contract(c.before)) !== JSON.stringify(contract(c.content))) blockers.push(`${c.path}: changing the test environment requires review.`); } catch { blockers.push(`${c.path}: unreadable package configuration.`); }
  }
  if (!plan.tests.length) return done();
  if (plan.source.frameworks.length !== 1 || plan.destination.frameworks.length !== 1 || plan.source.frameworks[0] !== plan.destination.frameworks[0] || !['node:test', 'vitest', 'jest', 'mocha'].includes(plan.source.frameworks[0])) blockers.push('Test runners differ, are unknown, or are mixed. Framework conversion requires review; tests were not rewritten.');
  if (plan.source.custom || plan.destination.custom) blockers.push('Custom test configuration, global setup, or multiple packages require explicit setup review. Configuration was not overwritten.');
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
    if (code.test(p) && /\b(?:import|require)\s*\(\s*[^\s'"]|\b(?:readFile|readFileSync|readdir|readdirSync)\s*\(\s*['"`]|\b(?:__dirname|process\.cwd)\b|\b(?:toMatchSnapshot|toMatchFileSnapshot|setupFiles|jest\.mock|vi\.mock)\b/.test(file.content)) blockers.push(`${p}: dynamic imports, implicit fixtures/mocks, snapshots, or working-directory paths need review.`);
    const replacements = [];
    const refs = references(file, sourceFiles);
    for (const problem of refs.issues ?? []) blockers.push(`${p}: ${problem}.`);
    if (code.test(p)) for (const m of file.content.matchAll(/\b(?:readFile|readFileSync|readdir|readdirSync)\s*\(\s*/g)) {
      if (!/^new\s+URL\s*\(\s*['"][^'"]+['"]\s*,\s*import\.meta\.url\s*\)/.test(file.content.slice(m.index + m[0].length))) blockers.push(`${p}: fixture reads require a literal import.meta.url-relative URL.`);
    }
    for (const r of refs) {
      if (!r.specifier.startsWith('.')) {
        if (!r.resource && !isBuiltin(r.specifier) && (!sourcePackages.has(packageName(r.specifier)) || !destPackages.has(packageName(r.specifier)))) blockers.push(`${p}: package or alias ${r.specifier} is not declared in both projects.`);
        continue;
      }
      const mapped = mapping.get(r.target);
      if (!mapped) { blockers.push(`${p}: dependency ${r.specifier} has no unambiguous transferred target.`); continue; }
      replacements.push({ ...r, value: relativeSpecifier(target, mapped, r.specifier, r.resource) });
    }
    let content = file.content;
    for (const r of replacements.sort((a, b) => b.offset - a.offset)) content = content.slice(0, r.offset) + r.value + content.slice(r.offset + r.specifier.length);
    additions.push({ path: target, action: 'add', content, reason: `${isTest ? 'Preserve feature tests' : 'Include required test support'}; rewrite only resolved paths, keeping original assertions and fixture content.`, sourcePaths: [p] });
    pending.add(target.toLowerCase()); placements.push({ sourcePath: p, destinationPath: target, kind: isTest ? 'test' : 'support' });
  }
  return done();
}
