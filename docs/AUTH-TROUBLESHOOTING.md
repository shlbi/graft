# Browser GitHub sign-in: failure visibility and confirmation

GitHub displaying its authorization screen is not evidence that Repot created a
user or session. The callback can still fail while exchanging the code, reading
the GitHub identity, validating state, linking the account, or creating a session.

## What the browser now does

`/sign-in` reads the current session through Better Auth. An existing valid session
can continue to the requested same-origin destination; otherwise the user sees the
sign-in form. A callback error is displayed even if an older session still exists.

The form starts OAuth through `POST /auth/github`. The default success destination
is `/connected` for both new and returning users. An explicitly supplied safe local
`next` path is preserved. `errorCallbackURL` is `/sign-in` without a prefilled error
parameter, letting Better Auth provide the actual failure code.

`/connected` verifies the session again before displaying a success message. Query
parameters such as `success=true` cannot establish authentication. This page confirms
only a browser session: it does not claim an MCP client token, repository access,
or a successful code transfer.

The existing `/auth/callback` adapter is unchanged. Better Auth still owns the code
exchange, state/PKCE checks, user creation and session cookie. No validation has been
disabled and no users/sessions are created by the presentation helpers.

## GitHub identity without email

Repot reads the numeric GitHub subject and handle from authenticated `GET /user`.
It does not request `user:email`, call `/user/emails`, or store a public email that
GitHub happens to include. Better Auth's required email-shaped field contains an
unverified, non-deliverable `.invalid` ID; it is not the user's address. Email login,
mail sending, email changes and account merging are disabled. See
[GITHUB-IDENTITY.md](GITHUB-IDENTITY.md) for invariants and compatibility notes.

## Read the code, not private callback data

The error panel uses a fixed allowlist. Unknown codes display `auth_failed`; raw
provider `error_description`, OAuth codes/state, cookies and URLs are never echoed.
Older attempts containing both `error=github` and a real error code are supported.
If session storage itself is unavailable, the page returns a generic HTTP 503 rather
than a success message or raw database exception.

| Error | Next diagnostic |
| --- | --- |
| `email_not_found`, `email_not_verified` | Repot no longer needs the user's email. Check that the no-email GitHub identity adapter is deployed, then begin a fresh attempt. Do not grant email access or ask the user to publish/verify an email to resolve this flow. |
| `unable_to_get_user_info` | Check the GitHub App's profile/account permissions and provider availability. This is not proof of a particular missing permission. |
| `state_not_found`, `state_mismatch`, `state_invalid` | Begin a fresh attempt in the same browser; do not reuse old authorization URLs. Check cookie persistence and canonical host configuration. |
| `invalid_code` | Start a fresh attempt. If repeated, check the actual GitHub App client credentials and callback URL in the secret-management interface. Never paste them into issues/chat. |
| `unable_to_create_user`, `unable_to_create_session` | Inspect server-side authentication storage, required schema and non-secret error codes. Do not reset keys or change schemas speculatively. |
| `session_missing` | The destination page could not verify a current browser session. Check callback success and cookies; this is not a successful login. |
| `auth_unavailable` | The server could not check the session; inspect availability/configuration without exposing exception bodies. |

Report only the displayed error code. Do not include the full callback URL, OAuth
state/code, token, cookie, key or database connection string in screenshots or issues.

## Tests and remaining acceptance

Run `npm run test:auth`. The route/helper tests execute the real route bodies with
synthetic Better Auth responses. They cover cookie forwarding, error mapping,
redirect confinement, session-checked confirmation and retention of the callback
adapter. They do **not** substitute for a real GitHub authorization round trip.

A successful end-to-end check must observe a real callback, session creation, an
HttpOnly browser cookie and the authenticated confirmation/continuation. MCP client
authorization and repository-transfer acceptance are separate checks.

Primary references (consulted September 30, 2026):
- https://better-auth.com/docs/authentication/github
- https://better-auth.com/docs/basic-usage
- https://better-auth.com/docs/reference/errors
- https://better-auth.com/docs/reference/errors/unable_to_get_user_info
