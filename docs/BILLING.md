# REPOT Pro — Stripe Payment Link billing

## Current rollout — October 8, 2026

The owner connected Stripe and authorized finishing billing and committing/pushing.
The actual Getrepot live account now verifies the supplied Payment Link and price.
No duplicate product, price, or Payment Link was created.

| Resource | Verified non-secret value |
|---|---|
| Payment Link URL | `https://buy.stripe.com/5kQ28kdMW15M6mld42cfK00` |
| Payment Link API ID | `plink_1UO45L6SP0lvEsfmU0B4F8ng` |
| Monthly Price ID | `price_1UO43R6SP0lvEsfm4EilHFlL` |
| Existing Product ID | `prod_VOrnQgI48rcXPk` (Stripe display name: Plus) |
| Dedicated portal configuration | `bpc_1UOLsP6SP0lvEsfmIH2Vvu9I` |
| Staged webhook endpoint | `we_1UOLu56SP0lvEsfmZzowySad` |

The active live link contains exactly one quantity-one licensed, per-unit USD
1500/month recurring price, without a trial or adjustable quantity. This is a
**$15/month base price**, not a promise of tax-inclusive pricing. Existing Stripe
Managed Payments and automatic tax settings remain enabled and unchanged.

The new portal configuration enables invoice history, payment-method updates, and
cancellation at the end of the paid period. Plan changes and public portal login
are disabled. The new webhook subscribes to the two checkout events below and is
**disabled until the receiver is securely configured and tested**.

**Live activation is incomplete.** The current Vercel connection lists no projects
for the available team and returns `Project not found` for REPOT. It cannot verify
or install the server credentials, identify the production database, run its
migration, or change the billing flag. Only a live Stripe account is authorized;
no Stripe sandbox/test-mode account is available to this session. These are access
blockers, not evidence that the application or its existing secrets were deleted.

No production environment/database change, live payment, refund, or end-to-end
Stripe test was performed. The ChatGPT-funded provider remains unimplemented and
visibly disabled. Its approval/implementation is separate from Stripe setup.

## Flow and invariants

`/pricing` opens `/billing/checkout` in a separate tab with `noopener noreferrer`.
GitHub sign-in establishes the REPOT owner. The server verifies the configured
Payment Link and its exact monthly price before appending an opaque random
`client_reference_id`. No email, REPOT user ID, session token, or key goes in that
URL. Never advertise a copied personalized Stripe URL as a generic signup link.

The signed raw-body receiver is `https://getrepot.com/api/billing/stripe`, with
snapshot API version `2025-06-30.basil`, matching the server request version:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

It verifies HMAC-SHA256 and a five-minute timestamp tolerance, then retrieves the
authoritative Checkout Session. Only the correct mode, link, price, and known
reference can bind a subscription to its owner. Replays are idempotent and cannot
change ownership. The reference is attribution, not an access credential. Its
24-hour reuse window does not invalidate attribution for delayed notifications.

**A webhook or success URL never grants unconditional paid access.** Before every
new remote AI submission or repair, REPOT reads the bound subscription and latest
invoice. Access requires the exact price, active unpaused status, a current paid
period, and a paid invoice. Period-end cancellation retains access until that
period ends. Stale events cannot restore canceled access. Provider outages leave
the same job recoverable without consuming another AI attempt. Existing quotas,
repair limits, source/test preservation, and publication consent remain unchanged.
Polling, cleanup, cancellation, review, and publication retain existing semantics.

`/billing` displays checked state, not caller-supplied `success` or `session_id`
claims. Its authenticated same-origin portal POST returns a private checked
**Continue to Stripe** link in the new tab, retaining the original OAuth CSP.
Native no-referrer forms with `Origin:null` require same-origin Fetch Metadata.
The portal session is bound to the stored owner customer and explicitly uses the
selected portal configuration, rather than relying on an account-wide default.

## Secure deployment setup

1. Restore access to the existing REPOT Vercel project. Verify its team, connected
   `shlbi/graft` repository, production branch, and actual database before mutation.
   Do not create a replacement project or repoint the domain to bypass access.
2. Keep `REPOT_BILLING_ENABLED=false` during setup. Set or verify server-only
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in secure deployment settings.
   Do not paste credentials in chat, source, logs, or documentation. Connecting
   Stripe MCP does not supply a deployable runtime API key. The webhook signing
   secret belongs to the staged endpoint; obtain/install it through secure Stripe
   and Vercel configuration. Its value is deliberately absent from this repository.
3. Choose and disclose `REPOT_DAILY_DRAFT_LIMIT` explicitly (1–1000 model attempts
   per UTC day). Every repair is another attempt. The synthetic allowance used by
   tests is not a business decision or a production setting. No unlimited funded
   usage is promised.
