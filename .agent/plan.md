# Plan — Shared /ops nav (PR 2 of operator-dashboard cleanup)

- **Risk:** medium
- **Goal:** Replace 11 drifting per-page nav-bar variants across 15 `/ops/*` HTML files with one shared JS include that renders a 5-section IA (Today / Operations / Money / Growth / Plan).
- **Scope (paths/files):**
  - `assets/ops-nav.js` (new — the shared nav component)
  - `ops/index.html`
  - `ops/invite/index.html`
  - `ops/onboard/index.html`
  - `ops/payments/index.html`
  - `ops/people/index.html`
  - `ops/print-kits/index.html`
  - `ops/prospecting/index.html`
  - `ops/revenue/index.html`
  - `ops/shifts/index.html`
  - `ops/stops/index.html`
  - `ops/store/index.html`
  - `ops/time-off/index.html`
  - `ops/updates/index.html`
  - `ops/plan.html`
  - `ops/standings.html`
- **Steps:**
  1. Add `assets/ops-nav.js` with the 5-section nav model (sections = Today, Operations, Money, Growth, Plan), click-to-open dropdowns, keyboard-escape close, outside-click close, current-page detection from `location.pathname`.
  2. In each of the 15 ops HTML files: empty the body of `<nav class="ops-site-nav" aria-label="Primary">` (keep the element) and inject `<script src="/assets/ops-nav.js" defer></script>` before `</body>`.
- **Success criteria (verifiable):**
  - [x] Required checks pass (CI)
  - [x] Intent signal met: every ops page shows the same 5-section nav; active section/page highlighted correctly; 11-variant drift eliminated
  - [x] Only files in scope changed (new `assets/` dir + the 15 ops HTML files)
  - [x] No new code scanning alerts
- **Risks + mitigations:**
  - FOUC risk: with `defer`, the empty nav shows briefly before injection. Acceptable for a logged-in operator surface; CSS extraction PR will add a width-reserving placeholder.
  - JS-off browsers: nav disappears entirely. Operators run modern Chrome; acceptable for internal tool.
  - Driver/baker regression: zero — nothing in `/driver`, `/baker`, `/api`, `brand.css`, or Supabase is touched.
- **Rollback / escalation plan:** `git revert <sha> && npm run deploy`.
