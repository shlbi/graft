# Real Jest / Vitest acceptance gate

**Status: runtime-verified for the documented synthetic subset.** On September 24, 2026, the acceptance gate ran successfully under WSL/Linux with Node v22.23.3, Jest 30.5.2 and Vitest 5.0.1. The top-level result was `status: passed`, with no blockers.

The successful run covered all three checked-in synthetic cases: named Jest imports, free/global test APIs, and shared setup. For every case, the source Jest suite passed 2/2 tests, the destination Vitest baseline passed 1/1, Graft's patch applied, and the destination then passed 3/3 tests with zero skips. Deliberately breaking the transferred feature made the two transferred assertions fail while the existing destination regression remained green; restoring the feature returned the suite to 3/3. In the shared-setup case, removing the transported setup also made the transferred assertions fail, and restoring it returned the suite to green.

See [the WSL verification record](runner-gate-verification-wsl-2026-09-24.json) for the recorded environment and summary. The earlier blocked sandbox attempt remains in [runner-gate-verification.json](runner-gate-verification.json) as historical evidence of the development environment limitation.

## What the command verifies

Run `npm run test:runners` from `web/`. The command uses the real Graft `snapshot`, `analyze` and `reviewProposal` pipeline against authored fixtures. It executes the source with Jest, executes the destination baseline with Vitest, checks and applies the exported Git patch, then executes the post-transfer suite with Vitest.

Existing destination files must remain byte-for-byte intact and applied changes must match reviewed bytes. Original source test identities and destination regressions must remain present. Missing, renamed, duplicated, skipped, pending and todo tests reject acceptance; so do inconsistent result counters and nonzero positive-run exits. A zero-test green report is not a pass.

Negative controls are required: a deliberately broken feature must fail the original transferred assertions while leaving the unrelated destination regression green. The shared-setup case also removes hook registration and requires the original transferred assertions to fail. Runner crashes or import failures cannot masquerade as successful negative controls. Recovery must return the full suite to green.

## Dependency requirements

The gate requires Git, TypeScript, and real Jest/Vitest installations inside `web/acceptance/node_modules`. Their installed versions must be exact pins in `web/acceptance/package.json` and match integrity-bearing entries in `web/acceptance/package-lock.json`. Global or unrelated installations are rejected.

The successful WSL run recorded:

- Node: `v22.23.3`
- Jest: `30.5.2`
- Vitest: `5.0.1`
- lock hash: `6aa761ecf3ca592d1b390971b3a68a476a403f43c020fe94b0a826fa93c8bb7a`

The exact local acceptance lockfile used in that run has not yet been committed from the user's WSL checkout, so the environment is runtime-verified but not yet fully reproducible from repository state alone.

## Evidence and runtime bounds

The gate is restricted to checked-in synthetic fixtures. It does not execute uploaded user repositories, call AI, start CI, deploy anything, or change application verification statuses.

Child commands have a 30-second deadline, a combined 2 MiB output limit, no shell, and a small environment that does not forward API keys or `NODE_OPTIONS`. POSIX process groups are cleaned up. Temporary directories are not a security sandbox; this gate must not be exposed as an arbitrary uploaded-project execution endpoint.

## Remaining boundary

This verifies the documented Jest-to-Vitest subset, not universal cross-runner migration. Unsupported mocks/timers, snapshots, complex environments, monorepo/package-scoped configuration, and other frameworks still require explicit adapters or review. Real user-project execution still needs an isolated sandbox before it can be part of a hosted Graft workflow.
