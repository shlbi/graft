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
