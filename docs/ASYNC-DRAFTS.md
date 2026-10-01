# Resumable MCP drafts — activation requires an approved migration

## Why the 300-second route was insufficient

The previous MCP tool awaited repository reads, foreground OpenAI generation, review
validation and persistence in a single request. A Vercel route ceiling is not an
end-to-end client guarantee, and the foreground provider adapter still had its own
deadline. The latest user report establishes continued timeouts, not which deadline
fired. Do not claim a particular ChatGPT timeout without an observed error/timing.

The hosted draft path now uses ordinary MCP tools and provider-side background
responses. It does not rely on the optional MCP Tasks extension, progress events,
Vercel `after`, a process-local Map, or a detached worker surviving a deployment.

## Protocol

1. `repot_draft` persists an owner-bound encrypted request and returns **jobId**.
   It does not wait for snapshots or generation. Supply `allowAI: true`, explicit
   `allowBackgroundProcessing: true`, and one stable `requestKey`.
2. Call `repot_draft_status(jobId)` to advance **one bounded step**:
   - queued -> read/pin the two repositories, select context, persist prepared state;
   - prepared -> atomically reserve allowance and mark submitting, then submit ONE
     OpenAI background response and save its opaque provider ID;
   - running -> poll once; pending is normal, not an excuse to change the feature;
   - completed -> validate with the same deterministic `reviewProposal`/test-transfer
     engine, then insert the review and job reference in one transaction.
3. Follow `nextTool` and `pollAfterSeconds`. Read the exact saved review with
   `repot_review(reviewId)`, including `exportable`, tests and `not_run` statuses.
4. Only an exportable review can be published after explicit user confirmation.
   `repot_publish` still creates a branch and draft PR, not a merge.
5. `repot_draft_cancel(jobId)` records cancellation and attempts provider cleanup.

The job has not started model generation merely because its initial status is
`queued`. The client must drive preparation and submission with status calls.
Once submitted, generation runs at OpenAI independently of the MCP connection.
No timing-based completion percentage or automatic later-delivery promise is made.

## Retry and crash behavior

Reuse the SAME `requestKey` after losing the start response; it returns the same
job. A different feature with the same key is rejected. The original requested
feature must not be replaced by JSON export or another smaller task automatically.
Only the submission step consumes a draft allowance. Status polls do not regenerate.

A database lease serializes each job's steps. Review insertion and the job's
review ID commit atomically. A new server instance can resume from PostgreSQL.
Cancellation wins before review finalization; it cannot undo a completed review.

There is no distributed exactly-once claim across PostgreSQL and OpenAI. If a
process dies after committing submission intent but before saving the provider ID,
the recovered job becomes `submission_unknown`. Generation may have been accepted
and billed. The service NEVER automatically resubmits that ambiguous POST. A
transient failure polling a saved provider ID can be retried using the same job.

Requests to start background generation have a 12-second network deadline; polls
have a 10-second deadline. Repository preparation has a 20-second application
budget. Database statements have 5-second limits inside short transactions, with
3-second lock limits and 45-second job leases. These are operation budgets, not a
promise about total observed tool latency. No network request runs inside a DB
transaction. Do not attempt to fix a timeout by changing the requested feature.

## Privacy and limits

The model remains **gpt-6.1-sol**, medium reasoning, strict structured output, no
tools, and the same context/output bounds. `store: false` is explicit. **Background
mode nevertheless temporarily stores response data at OpenAI for asynchronous
execution and polling (roughly ten minutes per current documentation).** It is
not a zero-retention flow. The MCP schema and tool description require explicit
background-storage consent; old calls without it are rejected before submission.
Provider/account policies still apply; a successful DELETE is not a claim that
all service logs or backups everywhere have been erased.

Repot requests cancel/delete on terminal outcomes and reports
`providerCleanupPending` if deletion could not be confirmed. The provider poll
window is limited to eight minutes from submission; missing/expired responses
fail rather than silently regenerate. Encrypted local job contexts are cleared
on completion, failure or processed cancellation. Jobs expire for access after
one hour. Expiry is not a background deletion scheduler: abandoned records need
an operator retention sweep if no later status call processes them. No cron or
paid queue has been installed. There are at most three unexpired active jobs and
fifty newly created jobs per owner per rolling day, plus the existing draft quota.

No GitHub access token, OpenAI key, provider response ID, ciphertext, or lease token
is returned in job status. Owner checks precede reads, polls and cancellation.
No user repository code is executed in this service; tests/builds stay `not_run`.

## Activation

The schema is additive: `docs/migrations/001-draft-jobs.sql` creates only
`public.repot_draft_job` and its indexes. Existing auth, review and quota data are
not replaced. Test it on a temporary Neon branch and obtain approval before applying
it to production. A missing table returns `setup_required`, not a fake queued job.

A trusted operator can execute `npm run draft:migrate` after approval. It is NOT
part of `npm run build`. Do not copy database credentials into another runtime or
add automatic schema mutation to deployments. Activate the code only after the
production migration is verified; then refresh the MCP client's tool definitions.

## Validation boundary

Run `npm run test:drafts`. Tests exercise orchestration, actual transport functions,
MCP handler bodies and foreground compatibility with synthetic I/O. SQL constraint
and rollback checks were separately run on a temporary Neon branch. These are not
a real paid GPT-6.1 Sol generation, a ChatGPT connection, a Node 24/full Next build,
or proof that a transferred Pomodoro implementation works. The live acceptance
case remains the ORIGINAL requested feature, followed by exact review and explicit
publication—not a substitute feature or a manual bypass.

Primary references checked 2026-10-01:
- https://developers.openai.com/api/docs/guides/background
- https://developers.openai.com/api/docs/guides/your-data
- https://vercel.com/docs/functions/configuring-functions/duration
