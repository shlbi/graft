# Graft: product contract

Saif's latest direction pauses Kinetic and prioritizes making Graft useful to the software-engineer friend who expressed a real need. Graft is now a product-validation effort, not an automatic weekly portfolio rotation. The existing scheduled Kinetic execution is paused; no new project starts without approval.

## The intended customer experience

Connect GitHub once. Pick the repository containing a feature and the repository that needs it. Describe the feature in plain language. Graft finds the relevant behavior, maps it to the destination, prepares a narrow change set, checks the result in isolation, and presents an understandable pull request. Most users should not need to identify every file, import, adapter, or framework configuration themselves.

If essential information is genuinely ambiguous, ask one focused question. Do not make the user fill out an architecture questionnaire merely to compensate for weak repository analysis. Preserve progress, expose a clear cancel action, and explain failure without claiming success.

The current preview implements the input/discovery/draft/review/download portion, with an optional structured AI adapter. It does not yet implement GitHub sign-in, background job persistence, automated isolated project execution or PR creation.

## Broad vision, honest capability boundaries

Design language and framework adapters rather than hardcoding the product to one upload example. Track three capabilities independently: can this project be inspected, can this feature be adapted, and can this destination be verified? Reading a Python file does not prove that moving it into a TypeScript application is supported.

“Any project” is a long-term product direction, not a release claim. Never fabricate compatibility scores, successful builds, completed tests, dependency completeness, latency savings or accuracy improvements. AI generates hypotheses and proposed edits; measured checks supply evidence.

## Next acceptance gates, in order

1. **One real user transfer.** With the friend's permission, obtain one source/destination pair and a specific feature. Record the baseline, expected behavior and integration constraints. Run the configured AI path with an explicitly authorized model/budget; inspect every proposed change. Measure actual task success, regressions, edits needed, tokens and latency.
2. **Repository understanding.** Replace coarse ranking where needed with symbol-aware retrieval, dependency closure, destination integration-point detection, and the existing engine's reviewed adapter mappings. Handle assets, configuration and database boundaries explicitly. Report incomplete coverage.
3. **Isolated verification.** Durable jobs and cancellation; ephemeral unprivileged workspaces; no shared filesystem or production credentials; restricted network egress and compute budgets. Compare destination baseline checks with post-transplant checks. Do not install or execute untrusted repository/model code in the API server. Ask approval for permission-expanding operations, scripts and migrations. Preserve test output and snapshot hashes.
4. **GitHub delivery.** Configure a GitHub App with minimum necessary installation permissions and explicit per-repository authorization. Authenticate users, isolate sessions, validate webhooks/OAuth state where applicable, and keep installation credentials server-side. Re-read destination heads before writes. Produce a separate branch and reviewable PR, never silent writes to main or automatic merge. Keep source permissions read-only when possible.
5. **Hosted beta.** Add tenant boundaries, request-level authorization, rate/cost limits, retention/deletion policy, logs that omit source/secrets, abuse controls, model-provider consent and a production security review. Pick a hosting account and budget with Saif. Verify browser journeys and a real end-to-end export/PR before inviting users. Buy no domain or infrastructure implicitly.

A second paying or repeated user is a better next demand signal than inventing a broad feature checklist. The friend’s enthusiasm is motivation to test a concrete workflow, not proof of a market size or guaranteed adoption.

## Interview walkthrough

Explain the difference between moving source text and integrating behavior. Trace one request from repo identity to pinned/hashed files, selected context, structured proposal, local validation and downloaded patch. Demonstrate a rejected unseen-file update and an overwrite collision. Show the authored patch preserving an unrelated destination file and existing behavior. Then point to the explicit missing verification/auth/PR gates rather than presenting the preview as a finished hosted system.