4. The verified live IDs are defaults in `remote/billing-plan.mjs`. Overrides are
   `STRIPE_PAYMENT_LINK_ID`, `STRIPE_PRICE_ID`, `STRIPE_PORTAL_CONFIGURATION_ID`,
   and `STRIPE_WEBHOOK_ENDPOINT_ID`. Invalid explicit values fail closed. IDs are
   not secrets and never enable billing by themselves.
5. Apply `node scripts/migrate-billing.mjs --execute` to the **verified intended
   database**. This additive migration requires the existing Better Auth user and
   draft schema. Neither builds nor HTTP requests run migrations automatically.
6. Authorize a Stripe sandbox/test account and use a separate test deployment and
   database. Supply its test key, endpoint secret, explicit test IDs and
   `STRIPE_TEST_PAYMENT_LINK=https://buy.stripe.com/test_...`. Test credentials do
   not inherit any live resource IDs. Keep actual customer data out of the tests.
7. Install the receiver signing secret before enabling that environment's webhook.
   Exercise real test-mode checkout, owner binding, delayed payment, forged events,
   replay, renewal, cancellation, portal, and paid/unpaid submission checks. Do not
   use a live payment as a substitute for sandbox acceptance.
8. Review the allowance, tax display, refund/support experience, and unresolved
   account-deletion/duplicate-purchase cases. Enable the live webhook and billing
   flag only after configuration, migration, and test-mode acceptance are complete.

The runtime API key needs reads for Payment Links/line items, Checkout Sessions,
subscriptions and expanded invoices/prices, plus creation of portal sessions.
The optional operator checker also needs read access to portal configurations and
webhook endpoints. Grant only the permissions used; no refunds, charges, payouts,
customer edits, or key-management permissions are needed by this implementation.

## Read-only setup checker

```sh
node scripts/check-billing-setup.mjs --check
```

The checker uses four bounded Stripe GETs, fixed provider origins and safe boolean
output. It checks the link/price, dedicated portal, and webhook ID/URL/version/event
list/status without creating a checkout, changing the flag, or running a migration.
Missing configuration or a disabled webhook returns exit 1; unexpected arguments
return exit 2. It deliberately does not print keys, signing secrets, provider
bodies, or raw errors. Use this only in a securely configured operator environment.

A configuration `passed` is **not** payment acceptance. The report keeps database,
checkout, signature delivery, renewal, and cancellation `not_run`, and live
activation `not_performed`. A syntactically valid signing secret does not prove
that the deployed receiver has the matching secret; actual signed delivery must
be tested separately.

## Boundaries and support cases

The bare reusable link cannot identify a REPOT account. Unknown references need
support reconciliation, not email matching or another payment. Concurrent reusable
link purchases can still create duplicates; multiple customer IDs for one REPOT
owner need support rather than guessing which customer portal to open.

Account deletion cascades local billing rows but does **not** cancel Stripe's
subscription. Cancel/reconcile billing before deleting an account. Refunds and
disputes do not necessarily cancel a subscription either. Automatic refund/dispute
revocation and deletion-driven subscription cancellation remain unimplemented.

This paywall covers the hosted remote draft service, not separately self-hosted
legacy deployments. Do not market the old web simulator as a paid production
workflow. No ChatGPT-token fallback to REPOT-funded AI exists.

## Verification history

PR #4's recorded run `37704552037`, at
`6ead5e37a58ccd082fc42de40e1a45765a2808d0`, passed 42 billing/database/wiring,
142 draft/repair and 161 authentication tests, and the Next production build.
Stripe API behavior was doubled; PostgreSQL was a real disposable database.

The legacy frontend produced **23 passes and 7 failures** on both the untouched
baseline and billing branch. Exact inputs, counts and failure names matched.
Those failures remain explicit, not a frontend pass. The first billing run also
exposed a CSP expansion; the implementation restored the original policy without
weakening the auth test. Details remain in `docs/verification/stripe-billing.json`.

The October 8 connected-account setup adds 25 locally passing configuration/CLI
checks on Node 22.16.0. Those tests use synthetic keys and explicit API doubles;
real account verification and mutations are separately recorded in
`docs/verification/stripe-account-setup.json`. Check that record for hosted CI
results; do not infer runtime payment acceptance from configuration or test mocks.
The latest continuation point remains `.nightshift/BILLING-HANDOFF.json`.

Primary references:
- https://docs.stripe.com/payment-links/url-parameters
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/payments/managed-payments/use-payment-links
- https://docs.stripe.com/customer-management/integrate-customer-portal
- https://docs.stripe.com/keys
