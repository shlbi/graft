# Repot frontend / Obsidian + Bone

## Scope

The primary connected frontend, root package display name and root README now use **Repot**. Its source remains `web/connected/public/`; the existing server serves the same `/`, `/style.css` and `/app.mjs` routes. Legacy engine/preview documentation is preserved rather than rewritten as new evidence. The original root README is now `README-ENGINE.md`.

Only two pigment values are used: `#0D0D0F` and `#E7E1D8`. All secondary surfaces, strokes and text derive from opacity. No neon, gradient accents, external fonts, analytics, UI-library install, or imagery hotlinks are required.

## Implemented interaction

The landing page includes a custom inline wireframe SVG, reduced-motion-aware line/capsule animation, navigable method section, and three interactive anatomy views. These views are explicitly illustrative. The workspace has repository selection, a bounded feature input, code-sharing consent, saved transfers, side-by-side file review, test mappings, visible execution limitations, cancellation, exact patch downloads and existing draft-PR controls.

The controller retains existing same-origin API contracts, CSRF and exact review digests. It prevents mismatched/empty repository submissions, requires both publish acknowledgements, respects operator switches, and clears private review content and repository names on logout/expiry. All repository content is rendered using `textContent`; delivery URLs must be ordinary GitHub PR links. The downloaded file is now `repot.patch`.

A frontend-only deployment is detected from a missing/unusable session API, not assumed to be a connected product. Its composer, deletion, refresh and publication actions are disabled. Sign-in is offered only after the server returns an authentication-required response. Nothing is simulated as a successful transfer.

## Deployment

`vercel.json` uses `node scripts/build-site.mjs`, with `.repot-site` as output and no dependency installation for this static build. Only the three public assets are copied. Backend source, environment files, database files, fixtures and build scripts are not exported. Security headers do not enable inline scripts/styles. This solves the earlier missing-public-directory issue for the frontend; it does not migrate SQLite, implement durable Vercel jobs or deploy an API.

The repository's GitHub integration may automatically redeploy on a push. No hosting project setting, permission, API secret, database or paid resource is created by this change.

## Observed validation

- `npm run test:frontend`: 26 passed, 0 failed, 0 skipped.
- `npm run build:site`: passed; only index.html, style.css, app.mjs exported and checked against source bytes.
- JavaScript syntax checks: passed for controller, build script and both frontend test files.
- Offline Chromium DOM rendering: 1440, 1024, 390 and 320px; no horizontal overflow or page errors; unavailable composer disabled, anatomy tabs and privacy disclosure exercised.
- Direct browser HTTP navigation: attempted, blocked with `ERR_BLOCKED_BY_ADMINISTRATOR`. No policy settings were changed. Offline rendering is a separate local layout check, not HTTP/CSP/OAuth/backend verification.
- Current full engine, connected server, Jest/Vitest and Windows suites: not rerun. Their prior reports remain historical. No paid AI or live user repository execution.

`scripts/render-design-offline.py` reproduces the isolated layout inspection using an installed Playwright/Chromium. It inserts the authored markup/style/controller into a blank document; no backend responses or authenticated data are injected. The committed image is a cropped, resized capture of this offline render, not a fabricated product screen.

## Compatibility and remaining gates

`GRAFT_*` environment keys, `graft/` delivery branches, cookie names, encrypted storage keys, GitHub App configuration and engine schemas are intentionally retained. The repository is not renamed. No logged-in account or saved data is migrated by a visual rebrand.

Live OAuth/PR acceptance, the Vercel-compatible backend and isolated user-project execution remain release gates. Do not present a successful static build as production readiness.

Primary configuration reference: https://vercel.com/docs/project-configuration/vercel-json
