# Real Jest / Vitest acceptance gate

**Status: implemented, with gate-policy tests executed; actual Jest/Vitest execution remains blocked.** On September 24, 2026 the development session could not resolve `registry.npmjs.org` (`EAI_AGAIN`). Neither runner was installed. The gate returned `blocked`, exit 2, and zero executed acceptance cases. This is not a successful cross-framework migration or a new whole-suite test result.

The optional command is `npm run test:runners` from `web/`. It does not install dependencies, call AI, execute uploaded projects, start CI, deploy anything, or change application verification statuses. `npm run test:runners:preflight` only checks prerequisites. A successful preflight reports `ready`, never `passed`.

## What the command is designed to verify

Three original synthetic cases exercise explicit aliased Jest imports, free test globals, and single-file shared hook setup. For each, the command uses the actual Graft `snapshot`, `analyze` and `reviewProposal` implementation. It materializes the source and destination into temporary fixture directories, executes the source with real Jest, executes the destination baseline with real Vitest, checks and applies Graft's exported Git patch, then executes the post-transfer suite with real Vitest.

Existing destination files must remain byte-for-byte intact and applied changes must match the reviewed bytes. Both original source test identities and the original destination regression must be present. Missing, renamed, duplicated, skipped, pending and todo tests reject acceptance; so do inconsistent result counters and nonzero positive-run exits. A zero-test green report is not a pass.

A deliberately broken feature must fail the original transferred assertions, while the destination regression remains green. The shared-setup case separately removes hook registration without removing its module, and requires the original assertions to fail. Import errors or runner crashes cannot count as negative-control success. Restoring the feature/setup must recover the full suite.

These are implemented acceptance steps, **not claims that the steps have run in this session**. The executed observations are recorded in [runner-gate-verification.json](runner-gate-verification.json).

## Dependency preparation in an authorized runner environment

The gate requires Git, the web package's pinned TypeScript dependency, and real Jest/Vitest installations inside `web/acceptance/node_modules`. Their exact installed versions must be pinned in `web/acceptance/package.json` development dependencies and match integrity-bearing entries in its `package-lock.json`. Global or unrelated project installations are not accepted. No fabricated dependency lock is included while registry access is unavailable.

In a package-enabled development environment, prepare the runner installation with an explicit dependency-installation step, for example `npm install --prefix web/acceptance --save-dev --save-exact --ignore-scripts jest vitest`. Review the selected versions, generated lockfile and any native-tool requirements, then record them with the successful evidence. `--ignore-scripts` avoids automatically executing package lifecycle hooks; if a supported native dependency requires setup, review that requirement rather than disabling safeguards blindly. This installation has NOT been executed successfully in the current session.

Subsequent runs should use the reviewed lockfile via `npm ci --prefix web/acceptance --ignore-scripts`. No automatic `npx` download, simulated test runner, or fallback assertion implementation substitutes for the actual frameworks. This document is a maintainer/run-environment handoff, not a request that a mobile user run terminal commands.

## Evidence and runtime bounds

`node acceptance/run.mjs --report /path/to/new-report.json` creates a report without overwriting an existing file. It records runner versions and package/entry hashes, the dependency-lock hash, source/destination fingerprints, patch hash, actual test identities/counters, and the negative-control/recovery results. Raw framework JSON and stdout/stderr are hashed before temporary-directory cleanup. The report records fixture evidence only; it never changes the application's per-user `not_run` states.

Child commands have a 30-second deadline, a combined 2 MiB output limit, no shell, and a small environment that does not forward API keys or `NODE_OPTIONS`. Remaining workers in the fixture's POSIX process group are terminated. The fixture gate supports Linux/macOS process-group handling; Windows is explicitly blocked until cleanup is verified there. Temporary directories are NOT a security sandbox: this gate is intentionally limited to its checked-in original synthetic fixtures, and must not be exposed as an uploaded-project execution endpoint.

## Locally executed gate-policy checks

`node --test web/test/runner-acceptance.test.mjs` tests report validation, fixture definitions, missing-runner discovery and process bounds. These use explicit report-shaped unit fixtures, not fake Jest/Vitest executables. Passing them does not validate cross-runner semantics. The prior 99-test web-suite record remains historical; the full suite was not rerun in this session.

Primary runner references consulted September 24, 2026: [Jest ESM execution](https://jestjs.io/docs/ecmascript-modules), [Vitest CLI](https://vitest.dev/guide/cli), and [Vitest reporters](https://vitest.dev/guide/reporters). Actual behavior must be checked against the versions recorded by the first successful acceptance run.
