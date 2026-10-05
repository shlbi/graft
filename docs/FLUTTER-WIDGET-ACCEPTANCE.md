# Flutter widget and destination-host acceptance

This checkpoint follows ordinary-library SDK acceptance in PR #2. It exercises the
existing transfer engine against an authored stateful widget and an existing app
route. It does not introduce a production SDK worker or claim universal mobile support.

## What the fixture measures

The source contains a `CartPanel` widget, a transitive pricing implementation, four
widget tests, a pricing test, a test helper, and an unrelated donor test. The destination
already has home/catalog navigation, two existing tests, and a cart placeholder.

The real planner, proposal validator, and Dart test adapter assemble six changes:
a widget library, a pricing library, one deliberate host `lib/main.dart` update,
and three automatically relocated test/helper files. The colliding source test
bundle is namespaced without overwriting the destination tests. Original source
test bodies are preserved outside exact import URI spans. No provider call is made.

The original widget tests render the widget, tap increment/decrement buttons,
check the minimum quantity, enter text, verify state through rebuilds, and verify
controller disposal and clean remount. Independent authored host probes exercise
the destination's cart route, return to home, and reenter with fresh state. Those
host probes are test-only acceptance inputs; they are not added to the transfer patch.

## Positive and negative controls

Seven packages run through dependency resolution, analysis and real `flutter test --machine`:

| Package | Expected outcome |
|---|---|
| source | Six original donor tests pass |
| destination-before | Two existing host tests pass |
| destination-after | Two existing and five transferred tests pass |
| host-positive | The seven tests plus two host probes pass |
| host-missing-route | Only the two host probes fail; isolated widget tests still pass |
| host-broken-update | The interaction test and two host probes fail |
| host-missing-dispose | Only the controller-disposal test fails |

Controls change implementation only, never a donor assertion. The missing-route
control retains an unused widget factory so its import is valid. All controls
must analyze successfully. An SDK failure, compile error, skipped test, missing test,
unrelated failure, late error, truncated event stream, or unexpected success cannot
satisfy the expected-control result. Exact test names and assertion-error events are
checked, not just exit codes or the phrase “tests passed.”

This makes an important distinction concrete: an exportable patch and passing
isolated widget tests do not prove that the destination app exposes the feature.

## Run explicitly

With repository dependencies and Flutter installed, on disposable Linux/macOS:

```sh
node --test scripts/flutter-widget-*.test.mjs
node --experimental-vm-modules --test web/test/flutter-widget-core.test.mjs
node scripts/verify-flutter-widget-fixture.mjs /tmp/repot-widget-new --execute
```

The target must not already exist. The runner reuses the bounded, no-shell SDK
process runner, fresh home/temp/pub-cache directories, and a minimal environment.
Every command has a 180-second and 256-KiB output budget. The process is **not a
security sandbox**: SDK/dependency execution must run in a disposable environment
without production credentials. The fixed public GitHub-hosted workflow uses the
previously verified pinned SDK revision, checksum validation, read-only checkout,
no persistent cache/artifacts, and no production/customer write paths.

`widget-sdk-acceptance.json` contains real commands, exits, machine output, named
passes/expected assertion failures, and preservation checks. The original
`review.json` keeps runtime checks `not_run`; fixture acceptance is separate
from a hosted customer's structural review. Expected-failure controls never become
publishable customer changes.

Local observed validation before CI: 38 harness/reader tests passed on Node 22.16.0.
These use explicit SDK/materializer doubles for orchestration; they are not Flutter
runtime evidence. Real core and SDK results must be recorded only after CI executes.

## Remaining boundaries

Widget testing renders a Flutter widget tree in the test environment, not on an
emulator or physical device. No Android/iOS app build, native plugin, asset/golden,
platform-channel, signing, generated-code, live provider, or customer repository
acceptance is established. Existing adapter setup blockers remain unchanged.

Primary references checked for this checkpoint:

