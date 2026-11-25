# Plan — Revenue page rebuild

**Risk:** High (Supabase schema change + bulk UPDATE on `returns`).
**Branch:** `agent/revenue-rebuild`.
**Started:** 2026-11-25.

## Goal

Make the ops Revenue page audit-defensible and more informative, without
over-engineering. Three things in scope:

1. Reconstruct `returns.submitted_by` for 2025–2026 from the Google Sheet
   (`Daily Delivery Sales Report - All Accounts`, 4 tabs).
2. Freeze pricing on each `returns` row so historical revenue is
   self-reproducible without relying on current `stops` prices.
3. Add Monthly + rolling-Annual windows, period-over-period Δ tiles, drilldown
   click-through, and fix two label bugs on the page.

Out of scope for this PR (named so we don't lose them):

- Append-only audit trigger on `returns`.
- Period close + server-side cutoff enforcement.
- Cash reconciliation view (recognized vs. invoiced vs. received vs. AR Δ).
- COGS / inventory / waste tracking (bake_logs).
- Wholesale consolidation into one unified revenue page.

## Context (what I already verified)

- Current page sums `returns.sold_cents` across a date window — grand total is
  correct ($150,384.70 all-time, 7,783 rows).
- 1,141 rows have `submitted_by = NULL` ($23,372.74). 0 are on FBW.
- 23 rows have `sold_cents` that doesn't match current `stops` pricing because
  the 711 double was dropped from $3.85 → $3.50 for 2 stores mid-2026. The
  stored totals are correct (billed at the price in force at submit); current
  stops pricing is just no longer the same, which breaks naive recomputation.
- Shorts live on both LYN (6 stops) and FBW (8 stops, which is 100% shorts).
  The "Baked at Lynbrook only" label on the Revenue summary card is wrong.
- Sheet tabs: `Franklin Square` (FSQ), `Valley Stream/Rockville Centre` +
  `East Rock/Oceanside/Long Beach` (both LYN), `Baldwin/Freeport` (FBW).
- Sheet cells per stop are **dollar totals** (not singles/doubles). We don't
  need those — we only need the driver name per (date, stop).

## Phases & success criteria

### Phase A — Reconstruction of `submitted_by`

**Deliverable:** `supabase/migrations/NNNN_backfill_submitted_by_from_sheet.sql`
that creates a `Legacy Import` system user (if missing), then updates
`returns.submitted_by` for the 1,141 NULL rows using a mapping derived from
Sheet data.

**Steps:**

1. Pull all four tabs' `(Timestamp, Date, stops…, Name)` via the Sheets MCP.
2. Build a `(for_date, stop_id) → driver_id` map:
   - FSQ tab → FSQ route, match by `for_date`.
   - Baldwin/Freeport → FBW, match by `for_date`. (0 NULL rows here, so this
     is defensive only.)
   - VS/RVC + East Rock → LYN. For each sheet row, treat a non-blank per-stop
     cell as "this driver served this stop this day." A LYN stop's driver is
     the Name from whichever tab had a non-blank cell for that stop.
3. Apply aliases: `Juliana` → `Julianna`. Unknown names → unassigned.
4. Normalize year typos (`0026` → `2026`).
5. Dry-run match: how many of the 1,141 NULL rows match? Report counts by
   (year, route, matched/unmatched). Share with user before Phase A3.
6. Create `Legacy Import` person (`role='system'` if the enum allows; else
   `operator` with a flag).
7. UPDATE: matched rows get the real driver; unmatched rows get Legacy Import.
   Both are safe to re-run (idempotent on NULL).

**Success criteria:**

- After Phase A, `SELECT COUNT(*) FROM returns WHERE submitted_by IS NULL` = 0.
- By-driver revenue table on the Revenue page shows real drivers for ≥ 85%
  of the previously-unknown $23K.
- A spot-check of 10 random reconstructed rows against the Sheet confirms
  the attribution.

### Phase B — Freeze pricing on the `returns` row

**Deliverable:** `supabase/migrations/NNNN_returns_freeze_prices.sql` adding
two columns + a backfill.

**Steps:**

1. Migration: add nullable columns
   - `price_single_cents_at_submit INT`
   - `price_double_cents_at_submit INT`
2. Backfill:
   - For every row where
     `sold_cents = sold_singles * COALESCE(stops.price_single_cents, 215)
                 + sold_doubles * COALESCE(stops.price_double_cents, 385)`,
     write those current prices into the new columns.
   - For the 23 pre-cut 711 rows that don't match current pricing, solve the
     implied historical prices from `sold_cents` (we already identified them
     as `ps=215, pd=385`).
   - Any row whose `sold_cents` matches neither current nor the implied
     historical pricing gets logged, not updated, and I come back to the user
     with the list.
3. Update [api/driver/submit.js:106](api/driver/submit.js:106) to also write
   `price_single_cents_at_submit` and `price_double_cents_at_submit` on every
   upsert.
4. Follow-up (deferred to Phase D or next PR): once these columns are 100%
   populated, add a Supabase CHECK that
   `sold_cents = sold_singles * price_single_cents_at_submit
               + sold_doubles * price_double_cents_at_submit`.

**Success criteria:**

- After Phase B, every `returns` row has both at-submit price columns
  populated and the invariant `sold_cents = s*ps + d*pd` holds for 100% of
  rows.
- New driver submits write the at-submit prices automatically.
- Nothing breaks on the existing Revenue page (it still sums `sold_cents`
  the same way).

### Phase C — UI/API info depth

**Deliverable:** changes to `api/schedule.js` (`handleRevenueGet`) and
`ops/revenue/index.html` only.

**Steps:**

1. Add `month` and `annual` (rolling 12 months) to the window set in
   `handleRevenueGet` and to the toolbar.
2. For each tile on the summary strip, also return a `prev_total_cents`
   from the immediately-preceding window of equal length, and render a
   signed % delta chip next to the value.
3. Fix labels:
   - `summary.total_shorts_units` detail: drop "Baked at Lynbrook only"
     (replace with "Shorts-flagged stops").
   - Page eyebrow: "Gross retail sold" → "Gross wholesale billed".
4. Drilldown: clicking a route row expands to its stops within the current
   window; clicking a driver row expands to their day-by-day. Implemented
   with existing `by_stop` and a new endpoint for driver-day totals (or
   client-side from already-fetched rows if scope is small enough).

**Success criteria:**

- All five windows (Weekly / 30d / Monthly / Quarterly / YTD / Annual)
  load correctly.
- Δ chips show vs. the prior equivalent period.
- Shorts/wholesale labels are accurate.
- Drilldowns reveal per-row detail without an extra page load for the common
  case.

## Rollback

- Phase A: `UPDATE returns SET submitted_by = NULL WHERE submitted_by = <legacy_import_id>` restores the unattributed set. For reconstructed rows, keep a sidecar table `returns_reconstruction_log` (for_date, stop_id, old_submitted_by, new_submitted_by, source_tab, source_row) so a full undo is possible.
- Phase B: Columns are nullable and additive. Rollback is `ALTER TABLE returns DROP COLUMN …`. `api/driver/submit.js` reverts to just stop-price lookup if needed.
- Phase C: Pure client/server render changes. Revert the two files.

## Order of operations

1. Finish Phase A dry-run (counts + sample unmatched rows) **before writing any Phase A migration**.
2. User approves Phase A, I write + apply the migration.
3. Phase B migration + backfill + submit.js change, all in one PR.
4. Phase C in a separate PR so the API/UI diff is reviewable on its own.

## Evidence to include in each PR

- Phase A: before/after counts, sample rows, match-rate per route/year.
- Phase B: invariant check showing 100% of rows satisfy
  `sold_cents = s*ps + d*pd` post-backfill.
- Phase C: screenshots of the new windows + Δ chips (desktop + mobile).
