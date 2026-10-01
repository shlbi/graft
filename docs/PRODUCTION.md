# Repot production runbook

Repot's production MCP resource is **https://mcp.getrepot.com/mcp**. The main site and OAuth authorization server run on **https://getrepot.com**.

## Architecture

- **Vercel / Next.js 16** — website, OAuth routes, and stateless remote MCP.
- **Better Auth 1.7** — GitHub sign-in, OAuth 2.1, PKCE, JWT access/refresh tokens, RFC 9728 discovery, CIMD and DCR fallback.
- **PostgreSQL** — durable auth/OAuth records, encrypted Repot reviews, usage counters.
- **GitHub App user access token** — upstream GitHub delegation. MCP bearer tokens are never forwarded to GitHub.
- **OpenAI Responses API / GPT-6.1 Sol** — server-side draft generation uses the pinned `gpt-6.1-sol` model at medium reasoning, only after the tool receives explicit `allowAI=true`.
- **Repot engine** — bounded snapshots, deterministic test-transfer postprocessor, patch validation, stale-revision checks.
- **GitHub Git Data API** — one commit on a new repot/* branch followed by a draft PR. No default-branch write or merge endpoint is used.

## Required Vercel environment variables

Set these for Production and Preview as appropriate. Never prefix secrets with NEXT_PUBLIC_.

    BETTER_AUTH_URL=https://getrepot.com
    REPOT_MCP_RESOURCE=https://mcp.getrepot.com/mcp
    DATABASE_URL=...
    BETTER_AUTH_SECRET=...
    GITHUB_CLIENT_ID=...
    GITHUB_CLIENT_SECRET=...
    OPENAI_API_KEY=...  # Repot pins gpt-6.1-sol in code
    REPOT_DATA_KEY=...

Generate BETTER_AUTH_SECRET with at least 32 high-entropy bytes. Generate REPOT_DATA_KEY as exactly 32 random bytes encoded as base64.

Optional limits: REPOT_DAILY_DRAFT_LIMIT, REPOT_DAILY_PUBLISH_LIMIT, REPOT_REVIEW_TTL_MINUTES.

## GitHub App settings

Keep: Contents read/write, Pull requests read/write, Metadata read-only.

The OAuth callback remains **https://getrepot.com/auth/callback**; the production code rewrites that compatibility route into Better Auth's GitHub callback handler. Keep the webhook secret/private key safe even though this remote MCP path does not currently require them.

Install the GitHub App only on repositories a user wants Repot to access.

## Database

Provision PostgreSQL, set DATABASE_URL, then run from a trusted operator environment with the same production environment:

    npm ci
    npm run migrate

auth:migrate creates/updates Better Auth + OAuth/CIMD tables. db:migrate creates Repot's encrypted review and usage tables. Do not mutate schema automatically on serverless cold starts.

## Domains

Attach both domains to the same Vercel project:
- getrepot.com
- mcp.getrepot.com

The main-domain GET /mcp is documentation. The MCP subdomain GET /mcp returns 405; MCP traffic uses authenticated POST.

## Release acceptance

Before calling the service live, verify:
1. https://mcp.getrepot.com/.well-known/oauth-protected-resource returns RFC 9728 metadata.
2. Unauthenticated POST https://mcp.getrepot.com/mcp returns 401 with a Bearer challenge.
3. A real MCP client completes GitHub login + consent and lists tools.
4. repot_repositories returns only GitHub App-accessible repositories.
5. repot_inspect is read-only.
6. repot_draft stores an encrypted review and does not change GitHub.
7. repot_publish creates one new repot/* branch and one draft PR.
8. Changing the destination default branch after draft causes publish to refuse.
9. A second publish of an already-published review returns the existing PR.
10. Revoke GitHub authorization and confirm upstream repository access stops.
11. Verify database backups/retention and Vercel logs contain no repository file bodies, GitHub tokens, OAuth tokens, or OpenAI keys.

## Explicit boundary

The MCP service does **not** execute generated repository code. Build/tests/integration are reported as not_run. A future isolated verifier must be separately acceptance-tested before those statuses can become verified.
