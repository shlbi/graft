# REPOT Pro — Stripe Payment Link billing

## Current rollout

The owner supplied this public Payment Link:

`https://buy.stripe.com/5kQ28kdMW15M6mld42cfK00`

It is pinned in `remote/billing.mjs`. The checkout's price, currency, recurring
interval, account ownership and active status have **not** been verified against a
live Stripe account in this development session. The public checkout could not be
read and the Stripe connector is not connected. No real payment or refund was made.

Billing is **off by default**. `/pricing` displays the $15 USD/month plan but leaves
checkout disabled until explicit configuration and activation. Existing alpha
access stays unchanged with the flag unset/false. A typo in the flag fails closed.
The planned ChatGPT-funded option is visibly disabled; no OAuth integration or
subscription-sharing approval is implied. ChatGPT limits will still apply.

## Flow

`/pricing` opens `/billing/checkout` in a new tab using `noopener noreferrer`.
GitHub sign-in establishes the REPOT account before the server checks the actual
Stripe Payment Link and its single USD 1500 monthly licensed price. No caller can
supply the redirect URL, plan, amount or account ID. The server appends a random
`client_reference_id` (no email, REPOT user ID, session token or key in the URL).

Stripe sends signed `checkout.session.completed` and
`checkout.session.async_payment_succeeded` snapshot events to
`https://getrepot.com/api/billing/stripe`. The handler checks the unmodified raw body,
HMAC-SHA256 signature and five-minute timestamp tolerance, then retrieves the
Checkout Session from Stripe. Only this link, price, mode and known reference can
bind a Stripe subscription to its REPOT owner. Replays are idempotent; a different
owner cannot claim a bound subscription. A reference is attribution, not an access
credential, so saved links and delayed notifications remain reconcilable after
its 24-hour reuse window. Account deletion cascades local billing records but
does **not** cancel a Stripe subscription; cancel or reconcile billing before
deleting an account, so a recurring charge cannot be orphaned locally.

**Webhooks never set an unconditional `paid=true` flag.** Before each new remote
AI submission—including repairs—the server retrieves the linked subscription and
latest invoice from Stripe. Access requires the exact plan, active status, current
period and paid invoice. Paused, unpaid, canceled or expired access is denied.
Cancellation at period end preserves access until that paid period ends. Outages
leave the same job recoverable without spending an AI attempt. Payment denial
stops the job before quota/dispatch. Resume/retrieve, cleanup, cancellation, review
and publication do not require another subscription check.

This read-through approach handles renewals and event-ordering without trusting
stale subscription webhook payloads. It adds Stripe reads before model submissions
and intentionally fails closed during Stripe outages. Existing daily allowances,
per-job repair budgets, source/test preservation and publication consent remain.
No ChatGPT-token-to-REPOT-API fallback exists.

`/billing` reads actual state; `?success=1` and `?session_id=...` cannot grant access.
An authenticated same-origin POST to `/billing/portal` opens a new REPOT tab with
a checked, temporary **Continue to Stripe** link for an already-bound customer.
The ordinary link preserves the existing narrow global OAuth form-action policy;
the billing route never adds Stripe to every page's form allowlist. Native
no-referrer forms with `Origin:null` require same-origin Fetch Metadata.
Browser-supplied customer IDs are never used.

## Operator setup — not performed automatically

1. Keep `REPOT_BILLING_ENABLED=false` while configuring.
2. Apply `node scripts/migrate-billing.mjs --execute` to the intended database.
   This additive migration is never run by builds or HTTP requests. The existing
   Better Auth `user` table and draft-job schema must already exist.
3. Configure server-only Vercel variables. Never paste secrets into chat or commit them:
   - `STRIPE_SECRET_KEY`: restricted or secret API key. Needs read access to Payment
     Links and their line items, Checkout Sessions, Subscriptions and expanded
     invoices/prices; write access to create Billing Portal Sessions.
   - `STRIPE_WEBHOOK_SECRET`: the endpoint signing secret, not the API key.
   - `STRIPE_PAYMENT_LINK_ID`: the `plink_...` API ID for the supplied URL. The URL
     slug is **not** this ID; do not infer it.
   - `STRIPE_PRICE_ID`: the exact `price_...` recurring $15 USD monthly price.
   - `REPOT_DAILY_DRAFT_LIMIT`: explicitly choose a sustainable allowance (1–1000
     AI attempts per UTC day). The pricing page discloses this value; each repair
     is an attempt. This implementation does not promise unlimited funded usage.
4. Configure the webhook above for the two Checkout Session events and snapshot
   API version `2025-06-30.basil`, matching the pinned server request version.
5. Enable a Stripe customer portal with cancellation and payment-method updates.
   Do not enable unsupported plan changes until their entitlement rules are added.
6. For staging use test keys, test IDs, the test endpoint secret and
   `STRIPE_TEST_PAYMENT_LINK=https://buy.stripe.com/test_...`. Live keys always use
   the exact owner-supplied live link; test keys cannot send users to it.
