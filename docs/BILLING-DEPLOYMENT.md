# Billing deployment continuation — October 8, 2026

This is the current operator status after Vercel access was restored. It supersedes
only the obsolete deployment-access and migration status in `BILLING.md`. The
existing billing flow, safety boundaries, support cases and verification history
in that document still apply.

## Completed

The existing `repot` Vercel project was resolved and matched to `shlbi/graft`, its
production commit, `getrepot.com` and `mcp.getrepot.com`. No replacement project,
new domain, or protection-policy change was made.

Five non-secret Production variables were created and independently read back:

| Variable | Value |
|---|---|
| `REPOT_BILLING_ENABLED` | `false` |
| `STRIPE_PAYMENT_LINK_ID` | `plink_1UO45L6SP0lvEsfmU0B4F8ng` |
| `STRIPE_PRICE_ID` | `price_1UO43R6SP0lvEsfm4EilHFlL` |
| `STRIPE_PORTAL_CONFIGURATION_ID` | `bpc_1UOLsP6SP0lvEsfmIH2Vvu9I` |
| `STRIPE_WEBHOOK_ENDPOINT_ID` | `we_1UOLu56SP0lvEsfmZzowySad` |

The existing `docs/migrations/002-billing.sql` table/index definitions were applied
in one transaction to the identified Neon production branch. The transaction had
bounded lock/statement timeouts and checked the existing auth-user and draft-job
schema first. A separate catalog query verified both billing tables, primary keys,
reference-format check, unique checkout-session constraint, user foreign keys,
not-null constraints and owner indexes. No customer rows were queried or changed,
and no existing table was dropped or altered. This was a direct Neon transaction,
not an invocation of the migration CLI. Application-side connectivity is not
established by this catalog check; the Vercel database credential was not decrypted.

## Credentials still require direct secure entry

Project environment metadata shows neither `STRIPE_SECRET_KEY` nor
`STRIPE_WEBHOOK_SECRET`. The attempted credential write was blocked by the tool
safety check and was not retried through another transport. The successful
non-secret write omitted the credential entirely. Existing production secrets
were neither decrypted nor changed.

In the existing Vercel project, open **Settings > Environment Variables**, select
**Production**, and store the following as secret/sensitive values:

| Name | Secure source |
|---|---|
| `STRIPE_SECRET_KEY` | A dedicated, least-privilege live restricted API key from the Getrepot account's Stripe API-keys settings. |
| `STRIPE_WEBHOOK_SECRET` | The current signing secret for the existing endpoint `we_1UOLu56SP0lvEsfmZzowySad`, from that endpoint's Stripe settings. |

Do not paste either value in chat, documentation, source, browser code, or logs.
A publishable Stripe key is not a substitute for the server API key. The endpoint
signing secret is separate from the API key. Preserve the existing endpoint;
creating a duplicate does not solve missing receiver configuration.

The runtime key requires Payment Link/line-item, Checkout Session, subscription,
price and invoice reads plus permission to create Billing Portal sessions. The
read-only setup checker additionally reads portal configurations and webhook
endpoints. It does not need refunds, payouts or payment-creation permission.

## Activation is still intentionally off

The Stripe endpoint remains disabled. No real payment, test checkout or AI transfer
was initiated. `REPOT_DAILY_DRAFT_LIMIT` is not installed and a business allowance
has not been selected. The synthetic allowance in tests is not a launch decision.
Only the live Stripe account is available through the current connection, so a
separate Stripe sandbox must be authorized for end-to-end tests.

After secure configuration, test the isolated sandbox flow for checkout, signed
webhook delivery, ownership binding, replay, delayed payment, renewal, cancellation,
portal access and allowed/denied AI submissions. Verify the deployed application's
database connection and the included allowance before enabling the live endpoint
and billing flag. An environment change or successful build is not payment
acceptance. The ChatGPT-funded provider remains separate unfinished work.

The Vercel page-fetch helper returned 403 while accessing deployment aliases; this
is not an application HTTP result. No public checkout smoke-test pass is claimed.
Do not weaken deployment protection to turn that missing check into a pass.

## Evidence and continuation

`verification/billing-deployment-setup.json` records observed configuration and
catalog outcomes without credentials. `.nightshift/BILLING-HANDOFF.json` points
here. This repository change is documentation only: application code, migrations
and workflows are unchanged. Earlier CI results remain historical, not a new test
run. Inspect the new Git commit's deployment separately after pushing.

Official operational references:

- https://docs.stripe.com/keys
- https://docs.stripe.com/webhooks
- https://vercel.com/docs/environment-variables/sensitive-environment-variables
