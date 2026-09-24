# Graft connected beta

A separate, invite-only service implementing **GitHub App sign-in -> repository selection -> persistent draft -> human review -> draft PR**. The local preview and existing transfer engine remain intact. This is production-directed implementation, **not a completed public production release**.

## What is wired together

The service uses GitHub App **user access tokens**, not a shared personal token or an installation-wide service identity. GitHub enforces the intersection of the user's and App's access. Repository selection comes from installations accessible to that user; IDs and destination write permission are revalidated for intake and publication. Authenticated snapshots pin commits and verify blob hashes. The connected path can inspect up to 160 eligible text files per repository, 750 KB total and 60 KB per file. Larger or incomplete inputs stop with an explicit limit rather than pretending the repository was fully inspected.

`service.mjs` calls the existing `lib/core.mjs` analysis/test-transfer implementation and `lib/ai.mjs` provider. It does not replace those with a second engine. The API never accepts a client-authored patch. Reviews and snapshots live server-side; the browser confirms an exact review digest. Related tests continue through the existing transfer safety gate.

Paid drafting requires both an operator-configured model/key and per-request user consent. Requests consume a durable per-user/global daily allowance before starting; cancellation/failure does not reset it. Defaults are 3/user and 20/global per UTC day. The existing provider makes one bounded call with no automatic retry. **These are request/token limits, not a dollar budget.** Configure the provider account's spending controls before enabling it.

## Authentication and storage

OAuth uses an expiring, single-use, browser-bound state and S256 PKCE. Sessions rotate after authentication, have an eight-hour maximum (or earlier token expiry), use Secure/HttpOnly/host-only/SameSite cookies with HTTPS, and require exact Origin plus CSRF token on mutations. Expiring GitHub App tokens are mandatory. Refresh tokens are discarded; the user signs in again at expiry. Signed authorization-revocation webhooks invalidate sessions. Installation access changes conservatively invalidate all sessions.

A private SQLite file stores encrypted session tokens and encrypted job/review/source bodies with AES-256-GCM and record-bound associated data. Session IDs are stored as SHA-256 digests. The data key must stay outside the database and repository. There are no source-bearing request logs. Drafts expire after 24 hours; expired records are purged on requests and every minute in the CLI service. Account deletion removes the user's drafts/sessions, not GitHub work or provider records. Minimal daily quota counters persist for up to two UTC calendar days so deletion cannot reset the AI budget. Backups, provider retention, and GitHub retention are separate operator responsibilities.

SQLite runs in **one Node process, one replica, one private persistent volume**. This implementation is not a distributed queue or a horizontally scalable service. Do not share its database across multiple service processes. The Node 22.16 runtime used in validation marks `node:sqlite` experimental; choose and validate a supported production runtime before deployment.

Jobs survive page reloads. A server restart marks in-flight drafts interrupted rather than charging another AI call. Publication is marked uncertain on interruption. A retry reconciles the same branch and existing PR. Publication intent is persisted before branch creation. Cancellation aborts draft work; publication cannot promise to undo an already-created remote branch. No generic uploaded-code executor exists in this service.

## GitHub writes

Writes are **off by default**. Enabling them requires `GRAFT_ENABLE_PR_WRITES=true`. Users must acknowledge both that the project checks have not run and that existing GitHub workflows may execute and consume their allowance. Publication creates only `graft/<opaque-job-id>` branches and **draft** PRs. No auto-merge, default-branch update, force push, deletion, or workflow-file edits are implemented.

The destination head is checked against the analyzed commit before tree creation and again before branch publication. The tree preserves the original base and existing file modes. Stale baselines, changed delivery branches and collisions are rejected. Lost-response retries reconcile existing remote state; they do not blindly repeat PR creation. A race after a head check remains possible, which is another reason the output is a draft PR requiring review, not a verified automatic integration.