7. Set `REPOT_BILLING_ENABLED=true` only in the isolated test deployment, and run
   real Stripe test-mode checkout, delayed payment, forged signature, replay,
   renewal, cancellation and portal checks. Confirm a new remote draft is blocked
   without access and succeeds with access. No Stripe test-mode acceptance is
   claimed by the mocked tests in this commit.
8. Review the allowance, taxes, refunds/support and portal experience. Activate
   live billing with the flag only after the full test-mode flow passes.

For the Payment Link's optional post-payment redirect, use
`https://getrepot.com/billing`. The redirect itself is never required for ownership
binding or fulfillment; Stripe webhooks supply that evidence.

## Boundaries and support cases

The bare reusable public link cannot identify a REPOT account. Advertise the REPOT
pricing page, not a copied personalized Stripe URL. Missing/unknown references
produce a failing webhook for operator reconciliation rather than guessing by
email or granting the wrong account. Do not ask a charged customer to pay again.

Reusable Payment Links cannot fully prevent simultaneous duplicate purchases.
Normal checkout blocks already-linked active/pending subscriptions, and repeated
redirects reuse an opaque reference. Concurrent purchases can still require a
refund/reconciliation. Multiple distinct Stripe customer IDs on one REPOT account
require support rather than guessing which portal to open.

Refunds/disputes do not necessarily cancel a Stripe subscription; operators must
apply the cancellation/access policy when handling those cases. Automated
refund/dispute revocation, migration of existing subscribers, and the ChatGPT
provider are not implemented in this checkpoint. None is claimed as tested.

This paywall applies to the hosted remote draft service, not separately self-hosted
legacy/open-source deployments. Do not market the old web simulator as a paid
production workflow. No provider secrets, schema or billing flags were changed in
production by this code commit.

## Verification

`node --experimental-vm-modules --test remote/test/billing*.test.mjs remote/test/draft-service-wiring.test.mjs`

The local tests exercise deterministic Stripe/store doubles, actual Node signature
verification and the production submission-wrapper wiring. The PostgreSQL test
runs only with `TEST_BILLING_DATABASE_URL` pointing to a disposable local database
named `repot_billing_test`. CI uses synthetic users and database credentials, not
production data. Real Stripe charges, webhook delivery and portal interactions
must be tested separately.

Primary sources checked October 7, 2026:
- https://docs.stripe.com/payment-links/url-parameters
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/billing/subscriptions/webhooks
- https://docs.stripe.com/api/subscriptions/object?api-version=2025-06-30.basil
- https://developers.openai.com/siwc/token-sharing-open-source


## Observed checkpoint — October 7, 2026

GitHub Actions run [37704552037](https://github.com/shlbi/graft/actions/runs/37704552037)
completed successfully at `6ead5e37a58ccd082fc42de40e1a45765a2808d0`.
The job ran on Ubuntu 24.04.5, Node 24.21.0, npm 11.19.0, PostgreSQL 16.15
and Next.js 16.3.6. Its observed gates were:

| Gate | Observed result |
|---|---|
| Billing, browser handlers, production wiring and real PostgreSQL | 42 passed, zero failures/skips |
| Existing draft and repair regressions | 142 passed, zero failures/skips |
| Existing authentication regressions | 161 passed, zero failures/skips |
| Next production build, billing disabled | Passed |
| Legacy frontend suite | 23 passed, 7 failed on both untouched main and this branch |

The frontend result is **not a full frontend pass**. CI compared the original
four test files on separately extracted main `78726eb75fb8e5aa5ac2b9f50a5aef95c372d804`
and this branch with the same Node runtime. Every relevant legacy input was
byte-identical, and both runs produced the same seven failure names and counts.
The existing failures include old branding hashes, directory enumeration, arrow
presentation expectations and a syntax error already present in presentation.test.mjs.
The old assertions were not edited to make this billing change pass.

The first billing run exposed a broadened global form-action policy; the corrected
implementation restores the exact original policy and uses the checked portal
continuation link described above. The second run exposed the pre-existing frontend
failures; the third provides the explicit baseline comparison and completed build.

All Stripe API responses in these tests are controlled doubles. Cryptographic
signature checks and PostgreSQL migration/ownership/concurrency checks execute real
local code and a disposable database, respectively. **No real Stripe checkout,
test-mode payment, webhook delivery or customer portal session was exercised.**
No production migration, credential, billing flag or Stripe setting was changed.

The structured observed-log summary is `docs/verification/stripe-billing.json`.
The current continuation point is `.nightshift/BILLING-HANDOFF.json`; it supersedes
the older native-fixture next steps for this billing task, without rewriting their
historical acceptance records. Configure and verify Stripe in test mode before
activating live payment collection. The ChatGPT-funded provider remains unimplemented.
