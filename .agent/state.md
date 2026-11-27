# Working memory (short-term). Keep under 60 lines.
Branch: agent/driver-photos
Task: driver-photos
Status: in-progress (plan approved; implementing)
Started: 2026-11-27

## Plan
- Full plan at .agent/plan.md.
- Bi-weekly Friday box photos on /driver, anchor 2026-12-05.
- Supabase (route_photo_submissions, p25) is source of truth; Sheet tab "Box Photos" mirrors; Drive holds photos; Telegram posts the folder link.
- Everything folds into api/driver/submit.js as ?action= dispatcher — Hobby fn count unchanged.

## Progress
- Branch created from main.
- Plan written and approved interactively.

## Handoffs
- none (single-session)
---
PREVIOUS TASK (agent/revenue-rebuild) context moved off this file — see git history on that branch.

## Plan
- Full plan at .agent/plan.md (3 phases: A reconstruct submitted_by, B freeze prices, C UI depth).
- User is driving interactively; no formal approve-plan.sh gate.

## Progress
- Phase A: reconstructed submitted_by for all 1,141 previously-NULL rows.
  - Added people rows: Vikas (driver) and Nick (driver), both with
    pin_hash = '!DISABLED_RECONSTRUCTION_PLACEHOLDER' (no sign-in).
  - Created table public.returns_reconstruction_log (p10 migration) to
    capture every attribution for rollback.
  - Script .agent/reconstruct-submitted-by.mjs matches by (for_date, stop)
    against the four Sheet tabs; aliases Juliana→Julianna, Mike C→Mike;
    falls back to Chris for the 74 rows where Sheet row exists but Name
    cell is blank (all pre-rollout Oct–Nov 2025).
  - Result: 1,067 attributions from Sheet, 74 Chris fallbacks, 0 unknowns.
  - $150,384.70 total revenue unchanged; "Unknown" bucket is gone from
    the Revenue page's By Driver table.
- Phase B: froze at-submit pricing on every returns row.
  - Added columns price_single_cents_at_submit, price_double_cents_at_submit
    (p11 migration) and backfilled all 7,791 rows.
  - All rows now satisfy the invariant
    sold_cents = s*ps_at_submit + d*pd_at_submit (0 breaks).
  - api/driver/submit.js updated so new submits write these columns.
  - Follow-up (next PR, not this one): add a CHECK constraint enforcing the
    invariant once a couple weeks of new submits have populated cleanly.
- Phase C: Revenue page info-depth + label fixes.
  - api/schedule.js handleRevenueGet: added `month` + `annual` (rolling
    12m) windows, previous-window summary for Δ chips, and a per-driver
    daily series (by_driver_day) for the driver-row drilldown.
  - ops/revenue/index.html: toolbar now has Weekly / 30d / Monthly /
    Quarterly / YTD / Annual; summary tiles show Δ% chips vs the prior
    equivalent window; eyebrow changed from "Gross retail sold" to
    "Gross wholesale billed"; shorts card no longer says "Baked at
    Lynbrook only"; route rows expand to their stops and driver rows
    expand to their daily breakdown.
- Next: UI verification against dev server; open PR.

## Handoffs
- none (single-session)
