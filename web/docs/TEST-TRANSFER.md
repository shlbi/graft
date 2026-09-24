# Tests travel with the feature

Test inclusion is on by default. Graft produces a combined, reviewed feature-and-tests patch; it does not apply it, install user dependencies, run their configuration, or execute arbitrary user repositories.

## Discovery and placement

Production references are followed forward; reverse reachability then finds tests through helpers and wrapper modules. Matching filenames are a secondary signal, including Python/Go test names for discovery only. Explicitly referenced helper modules and eligible text fixtures travel with the tests. Unrelated suites stay behind. Tests must point to the proposed destination implementation, not a duplicate source implementation copied merely to get a pass.

The existing destination test root (`test/`, `tests/`, `spec/`, `__tests__/`, or colocated) and test/spec suffix determine placement. Existing files, case-insensitive path collisions and file/directory conflicts are protected. Supporting files outside the source test root are namespaced. Unknown/mixed layouts need review, not a guess.

## Parser-backed references

`lib/syntax.mjs` uses the pinned TypeScript 5.8.3 compiler parser. It reads source text into an AST; it never imports that source or evaluates its configuration. Regexes, division, comments and template literals are no longer blanket blockers. Text that looks like an import inside an assertion or comment is not rewritten.

Supported reference expressions include static imports, re-exports, `require`, dynamic `import`, and `new URL(path, import.meta.url)` fixtures. The path may be a literal, string concatenation or template made entirely from uniquely declared top-level constants. A constant URL used only by supported file readers is also recognized. For example:

```js
const MODULE = '../src/' + 'csv.mjs';
const NAME = 'cells';
const fixture = new URL(`./fixtures/${NAME}.json`, import.meta.url);
const { toCSV } = await import(MODULE);
```

When a destination path differs, only the AST argument span changes; Graft does not rewrite the original constant or unrelated assertion text. Escaped literals are handled by source spans, not decoded-string lengths. A nearest local `tsconfig.json` with a single-target `paths` mapping can resolve an alias to the proposed destination module. Inherited configs, project references, multi-target paths and escaping targets need review.

Runtime calls, mutable/shadowed bindings, custom `require`, unresolved computed paths, glob/directory enumeration, working-directory paths, implicit module mocks and snapshots remain blocked where detected. This is bounded static discovery, not proof that every possible dynamic or black-box test was found.

## Supported runner adaptation

Same-runner Node, Jest, Vitest and Mocha remain recognized. The new cross-runner direction is **Jest to Vitest only**, for a small explicit API subset. Named imports from `@jest/globals` become imports from `vitest`; aliases are preserved. Free standard test globals gain explicit imports so the destination does not need its global settings changed.

The adapter recognizes `describe`, `test`, `it`, `expect`, `beforeAll`, `beforeEach`, `afterEach` and `afterAll`. Common matcher calls retain their logic and expected values. It never asks AI to regenerate tests, deletes assertions, inserts skips, or changes an expectation to fit a generated implementation. AI still proposes production changes only.

Unsupported runner APIs block export: module mocks, timer APIs, snapshots, custom/static/computed assertion APIs, namespace/default runner imports, framework-specific types, done/context callbacks, callback indirection, test modifiers such as `.each`/`.only`/`.concurrent`, shared global/worker state, environment overrides and unsupported CommonJS interop. Cross-runner hooks must have zero-argument block callbacks without returned values. Multiple hooks in the same phase across the test/support closure require explicit order review. Vitest-to-Jest and other runner/language conversions are not implemented.

**Validation boundary:** generated Jest-to-Vitest patches are covered by parser/plan/patch tests, NOT execution under Jest or Vitest in this environment. The review reports `runtimeVerification: not_run` and the UI displays `runner execution NOT VERIFIED`. A successful draft is not a successful migration.

## Shared setup without replacing configuration

`lib/test-config.mjs` reads only bounded declarative root configuration: literal JSON/JSONC objects, ESM default objects, CJS `module.exports` objects, immutable object constants, and an imported `defineConfig` wrapper from `vitest/config`. Executable statements, functions, spread/computed/getter properties and imported config code are not evaluated and require review.

The supported configuration is intentionally small: Node environment; a single Jest `setupFilesAfterEnv` or Vitest `setupFiles` path; Vitest boolean globals; isolation enabled; and an empty Jest transform map. Source setup must consist of imports and block-bodied, zero-argument hook registrations, with its dependency closure available. Graft copies that setup and inserts a test-local import instead of editing the destination config. Existing explicit setup imports are preserved without duplicate injection.

Both projects defining implicit setup, multiple setup files, multiple package scopes/workspaces, nested configs, global services, browser/jsdom environments, custom transforms, test include rules and unknown options require review. General monorepo/config merging is not implemented.

## Gates and evidence

Partial eligible source snapshots, unread destination test/configuration paths, missing context, missing packages, ambiguous mappings and collisions block patch export. Public URL intake remains bounded to 14 text blobs per repository; use a complete feature-focused local folder containing its tests. Context is at most 110 KB total and 36 files per side. A feature plus tests has a 32-file/120 KB patch budget; overflow does not silently drop tests.

The API returns `exportable: false` and `patch: null` when blocked. UI approval cannot bypass those gates. Every review still records source baseline, destination baseline, transferred tests and destination regression as `not_run` until an isolated user-project verifier exists.

## Reproduce observed validation

```sh
cd web
npm install
npm test
npm run check
node --test --test-name-pattern='AST-assisted transfer executes' test/parser-adapter.test.mjs
```

Observed September 24, 2026: Node v22.16.0, Linux, TypeScript 5.8.3; **99/99 tests**, zero failures/skips, plus syntax checks. The pinned parser was already installed in the environment; a network dependency install was not observed. `jest` and `vitest` resolved as `MODULE_NOT_FOUND`; the attempted npm registry lookup failed `EAI_AGAIN`.

Two synthetic cases executed: (1) the original CSV test/fixture transfer; (2) static-constant dynamic import, template fixture URL, regex/division/template assertions and shared Node hooks, with the feature moved to another directory. Each source baseline passed 2/2, destination baseline 1/1 and patched destination 2/2. Both patches passed `git apply --check` and application. Deliberately breaking the serializer or removing the copied setup triggers failure. Existing destination tests remain unchanged. These are authored acceptance cases, not arbitrary user-project or AI-quality results.

Browser, Windows, CI and legacy engine tests were not rerun. Prior Chromium navigation was administrator-blocked; no workaround or screenshot claim. No paid inference or deployment. Records: [latest](parser-adapter-verification.json), [prior test transfer](test-transfer-verification.json), [original preview](verification.json).

## Code map and primary sources

`core-base.mjs` preserves snapshot/patch primitives; `core.mjs` coordinates bounded context and reviewed output. `test-transfer.mjs` handles discovery and placement. `syntax.mjs`, `runner-adapter.mjs` and `test-config.mjs` isolate parser edits, runner semantics and declarative setup inspection. The UI shows placement and adaptation audit entries.

Consulted September 24, 2026: [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [Vitest migration from Jest](https://vitest.dev/guide/migration/jest), [Vitest setup files](https://vitest.dev/config/setupfiles), [Jest configuration](https://jestjs.io/docs/configuration). These sources identify differences in globals, mocks, callbacks and hook lifecycle/order; a text rename alone is not a verified conversion.
