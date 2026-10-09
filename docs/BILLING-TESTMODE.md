# Stripe test-mode checkpoint

Observed 2026-10-09 UTC (October 8 evening, America/New_York).
This supersedes the old claims that Stripe test mode is inaccessible and the two
Production credential variables are absent. It does not activate billing.

## Authorization and deployment

The Getrepot connection now exposes `livemode:false`. This is verified test-mode
access on the existing account, not proof that a separate Stripe Sandbox account
was provisioned. No additional authorization loop is required for these API calls.
Vercel metadata confirms `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` exist as
Sensitive, Production-only variables. Their values were not read, copied, or
validated by this check. `REPOT_BILLING_ENABLED` remains `false` and
`REPOT_DAILY_DRAFT_LIMIT` remains absent. Production settings were not changed.

## Actual Stripe API tests

All payment operations used synthetic customers, official test payment-method
shortcuts and `livemode:false`. No real money moved and no customer PII was entered.
The isolated fixture uses one licensed USD1500/month price, flexible billing, no
trial, and no tax/Managed Payments. Live tax/Managed Payments settings are untouched.

| Operation | Observed Stripe result |
| --- | --- |
| Initial successful payment | Active subscription; invoice paid, amount paid 1500 |
| Initial deliberately failing payment | Incomplete subscription; invoice open, amount paid 0 |
| Schedule cancellation at period end | Still active; paid invoice retained; cancel_at set to period end |
| Immediate cancellation of paid fixture | Canceled; old paid invoice still present |
| Cleanup of incomplete fixture | Incomplete_expired |

Both test subscriptions were terminated. Tagged synthetic customers, the product
and price, and the expiring test clock remain available for inspection. The clock
was never advanced; the immediate cancellation is not a natural-expiry test.

`verification/stripe-testmode-snapshots.json` preserves compact selected fields
from the actual responses. It is not a raw response copy. Hosted invoice URLs,
credentials, and personal data are omitted. The connector's operation schema
version and the app's pinned request version are different and explicitly recorded;
this does not establish identical-version provider transport acceptance.

## Production-code regression replay

`remote/test/billing-observed.test.mjs` replays the observed states through the
unchanged entitlement function and submission gate. Expected access is true for
the paid and scheduled-cancel states, and false for unpaid/terminated states.
Owner/subscription/mode/price isolation and exact expiry boundaries are checked.
The test clock value, owner bindings and API responses are injected harness inputs:
these replays are not fresh Stripe calls, actual database attribution or hosted
HTTP requests. The fixture allowance of one is not a launch pricing decision.

```sh
node --test remote/test/billing-observed.test.mjs
```

The existing billing CI automatically includes this file. Job `113634944487` in
run `37872960403` passed at `4bdae16020fd913761eaefe9c7f8956249cd3f19`.
It executed 85 billing/setup/database/wiring checks (including all 18 new observed
replays), 142 draft/repair checks and 161 authentication checks, with zero failures
or skips in those groups. The Next production build passed with billing disabled.
The legacy frontend still has the same 23 passes and 7 pinned-baseline failures;
that comparison is not a full frontend pass. Runtime was Node24.21.0,
PostgreSQL16.15 and Next16.3.6 on Ubuntu24.04.5. Stripe calls in CI remain doubles;
only the separately described synthetic connector calls are actual Stripe tests.

## Remaining release work

The full isolated application test still needs secure test-mode runtime credentials,
a test signing endpoint, an isolated database, and the normal authenticated browser
flow. Do not overwrite Production secrets with test credentials or disable deployment
protection. Validate hosted Payment Link checkout, real signed delivery, account
binding/replay, delayed payment, recovery, renewal and portal cancellation. Verify
Production read permissions and matching signed delivery separately before activation.

A business allowance remains to be chosen and disclosed for the $15 paid tier.
The current release flag and live webhook stay disabled. ChatGPT-funded execution
is still unimplemented, and the previously documented duplicate-purchase,
refund/dispute and account-deletion support boundaries remain.