The App needs Contents: read/write and Pull requests: read/write for destination delivery; Metadata is read-only. Do not grant Administration, Secrets or Workflows permission. One App's installation permissions apply across its selected repositories, so it is **not technically read-only on the source**; the application never uses its write path for the source. Separate source/read and destination/write Apps would be required for that stronger permission boundary.

## Operator setup (no deployment performed)

Register a GitHub App and install it on authorized repositories. Set its user authorization callback to `<GRAFT_PUBLIC_URL>/auth/callback` and webhook endpoint to `<GRAFT_PUBLIC_URL>/webhooks/github`. Enable expiring user tokens. Keep client and webhook secrets in the host's secret manager, not chat or source control. Leave automatic user authorization during installation off so sign-in starts from Graft's state/PKCE flow.

From the repository root:

```sh
npm install --ignore-scripts
# Populate web/connected/.env from .env.example using your local secret manager.
node --env-file=web/connected/.env web/connected/server.mjs
```

The blank example is intentionally not runnable until real App configuration and invited numeric user IDs are supplied. No GitHub App was registered and no real OAuth credentials were used during this build. A 32-byte key can be generated locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`; never commit the output.

For an eventual HTTPS staging host, set `GRAFT_ENV=staging`, an explicit HTTPS `GRAFT_PUBLIC_URL`, the allowed user IDs, a private persistent database volume and externally injected secrets. Put TLS and traffic controls at the gateway. Preserve the canonical Host header. The service does not trust X-Forwarded-* headers for identity or origin. Keep a single replica, disable proxy logs of OAuth query strings, configure backups/deletion, and leave PR writes and AI disabled until separately authorized live tests succeed. Do not expose the old `web/server.mjs` as the production server.

## Validation in this session

```sh
npm run test:connected
# Equivalent:
node --test --test-timeout=15000 web/connected/test/*.test.mjs
```

**36/36 tests passed, zero failures/skips**, on Node 22.16.0/Linux. Includes real local HTTP requests, encrypted file-backed SQLite reopening, the actual controller with DOM doubles, OAuth state/PKCE/session tests, CSRF/owner isolation, cancellation, quotas, signed revocation, Git blob integrity, stale heads, lost branch/PR responses, concurrent publish attempts and preservation of externally edited branches.

GitHub HTTP responses and the AI draft boundary are explicitly controlled test doubles. Tests use the unchanged `core-base.mjs` snapshot/patch primitives (blob `c8686ed0967eb1755e659ee85602ffe50d58603a`). They do **not** establish a live GitHub OAuth/PR result or live AI quality. The default engine/provider imports were checked against the remote source interfaces; the complete latest parser/transfer suite was not rerun here. No new Jest/Vitest, browser, Windows, CI, deployment or arbitrary-user-project execution pass is claimed. Chromium launch was attempted; the required browser executable is absent in this runtime. Public clone failed DNS; no credentials or network controls were bypassed.

## Public launch gates still open

- Complete an actual GitHub App sign-in and branch/PR round trip on an authorized test pair, including revoked access and conflict handling.
- Run the complete engine suite plus real browser/mobile journeys and measure a meaningful real-world AI transfer with an explicit model/spending budget.
- Add an isolated user-project verifier before displaying any build/test success for a user's draft. Never run repository or model code inside this API process. A PR may trigger the repository's own Actions only after the explicit publication acknowledgement.
- Validate deployment runtime, TLS/proxy configuration, secrets rotation, backup/deletion recovery, monitoring and load/abuse limits. Obtain an independent security review before admitting strangers.

No public deployment, paid API usage, CI run, permission changes or background schedule was performed.

## Primary references consulted

- GitHub App user tokens, permission intersection and PKCE: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
- User-accessible installation repositories: https://docs.github.com/en/rest/apps/installations
- SQLite API used in local validation: https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html

Consulted September 24, 2026. Runtime claims above are limited to the observed tests, not the documentation alone.
