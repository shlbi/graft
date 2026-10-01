# GitHub identity without collecting email

Repot authenticates the GitHub account, not an email address. The provider ID
`github` plus GitHub's immutable numeric account ID remain the account binding.
The handle is display data and may change. Repository permissions remain those
of the user's GitHub App token; this change does not widen access to repositories.

## Implementation

`remote/github-identity.mjs` is registered as the built-in GitHub provider's
supported `getUserInfo` hook in `remote/auth.mjs`. It runs after Better Auth's
normal state/PKCE verification and authorization-code exchange. It makes one
bounded, authenticated request to `https://api.github.com/user`; there is no
`/user/emails` request, no token in a URL, and no request-controlled endpoint.

The response must identify a GitHub `User` with a canonical numeric ID and valid
handle. Invalid/missing IDs, organization/bot profiles, HTTP errors, redirects,
malformed JSON/UTF-8, oversized bodies and network failures return no identity.
There is no fallback guest account or unconditional session creation. Only a
sanitized `{ id, login }` profile is returned to the library. Public email and
other incidental profile fields are discarded, not copied into user records.

The provider has `disableDefaultScope: true` and an empty scope list. GitHub App
permissions, rather than OAuth App scope strings, govern upstream access.
Users do not need to expose their email or grant Email addresses permission.
Already-granted App permissions are not changed by this source-code update.

## Why an internal email-shaped ID still exists

Better Auth **1.7.6** requires a unique, nonempty `user.email` field even for
GitHub-only sign-in. Making the database column nullable alone would not fix the
library's callback validation. Repot therefore uses its documented no-email
provider pattern with an internal alias:

```
github-<numeric-github-id>@users.repot.invalid
```

This is NOT a user's email, GitHub noreply address, deliverable mailbox, or claim
of email verification. `emailVerified` is always `false`. Do not display or export
it as contact information. Do not change this namespace without an identity
migration plan. The adapter derives it only from GitHub's authenticated ID, never
from a browser-supplied ID, handle, email, or unverified profile.

Email/password login, email changes, mail delivery hooks and automatic/explicit
account linking are disabled. A collision must fail rather than merge accounts.
No `email` scope is added to Repot's MCP scopes. Future email login or additional
identity providers require a deliberate redesign of these invariants.

Returning users are resolved by the same GitHub account key. The supported
`overrideUserInfoOnSignIn` option refreshes the handle and internal alias on a
successful login; it does not replace the GitHub subject. No bulk user edits,
credential changes, schema migration, or key rotation are part of this change.
The redirect bridge, session checks, GitHub token exchange, and PKCE/state checks
are unchanged.

## Validation and release boundary

Run `npm run test:auth`. It includes the existing handler/session/redirect suite
and the no-email adapter/configuration tests. Test doubles supply GitHub HTTP
responses and external Better Auth modules; no production secrets are loaded.
Tests cover absent/private/public email, mutable handles, distinct subjects,
invalid profiles, byte limits, response errors, callback-cookie preservation,
configuration wiring and disabled email-based identity paths.

See `docs/verification/github-identity-no-email.json` for observed results and
unexecuted checks. A successful build or these tests is not proof of live login.
After deployment, begin a NEW attempt at `/sign-in`, authorize GitHub, and verify
that `/connected` confirms a real browser session. Do not reuse an old callback
URL. MCP-client authorization and repository-transfer testing are still separate.

## Primary sources inspected

- Better Auth no-email provider guidance:
  https://better-auth.com/docs/concepts/oauth#handling-providers-without-email
- Exact provider hook and account subject, v1.7.6:
  https://github.com/better-auth/better-auth/blob/v1.7.6/packages/core/src/social-providers/github.ts
- Callback still requires a nonempty email-shaped field, v1.7.6:
  https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/api/routes/callback.ts
- Account recognition/linking rules, v1.7.6:
  https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/oauth2/link-account.ts
- GitHub authenticated-user identity and GitHub App permissions:
  https://docs.github.com/en/rest/users/users#get-the-authenticated-user
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
