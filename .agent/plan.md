# Plan — Extract shared /ops chrome CSS

- **Risk:** low (visual-only, no logic / API / schema)
- **Goal:** Collapse the ~189 lines of duplicated chrome CSS (banner, nav, sign-out, page frame) that each `/ops/*` HTML file redeclared inline into one `/assets/ops-chrome.css` loaded via `<link>`. Prevents future drift of the kind that caused the 11 nav-bar variants we just fixed.
- **Scope (paths/files):**
  - `assets/ops-chrome.css` (new)
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
  - `ops/plan.html` (gets the link; its scoped `#app .ops-chrome` rules keep overriding where present)
- **Not touched this PR:** `ops/standings.html` has its own self-contained CSS with its own `:root` variables (no `/brand.css` link). Migrating it needs a design pass; separate follow-up.
- **Steps:**
  1. Add `assets/ops-chrome.css` with the canonical chrome rules (banner, header-right, ops-site-nav, nav-link family, public-link family, logout-btn family, page / page-eyebrow / page-title / page-sub, mobile tap baseline).
  2. In each ops HTML file, add `<link rel="stylesheet" href="/assets/ops-chrome.css">` immediately after `/brand.css`.
  3. Strip the matching single-line chrome rules from each file's inline `<style>` block. Page-specific CSS stays inline.
- **Success criteria:**
  - [x] 189 chrome-rule lines removed across 14 files
  - [x] One ops-chrome.css is authoritative for all shared chrome
  - [x] Visual parity on `/ops` and every sub-page (preview smoke test)
  - [x] URL structure, APIs, and driver/baker surfaces unchanged
- **Risks + mitigations:**
  - Rule-order drift: the regex only strips lines that match known chrome selectors AND are single-line rules — page-specific overrides stay in place.
  - standings.html mismatch: left out of scope; still works as it did.
  - Cascade upset: the new CSS loads after brand.css so brand tokens resolve correctly; it loads before each page's inline `<style>` so pages can still override.
- **Rollback:** `git revert <sha> && npm run deploy`.
