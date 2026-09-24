/** Read a bounded declarative configuration subset. No eval, dynamic imports, or require. */
import path from 'node:path';
import { ts, parse, unwrap, walk } from './syntax.mjs';
const own = (obj, key) => Object.hasOwn(obj, key);
function value(node, parsed, seen = new Set()) {
  node = unwrap(node);
  if (!node || seen.size > 24) throw new Error('configuration value is not a bounded literal');
  if (ts.isIdentifier(node) && parsed.constants.has(node.text) && !seen.has(node.text)) return value(parsed.constants.get(node.text), parsed, new Set([...seen, node.text]));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(n => value(n, parsed, seen));
  if (ts.isObjectLiteralExpression(node)) {
    const obj = Object.create(null);
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))) throw new Error('computed, spread, shorthand, or method configuration needs review');
      const key = p.name.text;
      if (['__proto__', 'constructor', 'prototype'].includes(key) || own(obj, key)) throw new Error('duplicate or unsafe configuration key');
      obj[key] = value(p.initializer, parsed, seen);
    }
    return obj;
  }
  throw new Error('dynamic configuration expression requires review');
}
export function staticConfig(file) {
  if (/\.json$/.test(file.path)) {
    const json = ts.parseConfigFileTextToJson(file.path, file.content);
    if (json.error) throw new Error('malformed JSON configuration');
    if (!json.config || typeof json.config !== 'object' || Array.isArray(json.config)) throw new Error('configuration must be a literal object');
    return json.config;
  }
  const parsed = parse(file), { ast } = parsed;
  if (parsed.issues.length) throw new Error(parsed.issues.join('; '));
  const wrappers = new Set(); let exported;
  for (const s of ast.statements) {
    if (ts.isImportDeclaration(s)) {
      if (s.moduleSpecifier.text !== 'vitest/config') throw new Error('only the declarative vitest/config import is supported');
      for (const b of s.importClause?.namedBindings?.elements ?? []) if ((b.propertyName ?? b.name).text === 'defineConfig' && parsed.declarations.get(b.name.text) === 1) wrappers.add(b.name.text);
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      if (exported) throw new Error('multiple configuration exports'); exported = unwrap(s.expression);
    } else if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && s.expression.left.getText(ast) === 'module.exports') {
      if (exported) throw new Error('multiple configuration exports'); exported = unwrap(s.expression.right);
    } else if (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const)) {
      for (const d of s.declarationList.declarations) value(d.initializer, parsed);
    } else if (ts.isEmptyStatement(s)) { /* no-op */ }
    else throw new Error('executable configuration statements require review');
  }
  if (exported && ts.isCallExpression(exported)) {
    if (!ts.isIdentifier(exported.expression) || !wrappers.has(exported.expression.text) || exported.arguments.length !== 1) throw new Error('dynamic configuration function requires review');
    exported = exported.arguments[0];
  }
  const config = value(exported, parsed);
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('configuration must be a literal object');
  return config;
}
const runnerConfig = p => /(?:^|\/)(?:jest|vitest|vite|playwright|cypress)\.config\.(?:[cm]?[jt]s|json)$/.test(p);
export function inspectConfiguration(repo, frameworks, packages) {
  const setup = [], issues = [], configPaths = repo.files.filter(f => runnerConfig(f.path)).map(f => f.path);
  const runner = frameworks.length === 1 ? frameworks[0] : null;
  const results = []; let globals = runner === 'jest', environment = 'node';
  if (packages.length > 1) issues.push('multiple packages require package-scoped setup review');
  for (const p of packages) {
    const file = repo.files.find(f => f.path === p);
    try {
      const data = JSON.parse(file.content);
      if (data.workspaces) issues.push('workspace setup requires package-scoped review');
      if (/--(?:require|import|loader|setup|config)|(?:NODE_OPTIONS|BABEL_ENV|TS_NODE)/.test(data.scripts?.test ?? '')) issues.push('test command preload/configuration flags require explicit setup review');
      if (data.jest) results.push({ path: p, config: data.jest, kind: 'jest' });
    } catch { issues.push(`${p}: unreadable package setup`); }
  }
  for (const p of configPaths) {
    if (path.posix.dirname(p) !== '.') issues.push(`${p}: nested configuration requires package/root-scoped setup review`);
    const kind = /(?:^|\/)jest\.config/.test(p) ? 'jest' : /(?:^|\/)(?:vitest|vite)\.config/.test(p) ? 'vitest' : 'unsupported';
    try { results.push({ path: p, config: staticConfig(repo.files.find(f => f.path === p)), kind }); }
    catch (error) { issues.push(`${p}: ${error.message}`); }
  }
  if (results.length > 1) issues.push('multiple runner configurations require explicit precedence review');
  for (const r of results) {
    if (r.kind !== runner) { issues.push(`${r.path}: configuration does not match the detected runner setup`); continue; }
    let options = r.config;
    if (!options || typeof options !== 'object' || Array.isArray(options)) { issues.push(`${r.path}: invalid test configuration`); continue; }
    if (r.kind === 'vitest') {
      if (Object.keys(options).some(k => k !== 'test')) issues.push(`${r.path}: Vite plugins/resolution or other top-level settings require review`);
      options = options.test ?? {};
    }
    if (!options || Array.isArray(options) || typeof options !== 'object') { issues.push(`${r.path}: invalid test configuration`); continue; }
    const allowed = new Set(r.kind === 'jest' ? ['testEnvironment', 'setupFilesAfterEnv', 'transform'] : ['environment', 'setupFiles', 'globals', 'isolate']);
    for (const key of Object.keys(options)) if (!allowed.has(key)) issues.push(`${r.path}: configuration option ${key} requires explicit review`);
    if (options.transform && (typeof options.transform !== 'object' || Object.keys(options.transform).length)) issues.push(`${r.path}: custom transforms require review`);
    environment = options.testEnvironment ?? options.environment ?? 'node';
    if (environment !== 'node') issues.push(`${r.path}: ${environment} environment needs a dedicated adapter`);
    if (own(options, 'globals')) { if (typeof options.globals !== 'boolean') issues.push(`${r.path}: globals must be a literal boolean`); else globals = options.globals; }
    if (own(options, 'isolate') && options.isolate !== true) issues.push(`${r.path}: non-isolated setup cannot be imported safely per test file`);
    let paths = options.setupFilesAfterEnv ?? options.setupFiles ?? [];
    if (typeof paths === 'string' && r.kind === 'vitest') paths = [paths];
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string') || paths.length > 4) { issues.push(`${r.path}: setup files must be a bounded literal path list`); continue; }
    // Multiple setup files can run concurrently; preserve order only in the single-file supported subset.
    if (paths.length > 1) issues.push(`${r.path}: multiple setup file ordering requires review`);
    for (const spec of paths) {
      const relative = spec.replace(/^<rootDir>\//, '').replace(/^\.\//, '');
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(r.path), relative));
      if (path.posix.isAbsolute(spec) || target.startsWith('../') || !repo.files.some(f => f.path === target)) issues.push(`${r.path}: setup dependency ${spec} is unread or escapes the snapshot`);
      else setup.push(target);
    }
  }
  return { setup: [...new Set(setup)], issues: [...new Set(issues)], configPaths, globals, environment };
}
/** Setup relocation only supports imports/declarations and synchronous registration of block-bodied hooks. */
export function inspectSetupFile(file) {
  const p = parse(file), issues = [...p.issues], hooks = [];
  const aliases = new Map();
  for (const s of p.ast.statements) if (ts.isImportDeclaration(s)) {
    for (const b of s.importClause?.namedBindings?.elements ?? []) aliases.set(b.name.text, (b.propertyName ?? b.name).text);
  }
  for (const s of p.ast.statements) {
    if (ts.isImportDeclaration(s) || ts.isEmptyStatement(s)) continue;
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression) || !ts.isIdentifier(s.expression.expression)) { issues.push('setup must contain only imports and hook registrations; global side effects are not relocated'); continue; }
    const call = s.expression, local = call.expression.text, name = aliases.get(local) ?? local;
    if (!['beforeEach', 'afterEach', 'beforeAll', 'afterAll'].includes(name)) { issues.push('setup contains a non-hook action requiring explicit review'); continue; }
    const callback = call.arguments[0]; hooks.push(name);
    if (call.arguments.length !== 1 || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || callback.parameters.length || !ts.isBlock(callback.body)) { issues.push('setup hooks must have a zero-argument block callback'); continue; }
    walk(callback.body, n => { if (ts.isReturnStatement(n) && n.expression) issues.push('setup hooks returning values require lifecycle review'); });
  }
  return { issues, hooks };
}
