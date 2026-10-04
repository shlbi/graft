# Authored native SDK acceptance

Continuation of the Dart/Flutter adapter checkpoint `33312e943d5242a0b074e131f08586840d2d5565`.
That checkpoint implemented structural/test relocation; it did **not** run a Dart or
Flutter compiler/test runner. Keep its structural results separate from SDK evidence.

## Explicit execution

In a disposable **Linux or macOS** environment, with repository dependencies and the
appropriate SDK already installed:

```sh
node scripts/verify-dart-fixture.mjs /tmp/repot-dart-new --execute
node scripts/verify-dart-fixture.mjs /tmp/repot-flutter-new --execute --flutter
```

Both target directories must be new. Omitting `--execute`, passing unknown flags,
or targeting an existing directory fails before SDK execution. There is no option
to point this runner at a customer repository or supply an arbitrary command.

The runner uses the existing real fixture materializer, analysis, proposal parser,
structural validator, and Dart test adapter. The proposal remains an authored
fixture: **no AI request is made**. For source, destination-before, and
destination-after, it runs `pub get`, `analyze`, and `test` using the selected SDK.
The version command and each package command retain their stdout, stderr, exit
code, signal, execution status and elapsed time in `sdk-acceptance.json`.

The default limit is three minutes and 256 KiB combined output per command.
Timeouts/output exhaustion kill the POSIX child process group and are never
reported as passes. Missing SDKs produce `blocked` and `not_run` package checks.
A failed dependency installation skips that package's analysis/tests; other packages
are still checked. Failed analysis does not hide the test result.

Original authored files are hashed before execution and checked again afterward.
File mutation, deletion, or symlink replacement fails preservation even when SDK
commands return zero. New SDK/cache/lock files are permitted. The original
`review.json` is not rewritten to imply that a hosted review was runtime-verified.

## Isolation boundary

This runner is **not a sandbox**. Dependency resolution may execute toolchain hooks.
Use a disposable machine without production credentials. SDK children receive a
small environment allowlist and fresh home/temp/pub-cache directories, not inherited
API keys, registry overrides or user package caches. This reduces accidental exposure;
it does not isolate filesystem/network access. The SDK itself is not installed by
the runner, and its own installation/cache may still be written by SDK tooling.

The workflow uses a fresh standard Ubuntu GitHub-hosted runner in a **public**
repository, read-only checkout access, no persisted checkout credential, no secrets,
no artifacts, no persistent cache, and no production deployment/database commands.
The official Flutter archive revision and action revisions are pinned; the archive's
SHA-256 is verified against official release metadata and its checkout revision is
checked. Flutter supplies the Dart SDK, so each run records both toolchain versions.

Only the named acceptance branch push and manual `workflow_dispatch` trigger it.
There is no schedule or automatic native validation of customer repositories.
GitHub documents standard hosted runner use as free for public repositories;
logs and step summaries do not consume artifact storage allowance.

## Evidence and scope

Harness regression tests (no SDK required):

```sh
node --test scripts/verify-dart-fixture.test.mjs
```

Local harness validation on Node 22.16.0/Linux: **25 passed, 0 failed, 0 skipped**.
Fixture materialization and SDK calls are explicitly doubled in orchestration tests;
subprocess capture/failure/timeout/output-limit checks run real Node processes.
These 25 tests are **not Dart or Flutter runtime passes**.

An SDK acceptance result is valid only when the actual SDK commands in the report
have run successfully. Even a passing result is limited to these authored package
fixtures: it is not a native app build, emulator/device test, live AI transfer,
arbitrary-repository compatibility result, or complex-mobile integration guarantee.

The previous adapter documentation is [DART-TRANSFERS.md](DART-TRANSFERS.md).

Primary references checked 2026-10-04:

- https://dart.dev/tools/dart-test
- https://docs.flutter.dev/reference/flutter-cli
- https://docs.github.com/en/billing/concepts/product-billing/github-actions

## Observed SDK acceptance — 2026-10-04

GitHub Actions run [37244628809](https://github.com/shlbi/graft/actions/runs/37244628809)
completed successfully at tested commit `df3b26324e22b5db7dd6ec35bee5b4739eeba6b1`.
The actual toolchain was Flutter **3.47.6**, Dart **3.13.5**, Node **24.21.0**,
and Ubuntu **24.04.5**. Official SDK archive checksum and checkout revision matched.

| SDK | Package | pub get | analyze | test | Test executions |
| --- | --- | --- | --- | --- | --- |
| Dart | source | exit 0 | exit 0 | exit 0 | 3 passed |
| Dart | destination-before | exit 0 | exit 0 | exit 0 | 1 passed |
| Dart | destination-after | exit 0 | exit 0 | exit 0 | 3 passed |
| Flutter | source | exit 0 | exit 0 | exit 0 | 3 passed |
| Flutter | destination-before | exit 0 | exit 0 | exit 0 | 1 passed |
| Flutter | destination-after | exit 0 | exit 0 | exit 0 | 3 passed |

Both runs preserved all **23 original files**, including the structural review and
patch evidence. The destination's original test remained intact and passed alongside
the two relocated feature tests under `test/repot_056b2a5b1e7e/`.
The four Node suites passed separately: **25** harness, **73** native adapter,
**77** platform and **83** repairs, with no failures or skips.

The first CI run stopped at an incorrect SDK metadata URL (HTTP 404); it never ran
a native test. The corrected second run above supplies the actual SDK evidence.
A [structured log summary](verification/native-sdk-acceptance.json) records the
observed versions, command exits, durations, provenance and scope. Full generated
reports and stdout/stderr are in that job's logs; this summary is not the raw report.

This closes **authored ordinary-library package acceptance only**. The Flutter
fixtures run library assertions with flutter_test, not a rendered widget or device.
No complete native app build, live AI generation or customer-repository transfer was
performed, and hosted structural reviews are not automatically upgraded to runtime
verified. Dependency constraints are resolved during each run; generated lockfiles
are not persisted in the summary.