- https://docs.flutter.dev/cookbook/testing/widget/introduction
- https://docs.flutter.dev/cookbook/testing/widget/tap-drag
- https://api.flutter.dev/flutter/flutter_test/WidgetTester/pumpWidget.html
- https://github.com/dart-lang/test/blob/master/pkgs/test/doc/json_reporter.md

## Reporter compatibility and negative-control evidence

Flutter's machine stream interleaves `test.startedProcess` daemon arrays with Dart
test reporter objects. Widget matcher failures can also appear as a framework
`TestFailure` print followed by a generic error wrapper with `isFailure: false`.
The reader accepts only the known notification envelope and correlates a same-test
framework diagnostic, expectation location, exact name, wrapper, and completion
order. A plain runtime error does not satisfy a negative control. Hidden failures,
late errors, swallowed framework exceptions, and cross-test diagnostic borrowing
remain failures. This is a bounded classifier for authored fixtures, not an
adversarial log-authenticity protocol.

The first native run, `37252936076`, ran all seven packages and preserved 63
original files, but overall acceptance failed because the reader did not recognize
those reporter forms. The follow-up changes only the reader, its regressions, and
the workflow's regression command. Fixture implementations, donor assertions,
destination tests, and control mutations remain unchanged.

Updated local evidence: `node --test scripts/flutter-widget-*.test.mjs` passed
65 checks on Node 22.16.0/Linux. Seven JavaScript syntax checks and workflow
YAML/embedded-Python parsing passed. These local orchestration/report examples use
explicit doubles; actual Flutter results are recorded separately after CI.

## Observed real SDK acceptance — 2026-10-05 UTC

[GitHub Actions run 37253660375](https://github.com/shlbi/graft/actions/runs/37253660375)
completed successfully at `67226dd4956f3a0e58b5aaa89500fdce4aead15b`.
This is October 4 evening in America/New_York. The observed toolchain was Flutter
**3.47.6**, Dart **3.13.5**, Node **24.21.0**, and Ubuntu **24.04.5**.
Official archive checksum and pinned SDK checkout revision matched.

| Package | Analysis | Test exit | Passed executions | Intended assertion failures |
|---|---|---|---|---|
| source | exit 0 | 0 | 6 | 0 |
| destination-before | exit 0 | 0 | 2 | 0 |
| destination-after | exit 0 | 0 | 7 | 0 |
| host-positive | exit 0 | 0 | 9 | 0 |
| host-missing-route | exit 0 | 1 | 7 | 2 |
| host-broken-update | exit 0 | 1 | 6 | 3 |
| host-missing-dispose | exit 0 | 1 | 8 | 1 |

Every dependency installation exited 0. All expected test names completed, with
no skips or unrelated failures. The six intentional failures were correlated
Flutter framework `TestFailure` assertions, not SDK or compiler failures.
These are repeated executions across fixture copies, not 51 unique tests.

The actual transfer contains **six changes**: two implementation libraries, the
intended existing-host `lib/main.dart` update, and three relocated test/helper
files. The incoming bundle uses `test/repot_5c13a73dd733/`. The destination's existing
home/catalog tests were not overwritten and pass alongside the transferred tests.
All **63 original authored package/evidence files** remained unchanged through SDK
execution, including the original structural review and generated patch.

The same CI run passed all six Node regression commands: **65** reader/harness/
protocol, **9** real widget-core/Git, **25** retained SDK harness, **73** Dart adapter,
**77** platform, and **83** repairs. All reported zero failures and skips.
Node test doubles remain distinct from the actual Flutter SDK execution above.

The [structured observed-log summary](verification/flutter-widget-acceptance.json)
records provenance, exact commands and exits, versions, durations, controls and
remaining boundaries. Full generated reports and machine events are in the job
logs. This summary is not a raw-report copy.

This closes authored **headless widget behavior and destination-route acceptance**.
It does not implement automatic route synthesis, a hosted execution worker, native
Android/iOS builds, device testing, or a live AI/customer-repository transfer.
The six-file proposal and independent host probes are authored acceptance inputs;
production adapter/runtime-verification boundaries remain unchanged.
