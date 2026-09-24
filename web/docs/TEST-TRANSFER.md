# Tests travel with the feature

Test inclusion is on by default. The preview discovers related tests and builds a combined, reviewable feature-and-tests patch. It still does not apply that patch or execute arbitrary repository code.

## Implemented path

1. Rank likely production files, follow literal JS/TS imports, then traverse references backwards to find tests that exercise the feature through helpers or wrapper modules. Matching test filenames are a secondary signal, including recognizable Python/Go test names (discovery, not automatic conversion).
2. Include discovered test files, explicit helper/mock imports, and text fixtures referenced by imports or literal `new URL('./fixture.json', import.meta.url)` expressions. Unrelated test suites are not copied. Production wrappers must target the proposed destination implementation; Graft never copies a second source implementation just to make tests pass.
3. Inspect destination test examples, package declarations and test configuration. For compatible, uncomplicated JS/TS projects, follow the existing `test/`, `tests/`, `spec/`, `__tests__/`, or colocated layout and naming suffix. Preserve source subfolders; explicit source-to-destination production provenance determines rewritten imports. Unambiguous colocated tests are placed next to the moved feature. Supporting files outside a source test root are namespaced under `_graft/` (or `__graft_support__/` for colocated layouts).
4. Copy original test bodies and fixture bytes. Rewrite only recognized literal module/resource specifiers; do not generate replacement assertions, delete tests, add skips, or overwrite existing destination tests. AI proposes production changes only. The application recomputes the test plan itself rather than trusting provider claims.
5. Display related tests, supporting files, placement mappings and blockers in the web UI and review JSON. `exportable: false` and `patch: null` enforce a blocked transfer at the API level; checking the UI approval box cannot bypass it.

The authored sample now moves:

```text
test/csv.test.mjs       -> tests/csv.test.mjs
test/support/rows.mjs   -> tests/support/rows.mjs
test/fixtures/cells.json -> tests/fixtures/cells.json
```

The existing `tests/task-count.test.mjs` remains unchanged. `test/unrelated.test.mjs` remains in the source only.

## Honest boundaries

Automatic copying is deliberately conservative, not a universal framework migration:

- Same-runner Node, Vitest, Jest and Mocha declarations are recognized. Only the Node sample is executed in this validation; the Vitest TypeScript case is a static patch test, not a Vitest execution claim. Different/unknown/mixed runners, ambiguous layouts, global setup, inspected runner configuration, or multiple package scopes block automatic export.
- The bounded lexical reader is not a full parser. Comments and quoted assertion strings are not treated as imports. Templates, regex/division constructs, computed imports and fixture paths, implicit module mocks and snapshot assertions in copied JS/TS require parser-backed review. Binary fixtures, arbitrary aliases, global services, schema/API changes and cross-language rewrites are not solved here. Preserving an assertion does not prove that its adapted implementation satisfies it.
- Missing/over-budget test context, undeclared test packages, ambiguous production mappings, existing path collisions and combined patch-budget overflow block export rather than omit tests. Provider edits to tests/support/configuration, or changes to package test scripts/environment, also block. No automatic dependency installation or wholesale configuration replacement occurs.
- Public URL intake still reads at most 14 blobs per repository. Partial eligible source snapshots, or unread destination test/config paths, cannot establish complete test inclusion. Use a complete feature-focused local folder that includes its tests. Ignored dependency/credential paths do not count as missing eligible source text.
- Discovery is heuristic: reflection, dynamic behavior and black-box integration tests without module links or matching names may be missed. `none_found` is not a passing test suite or proof that no relevant tests exist.
- Context remains at most 110 KB total, now up to 36 files per side. Production drafts remain limited to 10 files; adding tests/support has a combined cap of 32 changed files and 120 KB. Oversized transfers remain blocked and reviewable.

Every review records source baseline, destination baseline, transferred tests and destination regression as `not_run`. An isolated arbitrary-project execution service is still a separate release gate. Graft's own tests do execute original synthetic fixtures; those results never become success claims about a user's repository.

## Reproduce the evidence

```sh
cd web
npm test
npm run check
node --test --test-name-pattern='actual sample source' test/test-transfer.test.mjs
```

Observed on September 24, 2026, with Node v22.16.0 on Linux: **69/69 tests**, zero failures/skips, plus syntax checks. The source fixture passes 2/2 tests; the destination baseline passes 1/1; `git apply --check` and application succeed; the destination then passes 2/2 tests. A negative control replaces the serializer with a broken implementation and the transplanted assertion fails (exit 1), demonstrating that the test is not an empty success placeholder. Existing destination tests and README are preserved byte-for-byte.

The suite also covers context selection, indirect references, cycles, test layout/suffix changes, colocated placement, framework/setup mismatch, missing fixtures/packages, path collisions, provider test weakening, incomplete snapshots, budget overflow, preservation of import-like assertion strings, HTTP endpoints and the actual frontend controller's blocked-download gate using DOM stubs.

`python test/browser_smoke.py` was attempted; Chromium localhost navigation failed with `ERR_BLOCKED_BY_ADMINISTRATOR`. No bypass or browser pass is claimed. No paid inference, deployment, or root legacy-suite rerun occurred. Exact observations: [test-transfer-verification.json](test-transfer-verification.json).

## Code map and references

`lib/core-base.mjs` preserves the original snapshot/ranking/patch primitives byte-for-byte. `lib/core.mjs` orchestrates test-prioritized context and combined review. `lib/test-transfer.mjs` owns discovery, placement and conservative path rewriting. The sample, provider contract and UI all use that same review path.

Primary references consulted September 24, 2026: [Node test runner](https://nodejs.org/api/test.html), [Vitest include rules](https://vitest.dev/config/include), and [Jest configuration](https://jestjs.io/docs/configuration). Their configuration options are why a matching filename alone is not treated as proof that a destination runner will execute a transferred test.
