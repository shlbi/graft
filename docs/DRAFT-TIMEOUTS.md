# Foreground MCP draft time budgets

## Why the reported transfer failed

At base commit `4f4ef4baabe4c553268b85e500920340ec7cc9af`, the MCP
route exported `maxDuration=60` but its AI adapter allowed 90 seconds.
Repository reads and review persistence also happened inside that same request.
The reported failures at about 61 seconds are consistent with Vercel terminating
that route before the AI adapter could finish or return its own timeout. This
code inspection is not a substitute for a production invocation log.

## Fixed budget hierarchy

| Boundary | Budget |
| --- | --- |
| Vercel `app/mcp/route.js` | 300 seconds |
| Foreground draft stages combined | 240 seconds |
| Hosted MCP AI request, including response body | 180 seconds |
| Legacy/local AI adapter default | 90 seconds, unchanged |
| Each GitHub HTTP operation | 30 seconds, unchanged |

The Next.js duration is a static literal so Vercel can discover it. **Hobby needs
Fluid compute enabled to permit 300 seconds**; legacy non-Fluid Hobby remains
limited to 60 seconds. No plan, account setting, deployment or paid resource is
changed by this patch. Vercel deploys automatically from the GitHub push.

Each stage races a request-scoped deadline. Both the SDK's `ctx.mcpReq.signal`
and the HTTP request signal stop further stages and propagate into AI/GitHub
network requests. Archive reads use Node's awaited `pipeline` so corrupt gzip,
stream errors and cancellation reject rather than hanging on an unhandled error.

Only clients requesting progress receive status updates, at stage changes and
at most once per 15 seconds while work is pending. Progress values count updates;
they are not percentages, generated tokens, verification results or promises.
Notification failure cannot restart or fail the draft. Timers/listeners are
released after success, error or cancellation. Actual display and client timeout
reset behavior depend on the client; a host duration increase cannot override a
client's independent hard timeout.

## Safety and failure results

The model remains `gpt-6.1-sol`, medium reasoning, 12,000 output-token cap,
strict structured output, `store:false`, and no model tools or code execution.
There are no automatic provider retries and no OpenAI background-mode requests.
This is still a foreground operation, **not a durable resumable job system**.
A disconnected caller is not promised later completion or a recoverable job ID.

A draft failure has `isError:true`, a fixed error code/stage and
`retryAutomatically:false`. Raw provider/database exceptions and caller abort
reasons are not reflected. No GitHub write is performed by drafting. AI output
must complete the existing deterministic review/test-transfer processing before
an encrypted review is saved and a review ID is returned. An already-started
DB statement cannot be rolled back by AbortSignal: a save may complete after a
timeout/disconnect, but no draft success or PR is claimed in that case.

Consent, credentials and identical-repo rejection happen before quota use.
Read/analysis failures no longer spend a draft attempt. Requests that actually
start AI still consume one attempt even if generation fails: provider costs may
already have occurred. Expired-review cleanup remains bounded by the draft scope.
Existing review/publish tools, OAuth, repository permissions, keys, database schema
and destination-branch protections are not changed.

## Reproduce the targeted checks

```sh
npm run test:timeouts
```

The tests execute real module and handler bodies with synthetic SDK/auth/database/
provider boundaries. Virtual time covers 61.2-, 95- and 150-second AI responses,
180-second AI cutoff, 240-second request cutoff, caller cancellation, progress,
no retries/saves on failure, late completions, fixed model/privacy parameters and
secret-safe errors. Separate native Node stream/gzip checks use a synthetic tar
sink; they do not claim full tar parser acceptance.

Full Next.js build, installed SDK integration, live ChatGPT transport and a paid
Pomodoro transfer remain separate acceptance checks. See the evidence JSON for
exact observed results. After deployment, retry the original transfer once; do
not publish unless a successful, exportable review is returned and reviewed.
If a fresh request still fails at approximately 60 seconds, inspect the effective
function limit/Fluid compute configuration and any separate client deadline.

## Primary references

- https://vercel.com/docs/functions/configuring-functions/duration
- https://vercel.com/docs/functions/limitations
- https://ts.sdk.modelcontextprotocol.io/v2/servers/logging-progress-cancellation
- https://ts.sdk.modelcontextprotocol.io/v2/api/@modelcontextprotocol/server/server/createMcpHandler.html
