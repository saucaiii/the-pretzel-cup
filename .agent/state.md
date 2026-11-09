# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/ops-qr-split-d81b8e
Task: Split /ops/qr into two tabs (QR + Referral) with a shared status strip

## Progress
- Rebuilt ops/qr/index.html as two tabs ("QR" + "Referral") with a shared
  read-only status strip above them. Backend untouched.
- Panels marked with data-tab; CSS on #tabs-root[data-active=…] hides the
  other group. Order on-screen stays: p-redirect, p-qr, p-stats, p-history
  for QR; p-offer, p-packs for Referral.
- Tab state: localStorage['ops.qr.tab'], URL hash wins on load, keyboard
  arrows / Home / End move between the two buttons.
- Shared strip updates on config load, set_target, reset_target,
  publish_offer, restore. undefined for either arg = leave alone.
- Dropped the §1..§7 numbering from headings (would read oddly inside tabs).

## Failures and root causes
- Reviewer (reasoning error): scalePhone() ran at init with
  #phone-screen hidden (default tab = QR), so transform: scale(0) until a
  window resize. Fixed by calling scalePhone() from setActive() — the
  first time the Referral tab is shown, it recomputes.
- Reviewer (reasoning error): plan promised "shared strip collapses to
  one column under 720px"; CSS only flipped borders, grid stayed two-up.
  Fixed by adding `.shared-strip { grid-template-columns: 1fr; }` inside
  the 720px media query.

## Review notes
- Two pre-existing test failures (tests/qr-config.test.mjs, tests/
  scan-redirect.test.mjs) are ESM module-resolution errors; they fail
  against clean origin/main too. Unrelated.
- Every fetch(…) / api(…) call site matches origin/main 1-for-1. Actions
  set_target, reset_target, publish_offer, restore unchanged.

## Handoff
- Commit + push the branch. Open a draft PR against main with the agent
  template filled.
- Human preview via `npm run deploy` (local-only per CLAUDE.md).
- Smoke test: /ops/qr renders; "QR" tab shows sticker + studio + scans +
  history; "Referral" tab shows offer editor (phone preview working) +
  pack funnel; shared strip visible from both tabs; refresh keeps last
  tab; URL #qr / #referral switches tabs on load.
