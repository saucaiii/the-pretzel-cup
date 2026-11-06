# Plan — qr-scan-redirect

**Risk:** CRITICAL overall (take the highest). Component by component:
- `middleware.js` (new, repo root, matcher limited to `/scan`) — MEDIUM.
  New routing layer, but the matcher keeps it off every other path.
- `free-pretzels/index.html` (new static page) — LOW.
- `package.json` / `package-lock.json` (add `@vercel/edge-config`,
  `@vercel/analytics`) — MEDIUM (dependency add).
- `tests/scan-redirect.test.mjs` (new) — MEDIUM.
- Creating the Edge Config store, connecting it to the project (this
  writes an `EDGE_CONFIG` connection-string env var, i.e. a secret),
  seeding `scan_target`, and the production deploy — CRITICAL.
  **Prepare only. The human runs these.**

No high-risk paths are touched (`vercel.json`, `api/_lib/`, `scripts/`
all unchanged).

## Goal
1. `/scan` (printed on a vinyl window sticker as a QR) 302s to the
   value of Edge Config key `scan_target`, falling back to
   `/free-pretzels` on any failure. Never 301, never 404.
2. `/free-pretzels` mobile-first offer landing page, offer text and
   redemption mechanic left as marked placeholders.

## Scope
- `middleware.js`
- `free-pretzels/`
- `package.json`, `package-lock.json`
- `tests/scan-redirect.test.mjs`
- `.agent/` (state, plan, decisions)

## Steps
1. `npm install @vercel/edge-config @vercel/analytics`.
2. `middleware.js`: Vercel Routing Middleware (non-Next project),
   `config.matcher = ['/scan', '/scan/']`. Read `scan_target` with a
   short timeout; validate (relative `/path` or absolute http(s) URL);
   fall back to `/free-pretzels`. Merge incoming query params; if the
   target is our own host, add `utm_source=window_sticker` and
   `utm_medium=qr` (unless the incoming URL already sets them).
   302 with `Cache-Control: no-store`. Fire `qr_scan` custom event via
   `@vercel/analytics/server` inside `waitUntil` so logging never
   blocks or breaks the redirect.
3. `free-pretzels/index.html`: brand tokens, Archivo Black / Montserrat
   fallbacks (FatFrank / Gotham files are not in the repo), unaltered
   logo + "Made to Crave", placeholders, two locations with tel: links.
4. Node tests for the target resolver and the fallback path.
5. Visual check of the page at phone width in a local static server.
6. Commit, push, open DRAFT PR.

## Success criteria
- Tests pass: empty / missing / malformed / unreachable config all
  resolve to `/free-pretzels`; own-site targets get UTM; external
  targets don't; query params pass through; status is 302.
- Page renders at 375px with no horizontal scroll, no em dashes,
  no emojis, no shadows, no gradients, no hover animation.

## Risks + mitigations
- Middleware runs on every request if the matcher is wrong. Mitigation:
  explicit matcher, and a test asserts the exported matcher.
- Edge Config unreachable or token missing. Mitigation: try/catch +
  500ms timeout → fallback.
- Open redirect: `scan_target` is only writable by Vercel team members,
  and query params never change the destination host.
- Custom events need Web Analytics enabled on the project (Pro plan).
  If not enabled, events are silently dropped; the redirect still works.

## Rollback / escalation
- Revert the PR commits (`git revert`). `/scan` keeps working through
  the fallback as long as `middleware.js` is deployed; deleting the
  store or key only changes the target to `/free-pretzels`.
