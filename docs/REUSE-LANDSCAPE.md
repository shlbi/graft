# Graft and the existing code-reuse landscape

_Last primary-source check: 2026-09-20._

Graft does **not** claim to invent code reuse, automated refactoring, code generation, or cross-application composition. Those are established areas with mature tools. The v0.1 contribution is intentionally narrower: for an explicitly supported TypeScript subset, Graft treats an application feature as a declared dependency slice with infrastructure boundaries, maps those boundaries to capabilities the destination explicitly advertises, shows the exact copy/rewrite/integration plan for human approval, applies only that reviewed plan, and then executes destination verification.

## Established approaches Graft builds beside

### Package/workspace reuse

npm workspaces are designed to manage multiple local packages from one root package and automatically link those packages during installation. That is a strong answer when reusable behavior is already packaged behind a stable module boundary.

Primary source: https://docs.npmjs.com/misc/workspaces/

**Different problem:** Graft's demo starts with behavior embedded inside one application rather than a pre-extracted reusable package. It still refuses to infer arbitrary runtime dependencies; the feature contract and adapter boundaries must be declared/supported.

### Codemods and AST source transformation

Meta's jscodeshift describes itself as a toolkit for running codemods over JavaScript/TypeScript files. Codemods are the right abstraction for repeatable source-to-source migrations and refactors.

Primary source: https://github.com/facebook/jscodeshift

**Different problem:** Graft uses deterministic source analysis/rewriting as implementation machinery, but its review unit is a feature transplant: dependency closure + destination capability mapping + exact destination integration + executable verification. Graft is not a general codemod engine and v0.1 does not accept arbitrary transforms.

### Workspace generators and migrations

Nx generators can create/update/move/delete files, and Nx migration/sync generators can update repository configuration from known project information. This is established automation for scaffolding and controlled repository changes.

Primary sources:
- https://nx.dev/docs/kb/creating-files
- https://nx.dev/docs/kb/migration-generators
- https://nx.dev/docs/concepts/sync-generators

**Different problem:** generators normally encode the destination changes ahead of time. Graft's supported flow first analyzes a declared source feature slice, stops at declared adapter boundaries, compares those needs with a destination capability inventory, then produces the concrete plan that must be approved before apply.

### Runtime composition / micro-frontends

Webpack Module Federation lets separately built modules expose and consume code at runtime so multiple builds can form one application.

Primary source: https://webpack.js.org/concepts/module-federation/

**Different problem:** Graft v0.1 produces source-level destination changes and verifies the resulting destination build. It is not runtime federation and does not require the source application to remain deployed as a remote container.

## The narrow v0.1 claim

For the documented TypeScript subset, Graft demonstrates a conservative workflow that conventional copy/paste does not provide as one reviewable operation:

1. **Declare** a feature entry point, owned files, supported adapter contracts, and allowed integration mounts.
2. **Analyze** static TypeScript ESM dependencies and stop at declared infrastructure boundaries.
3. **Inventory** destination capabilities explicitly rather than guessing from filenames or model confidence.
4. **Map** source requirements to compatible destination adapters; ambiguity or missing support becomes a blocker.
5. **Review** copied files, rewritten adapter imports, destination integration before/after, touched paths, and blockers.
6. **Approve** the exact prepared plan; stale source, destination, or adapter inputs invalidate application.
7. **Apply** only the reviewed changes while preserving unrelated destination snapshots.
8. **Verify** the destination by compiling and executing the transplanted upload/processing/progress flow, then resetting and repeating the demo.

The current demo additionally puts a bounded localhost HTTP transport around the transplanted backend feature. Upload acceptance is represented as an explicit in-memory queued job with polling. This improves the demonstration of the background-processing boundary but **does not** turn the demo into a durable job system.

## What Graft does not claim

- No arbitrary cross-framework transplantation.
- No discovery of undeclared runtime, environment, network, database, or secret dependencies.
- No proof of semantic equivalence from an AI confidence score.
- No automatic selection between ambiguous destination capabilities.
- No production-grade durable queue, object store, authentication system, deployment system, or CI guarantee in v0.1.
- No replacement for extracting stable shared behavior into packages when normal package reuse is the better architecture.

## Why this distinction matters

The useful engineering question is not “can code be reused?” It obviously can. Graft explores whether a **feature-level application change** can be made more inspectable and reproducible when the source and destination share a supported technology subset but use different infrastructure modules and integration points.

That is why the acceptance evidence is operational rather than rhetorical: source behavior, destination-before state, dependency/capability plan, explicit human approval, exact touched paths, destination build/test execution, post-transplant behavior, and clean reset/repeat.
