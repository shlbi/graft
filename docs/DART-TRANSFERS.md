# Dart and Flutter package transfers

This checkpoint adds a **real native test relocation path** to the existing hosted
inspect → draft → repair → review workflow. Recognizing a project is no longer the
only Dart/Flutter capability: an ordinary library transfer can carry its related
unit/widget tests and imported Dart test helpers into the destination package.

This is not universal mobile support. A structurally valid review is not a native
build, widget-rendering result, or device test. Kotlin/Swift and other native
languages still require their own test/toolchain adapters.

## Supported path

The source and destination must resolve to one inspected Dart/Flutter package each.
They can live at different monorepo roots. `pubspec.yaml` supplies package identity
and declared dependency names; it is read as a bounded static subset, not executed
or treated as a full YAML/package resolver.

Select the source library entrypoints and existing destination integration files
with `sourcePaths` and `destinationPaths`. Automatic selection remains available.
Repot follows ordinary local and self-package Dart imports, walks reverse imports
to related `test/**/*_test.dart` files, and includes their transitive Dart helpers.
Required implementation dependencies must map to proposed destination libraries;
the adapter never copies a second donor implementation into test support just to
make assertions pass.

For an authored cart fixture, the complete result includes:

```text
lib/features/basket.dart       adapted feature API
lib/features/price.dart        transitive production dependency
test/cart_test.dart            original feature assertions
test/price_test.dart           original dependency assertions
test/support/cart_helper.dart original helper with destination-package import
```

The default runner layout is derived from Dart/Flutter conventions, not guessed
from an arbitrary existing destination test. Dependencies used by transferred
code/tests must already be declared where required. The code checks names, **not**
resolved versions or package API compatibility.

## Preservation and collisions

The adapter edits only exact import/export URI literal-content spans in copied
tests/helpers. Assertions, callbacks, matcher names, aliases, annotations, strings,
comments and whitespace outside those spans remain byte-for-byte unchanged. A
SHA-256 digest after masking URI ranges is stored for each copied placement.
This digest proves the scoped text-preservation check, not test execution.

`package:donor/cart.dart` can become `package:store/features/basket.dart`; relative
imports follow the actual destination layout. Existing destination tests are not
overwritten. If a test/helper bundle collides, the whole bundle moves under a
stable `test/repot_<digest>/` directory, with its imports adjusted together.
No partially copied native test set is exported after a blocker.

Native discovery is recomputed from pinned snapshots at review time. Provider-
supplied `testPlan` data cannot remove required tests. Model-authored tests and
runner/pubspec changes cannot bypass this preservation boundary.

## Targeted repair, not blind regeneration

The existing per-job budget remains one initial attempt plus at most two repairs.
Two fixed native diagnostics can use that same loop:

- `proposal_dart_import`: unresolved/undeclared generated-library imports. Feedback
  includes the affected change index when known.
- `proposal_dart_mapping`: missing or ambiguous source-to-destination library
  mapping needed by the original tests.

The client continues polling the same job. The original request, selected paths,
pinned snapshots and source test plan are retained. Each submitted attempt uses
the existing quota accounting. Ambiguous submissions are not resent. No database
migration, new credentials, SDK installation, worker or hosting change is required.

Source/setup/policy blockers do not become permission to retry until tests vanish.
They yield an unexportable review or the existing typed failure instead.

## Explicit boundaries

Supported rewriting is ordinary Dart library imports plus the default test layout.
The current adapter stops on `part` libraries/code generation, conditional platform
imports, custom test/build configuration, incomplete inspected snapshots, device
integration tests, and detected fixture/native-resource requirements. Examples of
separate setup include golden images, filesystem resources, FFI and method channels.
The static detection is conservative, not a complete semantic dependency checker.

Package version resolution, dependency installation, navigation wiring, assets,
permissions, native SDK setup, Xcode/Gradle projects, signing, device lifecycle and
cross-language test conversion are not completed by this adapter. Native source
outside the selected package does not automatically cross the boundary.

Existing 110KB selected-text and 32-file/120KB combined patch limits remain. Planned
work groups do not yet execute a larger feature as multiple verified stages.

## Reproduce the checks

With repository dependencies installed and Git available:

```sh
npm run test:dart
npm run test:repairs
```

`test:dart` runs the actual parser, project planner, structural validator and native
adapter on authored fixtures. It also exercises real Git patch application. The
job-lifecycle tests use explicit in-memory provider/store doubles, while native
analysis, request construction, review and repair classification execute real code.
No paid generation or Dart/Flutter code execution occurs in this test command.

Create new disposable fixture directories for independent SDK validation:

```sh
node scripts/materialize-dart-fixture.mjs /tmp/repot-dart-check
node scripts/materialize-dart-fixture.mjs /tmp/repot-flutter-check --flutter
```

The command refuses existing directories. Each output contains source, destination-
before, destination-after, an exact patch, a scoped review record and `CHECKS.md`.
These are authored package fixtures, not complete mobile apps or AI output. An
operator with an appropriate SDK can separately install fixture dependencies, run
analysis/tests on all three directories, and record exact outcomes. Run this in
an isolated disposable environment without production credentials; the fixture
materializer does not provide a sandbox or execute those commands itself.

Observed evidence is in [dart-transfer.json](verification/dart-transfer.json).
Runtime verification remains `not_run` until the actual SDK/test command succeeds.

## Primary references

Checked 2026-10-04:

- [Dart library URIs, prefixes and combinators](https://dart.dev/language/libraries)
- [Flutter/Dart unit test layout](https://docs.flutter.dev/cookbook/testing/unit/introduction)
- [Flutter widget testing](https://docs.flutter.dev/cookbook/testing/widget/introduction)
- [Dart test runner configuration](https://pub.dev/packages/test)
