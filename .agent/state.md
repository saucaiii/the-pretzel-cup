# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: agent/onboard-delivery-stop
Task: Rebuild the one true "add a delivery stop" workflow

## Progress
- Branched off latest origin/main.
- Plan at .agent/plan.md (Medium risk — ops pages + ops endpoint, no api/_lib/, no migrations, no vercel.json).
- Rewrote ops/onboard/index.html as a single-page form:
  - Required: route (tiles), store name/town/address, delivery days, owner contact (first/last/email).
  - Standing order: segmented preset [5/5 standard · 10/10 · Custom] with a live total + wholesale sum; custom opens −/+ counters.
  - Optional disclosures: Google Sheet column (open by default, Recommended badge), Portal access (PIN opt-in), Welcome delivery, Day-one kit.
  - Primary button fills label live: "Add <name> to <route label>". Disabled until required set valid; hint explains what's missing.
  - Success panel shows next-step cards tailored to whatever the operator skipped.
- Delivery Stops page (ops/stops/index.html):
  - Added primary `+ ADD NEW STOP` button to the header, right of the blurb. Links to /ops/onboard.
  - Deleted the per-route Add-stop form + related CSS + onAddStop / updateAddFormLabel JS.
  - Added a Route column with an inline `<select>` on each row. Change → confirm → PATCH route_key → reload.
- api/schedule.js:
  - handleOnboardCreate: no 10-unit minimum (≥1 unit total), optional portal_pin (blank pin → no store_pin_hash), manager_email required, Google Sheet column insert wired (same pattern as deprecated stops POST). Returns sheet_insert/sheet_insert_error alongside the new stop.
  - handleStopsPatch: route_key added to whitelist. On route change, validates the target route, recomputes stop_order = max+1 on the new route, posts a "Stop moved" auto-update via auto.postUpdate.
- Syntax checks clean (node --check on schedule.js; python-extracted inline JS blocks for both HTML files).

## Failures and root causes
- (none)

## Review notes
- Nav label "New Store Setup" (assets/ops-nav.js) is outside this task's scope. Follow-up: rename to "Add a stop" for consistency with the rebuilt page.
- Shorts flag isn't exposed in the new /ops/onboard form — it's a rare post-add toggle, lives on /ops/stops. Mention this if testing finds a case where it's needed at add-time.
- Google Sheet section is open-by-default with a Recommended badge; the dropdown populates once a route is picked.

## Handoff
- Commit & push the branch. Open a draft PR against main.
- Human preview via `npm run deploy` (local-only deploys per CLAUDE.md).
- Manual test the Union Bagel flow: on /ops/stops, change Union Bagel's Route pill from FSQ to LYN, confirm, verify it shows under LYN tab with stop_order = max+1 and a "Stop moved" update appears in /ops/updates.
