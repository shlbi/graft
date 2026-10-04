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

## Checkpoint 2 — scoped, dependency-aware integration plans

`repot_inspect` and `repot_draft` accept optional `sourcePaths` and `destinationPaths`
(1–20 exact inspected paths). They are canonicalized into the durable request hash,
so polling/repair cannot quietly change the selection. Existing unscoped hashes remain
compatible. Selected files, transitive dependencies, related tests and mobile config
are prioritized before fallback context.

Dart directives have lexical URI spans and self-package resolution; conditional
branches are retained. Existing JS/TS parsing remains authoritative for that path.
Go package siblings/imports, Python static imports, Swift target siblings, JVM module
references and C/C++ headers provide labeled, conservative dependency evidence—not
universal symbol resolution. Unsupported/dynamic cases are reported, not guessed.

Source and destination share the existing 110KB text budget rather than a rigid
55KB half each. Complete files are selected; a 60KB source can now fit alongside a
40KB destination. Missing required context blocks generation *before* a quota charge.
Work groups describe a decomposition plan, not independently applied partial changes.
Large-repository staged execution remains future work.

The generator receives compact project/platform/verification metadata. Saved reviews
expose the same plan. Native dependency registration, permissions, entitlements,
resources, platform variants and lifecycle/device checks are explicit. Commands are
non-executed suggestions for an authorized isolated runner, never shell execution.

Validation: `npm run test:platforms` — 77 passed; `npm run test:repairs` — 83 passed;
zero failures/skips in both. Tests use real planning/orchestration/structural code
with the documented legacy SDK/provider/database/test-adapter doubles. The deployed
first checkpoint's Vercel check succeeded. No live native build or paid generation.

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
