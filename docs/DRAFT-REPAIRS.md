# Bounded repairs in one Repot transfer

This updates the one-attempt resumable workflow in ASYNC-DRAFTS.md. It is not
permission to skip validation, change the requested feature or merge a PR.

## User-visible contract

`repot_draft` saves `maxRepairAttempts` with the request. New requests default to
2; a caller can select 0 or 1 but cannot exceed 2. The tool description discloses
that each actual generation attempt consumes the existing daily draft allowance.
This is an attempt/output budget, not a fixed dollar-price guarantee. The existing
AI/background-storage consent is still required. Platform tool confirmations are
controlled by the client, not bypassed by this code.

The client keeps polling the SAME job ID. A repairable rejection returns
`stage: adjusting_integration`, `continueAutomatically: true`, a fixed validation
code/message, and numeric attempt progress. It does not become a terminal failure
and does not ask the user to authorize another job within the saved budget.

The operation remains client-driven: no status polling means preparation, cleanup
and additional submissions do not advance. There is no detached worker or promise
that this assistant will deliver a result later.

## Repair lifecycle

1. Read and pin source/destination snapshots once, as before.
2. Submit the initial background generation.
3. Retrieve completed output and run the existing structural/test-transfer review.
4. On a known repairable rejection, keep the same feature and pinned context;
   encrypt the bounded prior proposal and fixed diagnostic in the job payload.
5. In a separate short step, delete the completed rejected provider response.
   If cleanup is unavailable, retain its handle and resume the same step later.
6. Atomically increment the saved attempt count and daily allowance together with
   dispatch intent, then submit a complete replacement proposal with feedback.
7. Validate again. Maximum: one initial generation plus two targeted repairs.
8. A successful review records generation counts and validation-history codes.
   It still requires explicit review/publication. Tests/builds remain `not_run`.

Ordinary formatting, list-size, source-citation and file-mapping errors can be
repaired. Unsafe paths/content, uninspected destination updates, insufficient
context, refusals and incomplete provider output do not automatically retry.
A blocked deterministic test transfer remains an unexportable review; this change
does not teach new frameworks or weaken assertion-preservation requirements.

Unknown exceptions are `validator_error`, NOT `invalid_proposal`. Only actual
`ProposalValidationError` instances from the validator carry repairable feedback.
An arbitrary error with a copied code cannot authorize another generation.

At exhaustion the final specific rule remains in `error_code`, with
`repairBudgetExhausted: true` in status. Terminal context still becomes NULL;
there is no new long-lived store of rejected source code. The old failure whose
context was already deleted cannot be reconstructed by this change.

## Shared generator/validator contract

`web/lib/proposal-contract.mjs` owns the numerical limits and fixed diagnostics.
The output schema uses bounded strings/lists and inspected-source enums. The
request also includes byte limits and editable destination paths. UTF-8 byte
limits, sensitive-content detection, provenance, collisions and test transfer
are still checked locally; schema conformance is not proof of correct code.

Feedback is data, never model instructions. It has a 160KB serialized bound and
is not retained/resubmitted when sensitive-looking content is detected. A
pre-scan over every proposed file prevents an earlier cosmetic error from hiding
a later unsafe file. No raw exception, token, provider response envelope or
refusal is included in feedback or public diagnostics.

## Safety, compatibility and storage

No schema migration, credential change, extra queue or deployment setting is
required. The existing encrypted payload stores attempt counts and feedback;
the existing error_code holds the fixed final reason. Existing state constraints
and terminal payload clearing remain compatible.

Leases serialize the job. Cancellation is checked before queuing a repair,
charging or finalizing. A lost provider acknowledgement is still
`submission_unknown`, never an automatically repeated billable POST. Transient
poll/delete/DB failures can resume the existing step without changing features.
No distributed exactly-once execution guarantee is made.

Legacy jobs without a saved repair budget remain single-attempt. A retry of an old
requestKey can recover that same job using its old hash, but cannot grant repairs
retroactively. Terminal jobs remain terminal. A different new job requires a new
requestKey and the user's transfer authorization; changing the saved budget under
an existing key is rejected.

The pinned model, medium reasoning, background retention disclosure, 12,000-token
output cap and GitHub draft-PR-only publishing are unchanged. A validated
structural patch is not proof the integrated feature runs. Isolated live project
execution remains a separate acceptance requirement.

## Reproducible validation

- `npm run test:repairs` exercises the focused repair/contract/SQL-wiring suite.
- `npm run test:drafts` includes existing lifecycle/provider/timeout tests plus the
  new repair tests.
- Fixtures exercise actual orchestration, parser, shared schema and structural
  validator; PostgreSQL, MCP SDK, provider and test-transplant boundaries are
  explicitly simulated. Driver-recording tests verify transaction ordering and
  parameters, not real PostgreSQL concurrency.
- See `docs/verification/draft-repairs.json` for executed results and limitations.

Primary reference for the supported schema subset:
https://developers.openai.com/api/docs/guides/structured-outputs
Existing background-storage semantics:
https://developers.openai.com/api/docs/guides/background
