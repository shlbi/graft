# Platform expansion checkpoints

This work expands Repot beyond the original JavaScript/TypeScript path. A detected
framework is **not** a verified integration. Native builds and device checks are
separate acceptance gates; no runtime verification is fabricated.

## Checkpoint 1 — project inventory and safe mobile intake

`web/lib/project-profile.mjs` inventories nested projects from manifests: React
Native/Expo, Flutter/Dart, Android/Gradle, Apple/Xcode, Swift packages, MAUI/.NET,
Python, Go, Rust, JVM/Maven, Ruby, PHP and CMake. Mixed monorepo roots remain
separate. Inspection now returns both project profiles. Feature ranking uses one
central language classifier rather than a second, inconsistent extension list.

Mobile project text (Dart, Gradle, XML, plist and Xcode metadata) is eligible for
bounded inspection. Signing material, service credentials, local machine config,
dependency caches and binary assets are not. Input limits are unchanged.
Unsupported native tests prevent an export instead of silently disappearing.
No Gradle, Podfile, Package.swift, scripts or other repository code is evaluated.

Validation: `node --experimental-vm-modules --test web/test/project-profile.test.mjs web/test/platform-core.test.mjs` — 40 passing tests,
zero failures/skips, Node 22.16.0/Linux. The focused core tests execute the real
structural validator with the legacy JS test adapter substituted; native runtime
execution is not simulated as passed. Core and profile syntax checks passed.
Full production build and real native SDK execution are not claimed here.

## Next checkpoints

- Dependency-aware, scoped feature plans and explicit missing-context reporting.
- Supported native test adapters, with assertion-preservation fixtures.
- Isolated compiler/test runners and device/emulator acceptance for each ecosystem.
- Incremental large-repository intake and validated multi-stage integration.

## Primary format references

- Dart libraries: https://dart.dev/language/libraries
- Flutter tests: https://docs.flutter.dev/testing/overview
- Flutter test layout: https://docs.flutter.dev/cookbook/testing/unit/introduction
- React Native platform files: https://reactnative.dev/docs/platform-specific-code
- Android build structure: https://developer.android.com/build/android-build-structure

The current work does not change credentials, database schemas, hosting settings,
API model selection or the draft-PR-only publication boundary.
