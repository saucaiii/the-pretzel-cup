# Onboard a new delivery stop — one true workflow

Branch: `agent/onboard-delivery-stop` (off `main`)
Risk: Medium — ops endpoint + two pages, no `api/_lib/`, no migrations, no `vercel.json`.

## Goal

A single, discoverable path to add a new store (= stop) to an existing delivery
route (FSQ / LYN / FBW). Replace the 8-step franchise wizard and the per-route
Add-stop form with one flat form that works for independent cafes and 7-Eleven
franchises alike. When a stop is added it propagates to every downstream system
in one shot: Supabase, the baker/driver apps (via DB read), the all-hands auto
update, the Google Sheet column, and the optional portal + welcome delivery +
day-one kit follow-ups.

## Scope (files touched)

- `ops/stops/index.html` — rename page to "Delivery stops", delete the
  per-route Add-stop section, add a primary `+ ADD NEW STOP` button to the
  header, make each row's Route pill an inline `<select>` that PATCHes
  `route_key` so a mis-routed stop is a one-click fix.
- `ops/onboard/index.html` — rewrite as a single scrollable form. See **Form
  shape** below.
- `api/schedule.js` —
  - `handleOnboardCreate`: drop the `singles + doubles >= 10` gate (keep ≥ 1);
    make `portal_pin` optional; keep `route_key`/`name`/`town`/`manager_email`
    required; call `insertSheetColumn` from `_lib/sheet` when the operator opts
    in; auto-publish stays wired.
  - `handleStopsPatch`: extend the whitelist to accept `route_key`. When it
    changes, recompute `stop_order = max + 1` on the target and fire an
    `autoNewStop`-shaped update so drivers/bakers see the move.
- `ops/index.html` — nav label + dashboard tile flip "Stops" → "Delivery
  stops".

No edits inside `api/_lib/`. The sheet helper is imported, not changed.

## Form shape (ops/onboard)

Section 1 — Where (required)
- Route select (no default; FSQ / LYN / FBW)
- Store name, Town, Street address

Section 2 — Standing order (required)
- Segmented control: **[ 5 / 5 standard ]**  [ 10 / 10 ]  [ Custom ⤵ ]
  - Default: 5 singles + 5 doubles
  - Custom expands to −/+ counters (min 1 across both)
- Delivery days (Mon–Sun chips, ≥ 1)

Section 3 — Contact (required)
- First + Last name, Email (welcome email target), Phone optional

Optional (collapsed disclosures, no gates):
- Portal access — "Generate 4-digit PIN now" toggle. Off = portal setup
  deferred to `/ops/invite`.
- Welcome delivery — date + driver. Blank = scheduled later.
- Day-one kit — short checklist; link to `/ops/print-kits` for physical
  pieces. Non-blocking.
- "Also add a column to the Google Sheet" — same opt-in dropdown the old
  Add-stop form had.

Primary button at the bottom: `Add <Name> to <Route>` (label fills live).

After submit, success screen shows three link-cards for any skipped optional
sections (portal, welcome, kit).

## Delivery Stops page (ops/stops)

- Title "Stops" → "Delivery stops" (page `<h1>`, `<title>`, nav links,
  dashboard tile).
- Header right: primary `+ ADD NEW STOP` button → `/ops/onboard`.
- Delete the entire `#add-stop` section (form + heading + add-note).
- Each row's Route pill becomes an operator-only `<select>` PATCHing
  `route_key`. On change, the row animates out and reappears under the new
  route tab.
- Keep every existing control: drops, shorts, basket, note, payment chip,
  active toggle.

## Success criteria

Quantitative
- Only edits the four files listed above (CI scope-check).
- `handleOnboardCreate` with `{route_key, name, town, singles_drop:5,
  doubles_drop:5, manager_first_name, manager_last_name, manager_email,
  delivery_days:['mon']}` returns 200 and creates a stop (no PIN required).
- `handleStopsPatch` with `{route_key:'LYN'}` on an FSQ stop moves the row to
  LYN with `stop_order = max+1`.
- Adding Union Bagel via the new form lands it on LYN, posts an auto-update,
  and (if opted in) inserts the sheet column. Union Bagel's current FSQ row
  can be moved to LYN from the Delivery Stops page in one click.

Qualitative
- An operator can add a new stop without scrolling, without a wizard, without
  a hidden gate. The form reads top-to-bottom and the primary button names the
  exact action.
- `/ops/stops` no longer has two ways to add a stop. There is one door.

## Risks + mitigations

- **Rename churn.** "Stops" → "Delivery stops" touches nav in two pages;
  every link stays `/ops/stops` so no routing breaks.
- **Route PATCH recompute.** `(route_key, stop_order)` is a unique index.
  Recompute inside the same server-side update; return 409 on race.
- **Sheet column insert failure doesn't fail the add.** Same pattern the
  old form used. Error is surfaced in the response alongside the new stop.
- **Optional PIN.** `store_pin_hash` nullable in the insert means the portal
  sign-in is off for that stop until `/ops/invite` backfills it. Existing
  stops are unaffected.

## Rollback / escalation

- Revert the single merge commit. No schema changes, no data migrations.
- If the route-change PATCH behaves badly in prod, the whitelist addition
  can be removed in a one-line follow-up without undoing the form rebuild.
