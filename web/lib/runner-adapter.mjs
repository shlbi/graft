/** Deliberately small Jest/Vitest adapter. Never edits an assertion or synthesizes a passing test. */
import { ts, parse, walk, literalEdit } from './syntax.mjs';
const common = new Set(['describe', 'test', 'it', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const runners = new Map([['jest', '@jest/globals'], ['vitest', 'vitest']]);
const matchers = new Set(['not', 'resolves', 'rejects', 'toBe', 'toEqual', 'toStrictEqual', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeTruthy', 'toBeFalsy', 'toBeGreaterThan', 'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toContain', 'toContainEqual', 'toHaveLength', 'toHaveProperty', 'toMatch', 'toThrow', 'toBeInstanceOf']);
function identifierRead(n) {
  const p = n.parent;
  if ((ts.isPropertyAccessExpression(p) && p.name === n) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === n) return false;
  return !ts.isTypeReferenceNode(p) && !ts.isQualifiedName(p);
}
export function adaptRunner(file, from, to) {
  const edits = [], issues = [], hooks = [];
  if (!runners.has(from) || !runners.has(to)) return { edits, issues, hooks, mode: 'same-runner' };
  const crossing = from !== to, parsed = parse(file), { ast, declarations } = parsed;
  const aliases = new Map(), imported = new Set(), globals = new Set();
  for (const s of ast.statements) if (ts.isImportDeclaration(s) && s.moduleSpecifier.text === runners.get(from)) {
    const c = s.importClause;
    if (!c || c.name || !c.namedBindings || !ts.isNamedImports(c.namedBindings) || c.isTypeOnly) {
      if (crossing) issues.push('framework conversion supports named value imports, not namespace/default/type imports');
      continue;
    }
    for (const b of c.namedBindings.elements) {
      const original = (b.propertyName ?? b.name).text;
      if (!common.has(original) || b.isTypeOnly) { if (crossing) issues.push(`framework API ${original} needs a specific adapter (mocks/timers/types are not renamed blindly)`); }
      else { aliases.set(b.name.text, original); imported.add(b.name.text); }
      if (crossing && declarations.get(b.name.text) !== 1) issues.push(`shadowed framework binding ${b.name.text} requires review`);
    }
    if (crossing) edits.push(literalEdit(s.moduleSpecifier, ast, runners.get(to)));
  }
  if (crossing && (ts.getLeadingCommentRanges(file.content, 0) ?? []).some(c => /@(?:jest|vitest)-environment/.test(file.content.slice(c.pos, c.end)))) issues.push('per-file test environment overrides require a dedicated adapter');
  walk(ast, n => {
    if (ts.isIdentifier(n) && identifierRead(n)) {
      if (common.has(n.text) && declarations.has(n.text) && !imported.has(n.text)) issues.push(`locally declared or shadowed framework global ${n.text} requires scope review`);
      if (common.has(n.text) && !declarations.has(n.text)) { globals.add(n.text); aliases.set(n.text, n.text); }
      if (crossing && ['jest', 'vi'].includes(n.text) && !declarations.has(n.text)) issues.push(`framework API ${n.text} requires a specific mock/timer adapter`);
    }
  });
  const rootAPI = expression => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return rootAPI(expression.expression);
    if (ts.isCallExpression(expression)) return rootAPI(expression.expression);
    return undefined;
  };
  walk(ast, n => {
    if (!crossing) return;
    if (ts.isCallExpression(n)) {
      const root = rootAPI(n.expression);
      if (root && root !== 'expect') {
        if (!ts.isIdentifier(n.expression)) issues.push('modified tests (each/skip/only/concurrent/failing) need explicit cross-runner review');
        const callback = n.arguments.find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (!callback) issues.push(`${root}: callback must be inline for cross-runner review`);
        else if (callback.parameters.length) issues.push(`${root}: done/context callbacks are not automatically converted`);
        if (root.startsWith('before') || root.startsWith('after')) {
          hooks.push(root);
          if (callback && !ts.isBlock(callback.body)) issues.push(`${root}: implicit-return hooks have different lifecycle semantics`);
          else if (callback) walk(callback.body, c => { if (ts.isReturnStatement(c) && c.expression) issues.push(`${root}: hooks returning values/teardown functions need review`); });
        }
      }
    }
    if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && rootAPI(n.expression) === 'expect') {
      if (ts.isElementAccessExpression(n) || !matchers.has(n.name.text) || ts.isIdentifier(n.expression)) issues.push('custom/static/computed assertion APIs require explicit cross-runner review');
    }
    if (ts.isIdentifier(n) && ['globalThis', 'global', 'window', 'process'].includes(n.text) && identifierRead(n)) issues.push('global/runner state requires explicit cross-runner review');
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.MetaProperty && n.name.text === 'jest') issues.push('import.meta.jest requires a dedicated framework adapter');
    if (ts.isIdentifier(n) && ['require', 'module', 'exports', '__dirname'].includes(n.text) && identifierRead(n)) issues.push('CommonJS/interoperability requires a dedicated runner adapter');
    if (ts.isPropertyAccessExpression(n) && ['mockReset', 'mockClear', 'mockRestore', 'useFakeTimers', 'useRealTimers'].includes(n.name.text)) issues.push('mock state and timer semantics differ between runners');
    if (ts.isPropertyAccessExpression(n) && n.expression.getText(ast) === 'process.env') issues.push('runner-dependent environment variables need review');
    if (ts.isQualifiedName(n) && ['jest', 'vi'].includes(n.left.getText(ast))) issues.push('framework namespace types require a dedicated type adapter');
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && [runners.get(from), runners.get(to)].includes(n.arguments[0].text)) issues.push('dynamic framework imports are not automatically converted');
  });
  if (globals.size) {
    let start = ast.statements[0]?.getStart(ast) ?? file.content.length;
    // Keep hashbangs/comments and directive prologues before inserted imports.
    for (const s of ast.statements) { if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) start = s.end; else break; }
    edits.push({ start, end: start, value: `\nimport { ${[...globals].sort().join(', ')} } from '${runners.get(to)}';\n` });
  }
  return { edits, issues: [...new Set(issues)], hooks, mode: crossing ? `${from}-to-${to}` : 'explicit-framework-imports' };
}
export function frameworkPair(source, destination) {
  const from = source.frameworks[0], to = destination.frameworks[0];
  const valid = source.frameworks.length === 1 && destination.frameworks.length === 1 && (from === to ? ['node:test', 'vitest', 'jest', 'mocha'].includes(from) : from === 'jest' && to === 'vitest');
  return { from, to, valid, cross: from !== to };
}
