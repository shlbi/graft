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

Controls mutate one known implementation span, never a donor assertion. All controls
must analyze successfully. An SDK failure, compile error, skipped test, missing test,
unrelated failure, late error, truncated event stream, or unexpected success cannot
satisfy the expected-control result. Exact test names and assertion-error events are
checked, not just exit codes or the phrase “tests passed.”

This makes an important distinction concrete: an exportable patch and passing
isolated widget tests do not prove that the destination app exposes the feature.

## Run explicitly

With repository dependencies and Flutter installed, on disposable Linux/macOS:

```sh
node --test scripts/flutter-widget-evidence.test.mjs
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
