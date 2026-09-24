/** Parse repository text without importing it, evaluating configs, or reading the host filesystem. */
import ts from 'typescript';
import path from 'node:path';
export { ts };
export const isCode = p => /\.[cm]?[jt]sx?$/i.test(p);
export function walk(node, visit) { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
export function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
  return node;
}
const parsedCache = new WeakMap();
export function parse(file) {
  const cached = parsedCache.get(file);
  if (cached?.path === file.path && cached.content === file.content) return cached.parsed;
  const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
  const issues = (ast.parseDiagnostics ?? []).map(d => `syntax: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  const declarations = new Map(), constants = new Map();
  const bind = name => {
    if (!name) return;
    if (ts.isIdentifier(name)) declarations.set(name.text, (declarations.get(name.text) ?? 0) + 1);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) for (const e of name.elements) if (ts.isBindingElement(e)) bind(e.name);
  };
  walk(ast, n => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || ts.isImportClause(n)) bind(n.name);
  });
  // Only unique, top-level const bindings can be folded. Shadowed names are intentionally unresolved.
  for (const s of ast.statements) if (ts.isVariableStatement(s) && (s.declarationList.flags & ts.NodeFlags.Const)) {
    for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && declarations.get(d.name.text) === 1 && d.initializer) constants.set(d.name.text, d.initializer);
  }
  const parsed = { ast, issues, constants, declarations };
  parsedCache.set(file, { path: file.path, content: file.content, parsed });
  return parsed;
}
export function staticString(node, parsed, seen = new Set()) {
  node = unwrap(node);
  if (!node || seen.size > 24) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && parsed.constants.has(node.text) && !seen.has(node.text)) return staticString(parsed.constants.get(node.text), parsed, new Set([...seen, node.text]));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, parsed, seen), right = staticString(node.right, parsed, seen);
    return left !== null && right !== null && left.length + right.length <= 2048 ? left + right : null;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) { const value = staticString(span.expression, parsed, seen); if (value === null) return null; result += value + span.literal.text; if (result.length > 2048) return null; }
    return result;
  }
  return null;
}
export function literalEdit(node, ast, value) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const raw = node.getText(ast), q = raw[0];
    const escaped = value.replaceAll('\\', '\\\\').replaceAll(q, '\\' + q).replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('${', q === '`' ? '\\${' : '${');
    return { start: node.getStart(ast) + 1, end: node.end - 1, value: escaped };
  }
  return { start: node.getStart(ast), end: node.end, value: JSON.stringify(value) };
}
export function applyEdits(text, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let last = text.length;
  for (const e of sorted) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 0 || e.end < e.start || e.end > last) throw new Error('Overlapping or invalid parser edits.');
    text = text.slice(0, e.start) + e.value + text.slice(e.end); last = e.start;
  }
  return text;
}
function candidates(base, files, resource) {
  if (files.has(base)) return [base];
  if (resource) return [];
  return [...new Set([base.replace(/\.js$/, '.ts'), base.replace(/\.jsx$/, '.tsx'), base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'), ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'].map(ext => base + ext)].filter(p => files.has(p)))];
}
function aliasTarget(specifier, file, files) {
  const configs = [...files.keys()].filter(p => /(?:^|\/)tsconfig\.json$/.test(p) && (path.posix.dirname(p) === '.' || file.path.startsWith(path.posix.dirname(p) + '/'))).sort((a, b) => b.length - a.length);
  if (!configs.length) return null;
  const configPath = configs[0], f = files.get(configPath);
  if (!f?.content) return null;
  const parsed = ts.parseConfigFileTextToJson(configPath, f.content);
  if (parsed.error) return { configPath, issues: ['unreadable tsconfig aliases'], targets: [] };
  const config = parsed.config;
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.compilerOptions != null && (typeof config.compilerOptions !== 'object' || Array.isArray(config.compilerOptions)))) return { configPath, issues: ['invalid tsconfig object'], targets: [] };
  const paths = config.compilerOptions?.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return config.extends ? { configPath, issues: ['inherited tsconfig aliases need explicit resolution'], targets: [] } : null;
  const matches = Object.entries(paths).filter(([key]) => {
    const parts = key.split('*'); return parts.length === 1 ? key === specifier : parts.length === 2 && specifier.startsWith(parts[0]) && specifier.endsWith(parts[1]) && specifier.length >= parts[0].length + parts[1].length;
  }).sort(([a], [b]) => (b === specifier) - (a === specifier) || b.split('*')[0].length - a.split('*')[0].length);
  if (!matches.length) return config.extends ? { configPath, issues: ['inherited tsconfig aliases need explicit resolution'], targets: [] } : null;
  if (config.extends || config.references || (config.compilerOptions?.baseUrl != null && typeof config.compilerOptions.baseUrl !== 'string')) return { configPath, issues: ['inherited or project-reference tsconfig needs review'], targets: [] };
  const [key, values] = matches[0], parts = key.split('*');
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') return { configPath, issues: ['multi-target tsconfig alias requires review'], targets: [] };
  const captured = parts.length === 2 ? specifier.slice(parts[0].length, specifier.length - parts[1].length) : '';
  const replacement = values[0].replace('*', captured);
  if (replacement.includes('*') || path.posix.isAbsolute(replacement)) return { configPath, issues: ['unsupported alias target'], targets: [] };
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(configPath), config.compilerOptions?.baseUrl ?? '.', replacement));
  if (base.startsWith('../')) return { configPath, issues: ['alias escapes the repository'], targets: [] };
  return { configPath, issues: [], targets: candidates(base, files, false) };
}
export function parsedReferences(file, files) {
  const refs = [], configPaths = new Set();
  if (!isCode(file.path)) { Object.defineProperty(refs, 'issues', { value: [] }); return refs; }
  const p = parse(file), { ast } = p, issues = [...p.issues];
  const add = (node, resource = false) => {
    const specifier = staticString(node, p);
    if (specifier === null) { issues.push(resource ? 'dynamic fixture path cannot be resolved statically' : 'dynamic import/require cannot be resolved statically'); return; }
    let targets = [], internal = specifier.startsWith('.') || resource;
    if (internal) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier));
      if (path.posix.isAbsolute(specifier) || base.startsWith('../')) issues.push('dependency path escapes the repository');
      else targets = candidates(base, files, resource);
    } else {
      const alias = aliasTarget(specifier, file, files);
      if (alias) { internal = true; configPaths.add(alias.configPath); issues.push(...alias.issues); targets = alias.targets; }
    }
    if (!refs.some(r => r.nodeStart === node.getStart(ast))) refs.push({ specifier, target: targets.length === 1 ? targets[0] : null, ambiguous: targets.length > 1, resource, internal,
      offset: node.getStart(ast) + (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? 1 : 0), nodeStart: node.getStart(ast),
      edit: value => literalEdit(node, ast, value) });
  };
  const isURL = n => n && ts.isNewExpression(n) && n.expression.getText(ast) === 'URL' && !p.declarations.has('URL') && n.arguments?.length === 2 && n.arguments[1].getText(ast).replace(/\s/g, '') === 'import.meta.url';
  const readerNames = new Set(['readFile', 'readFileSync', 'readdir', 'readdirSync']);
  for (const s of ast.statements) if (ts.isImportDeclaration(s) && ['node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(s.moduleSpecifier.text)) {
    for (const b of s.importClause?.namedBindings?.elements ?? []) if (readerNames.has((b.propertyName ?? b.name).text)) readerNames.add(b.name.text);
  }
  const usedURLs = new Set();
  walk(ast, n => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) add(n.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && n.moduleReference.expression) add(n.moduleReference.expression);
    if (ts.isCallExpression(n)) {
      const expr = n.expression, name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : '';
      if (expr.kind === ts.SyntaxKind.ImportKeyword) add(n.arguments[0]);
      if (ts.isIdentifier(expr) && expr.text === 'require') {
        if (p.declarations.has('require')) issues.push('shadowed or custom require needs explicit resolution');
        else add(n.arguments[0]);
      }
      if (['glob', 'globSync', 'context'].includes(name)) issues.push('dynamic directory/glob discovery requires explicit review');
      if (['mock', 'doMock', 'unstable_mockModule'].includes(name) && ts.isPropertyAccessExpression(expr) && ['jest', 'vi'].includes(expr.expression.getText(ast))) issues.push('implicit module mocks require framework-specific review');
      if (/Snapshot/.test(name)) issues.push('snapshots require explicit mapping and review');
      if (name === 'cwd' && ts.isPropertyAccessExpression(expr) && expr.expression.getText(ast) === 'process') issues.push('working-directory fixtures require explicit mapping');
      if (readerNames.has(name)) {
        let arg = unwrap(n.arguments[0]);
        if (arg && ts.isIdentifier(arg) && p.constants.has(arg.text)) { usedURLs.add(arg.text); arg = unwrap(p.constants.get(arg.text)); }
        if (!isURL(arg) || ['readdir', 'readdirSync'].includes(name)) issues.push('fixture reads require a statically resolved import.meta.url-relative URL; directory enumeration is not supported');
      }
    }
    if (ts.isIdentifier(n) && n.text === '__dirname') issues.push('working-directory fixtures using __dirname require review');
    if (isURL(n)) add(n.arguments[0], true);
  });
  // A URL object can be mutated even through a const binding. Only permit its use as a reader argument.
  walk(ast, n => {
    if (ts.isIdentifier(n) && usedURLs.has(n.text)) {
      const parent = n.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === n) return;
      if (ts.isCallExpression(parent) && parent.arguments[0] === n) {
        const expr = parent.expression, name = ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : '';
        if (readerNames.has(name)) return;
      }
      issues.push(`fixture URL ${n.text} may escape or be mutated`);
    }
  });
  Object.defineProperties(refs, { issues: { value: [...new Set(issues)] }, configPaths: { value: [...configPaths] } });
  return refs;
}
