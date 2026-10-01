# MCP authorization: preserve the signed request, then return to the client

A verified GitHub browser session is not an MCP connection. The MCP client still
needs its original authorization request completed, including consent, the exact
registered callback, state correlation and a successful token exchange.

## What was broken

The custom sign-in and consent forms discarded Better Auth's signed query.
Social sign-in therefore ended at `/connected` without resuming the MCP request.
The consent POST sent only `accept`; Better Auth returned `missing oauth query`.
Its successful consent result would also have been returned as JSON instead of
navigating back to the client. These were application integration bugs, not a
reason to reset GitHub credentials, request email access or skip consent.

## Data flow

1. Better Auth validates the client's authorization request and redirects to
   `/sign-in` or `/consent` with a signed query.
2. `remote/oauth-flow.mjs` selects the signed fields and checks their signature
   and expiration before rendering a form. Each form carries its own escaped
   `oauth_query` hidden field; no global variable or last-client cookie is used.
3. GitHub sign-in forwards `oauth_query` in `signInSocial`'s body. Better Auth's
   provider hook verifies it again, retains it in server-only OAuth state, and
   resumes authorization after the GitHub callback. Ordinary browser logins
   without an MCP request still use `/connected`.
4. Consent requires a verified browser session, shows the signed client ID,
   callback origin, scopes and any claims request, and preserves the query in
   both Authorize and Deny forms. GET never approves anything.
5. The decision route forwards `{ accept: boolean, oauth_query }` through
   `auth.api.oauth2Consent`. Better Auth remains responsible for registered
   clients, session checks, PKCE, scope policy and authorization-code issuance.
6. The browser submits a same-origin fetch and navigates top-level only to the
   server-checked result. Both approval and denial preserve client state. Without
   JavaScript, the ordinary form provides an explicit checked continuation link.

A callback URL is never accepted from an unrelated form field. The returned
origin/path, original callback query and state must match the signed request.
Same-origin intermediate login/consent pages require a fresh valid signed query.
HTTPS and HTTP loopback clients are supported; credentials, fragments and other
URL schemes are rejected. This does not claim every MCP client has been tested.

## Pinned-library compatibility

The deployed package is `@better-auth/oauth-provider@1.7.6`. Its public exports do
not include `verifyOAuthQueryParams`; importing that name caused a previous build
failure. Do not copy an import from newer documentation without checking exports.

The compatibility verifier follows the inspected v1.7.6 source: select `sig` and
fields listed by repeated `ba_param`; canonicalize lexically by key then value;
verify HMAC-SHA256 with Base64 padding using Better Auth's resolved secret; check
`exp` seconds and `ba_iat` milliseconds. Repeated `resource` values are retained.
It verifies existing signed requests only and never manufactures a signature.
Better Auth performs its own verification again before consent/sign-in handling.
Recheck this adapter and its tests before upgrading the pinned auth packages.

## Browser and request boundaries

The global CSP remains unchanged: self-hosted scripts only and narrow form-action
origins. `/oauth-consent.mjs` is explicitly included in the static asset allowlist.
A same-origin fetch followed by ordinary top-level navigation avoids depending on
cross-origin form-redirect behavior; arbitrary HTTPS form targets are not allowed.

Requests must be bounded URL-encoded forms from the configured origin. With the
existing no-referrer policy, a native form can send `Origin: null`; that is accepted
only when browser-controlled `Sec-Fetch-Site: same-origin` corroborates it. Missing
or foreign Origin and cross-site submissions fail. Duplicate decision/query fields,
missing/expired/modified signatures and unexpected result URLs also fail closed.
Provider response cookies remain separate. Errors use fixed messages, never raw
exceptions, request queries, tokens or database details. The returned authorization
code necessarily travels to the requesting client, but is never logged by this code.

## Tests and remaining live acceptance

Run `npm run test:oauth` for continuation and browser-controller tests, or
`npm run test:auth` for those plus the existing GitHub handler and identity suites.
The recorded run executed 117 tests: the existing 52 handler tests plus 65 new
continuation/controller tests, with synthetic Better Auth responses. Query
signatures in fixtures are made independently using WebCrypto and verified by
the real helper. Two targeted regressions fail against the previous route bytes.
See `verification/oauth-continuation.json` for exact commands and limits.

These tests do not assert that ChatGPT received a real access token. After the
Git-triggered deployment completes, close old consent tabs and start Connect
again from the MCP client. Complete GitHub login only if requested, then explicitly
Authorize. Confirm the client finishes its callback/token exchange and exposes
Repot tools. Test Deny as a separate fresh attempt. Repository transfer acceptance
remains a separate step; no code transfer or paid inference was run for this fix.

## Primary implementation references

- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/client.ts
- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/signed-query.ts
- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/utils/index.ts
- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/oauth.ts
- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/consent.ts
- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/oauth-provider/src/authorize.ts
- https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/crypto/index.ts
- https://better-auth.com/docs/plugins/oauth-provider
- https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
