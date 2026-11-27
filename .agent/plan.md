# Plan: signin dual-role + DB roster

**Risk:** high (touches `supabase/migrations/` + auth path).
**Scope:** `signin.html`, `api/auth/signin.js`, `supabase/migrations/`, `supabase/schema.sql`

## Goal

Make the sign-in page actually reflect staff changes. Two pieces, one PR:

1. **Dual-role sign-in.** Someone with a secondary role (Vic bakes
   M/W/Th/F, drives Tue) picks which role for today at sign-in. Server
   signs the JWT with that chosen role, so route gating downstream
   keeps working unchanged.
2. **DB-sourced roster.** The picker reads `GET /api/auth/signin`
   instead of the hardcoded `PEOPLE` array that keeps falling behind
   (Nick, Vikas, Chris, Jyoti all exist in `people` but not on the
   sign-in page today). Hardcoded list stays as an offline fallback.

Context: this feature was written on 2026-11-02 as `stash@{4}:
vic-dual-role` and never shipped; the gh900 kit sync got in front of
it. Working tree now has a rewrite that *also* forgot the DB
migration, so even if shipped the chooser is dead code. One PR, one
commit series, done.

## Scope (files this task may change)

- `signin.html` — add role chooser step, `loadRoster()`
- `api/auth/signin.js` — `GET` roster handler, dual-role `POST` branch
- `supabase/migrations/p26_secondary_role.sql` — new migration:
  - `alter table public.people add column secondary_role user_role;`
  - `create or replace function public.verify_pin(...)` returning
    `secondary_role` too
  - `update public.people set secondary_role='driver' where name='Vic';`
    (seed — Vic is the only known dual-role person today)
- `supabase/schema.sql` — keep in sync with the migration (column +
  verify_pin signature)
- `.agent/plan.md`, `.agent/state.md` — working memory

Out of scope (deliberately):
- `api/_packs.js` CRM window toggle (stashed, separate PR)
- `.env.example` (stashed with _packs)
- People-admin UI for setting `secondary_role` — follow-up; for now
  it's set in the migration and via Supabase console
- `api/_lib/telegram.js` `esc(effective_date)` fix from stash@{4} —
  unrelated hardening, fold into a separate cleanup PR

## Steps

1. Write `p26_secondary_role.sql` migration (ALTER TABLE + redefine
   `verify_pin()` + Vic seed) and apply the same two definition
   changes to `schema.sql` so fresh-DB installs match.
2. Confirm the existing uncommitted code in `signin.html` and
   `api/auth/signin.js` lines up with the migration's RPC return
   shape (it already reads `row.secondary_role` — nothing more
   needed).
3. Commit all four files in one commit on `agent/signin-dual-role`.
4. Push, open draft PR to `main` filling in the Agent section of the
   template + the Evidence block.
5. Human merges; human runs `npm run deploy`; human applies p26 in
   Supabase (SQL editor or CLI).

## Success criteria

Quantitative:
- `supabase/migrations/p26_secondary_role.sql` exists.
- `schema.sql`'s `verify_pin` returns `(id, name, role, secondary_role)`.
- `GET /api/auth/signin` returns `{ people: [{name, role}] }` with no
  other fields (no PIN hash, no telegram id, no uuid leaked).
- `POST /api/auth/signin` with name+pin alone, for a person with a
  `secondary_role`, returns `{ choose: true, roles: [primary, secondary] }`
  with **no session cookie set**.
- Follow-up POST with `chosen_role` sets the cookie and signs the JWT
  with that role.
- First-login (pin === '0000') bypasses the chooser.

Qualitative:
- On prod: Vic signs in Tue → sees "Sign in as [baker] [driver]" →
  taps driver → lands on `/driver`. Same Vic, Fri → taps baker →
  lands on `/baker`.
- Everyone else (single role) sees the exact same flow they see today.
- Nick and Vikas (whose `pin_hash = '!DISABLED_RECONSTRUCTION_PLACEHOLDER'`
  from the Nov 25 reconstruction) appear in the picker but cannot
  sign in — expected until operator resets their PIN.

## Risks + mitigations

- **Migration applied partially.** If the ALTER runs but
  `create or replace verify_pin` fails, the column exists but the RPC
  still returns 3 cols, so the Node code silently no-ops (no chooser,
  original role still returned). Not broken, just the feature doesn't
  work. **Mitigation:** both DDLs are in one migration file, run as
  one script.
- **Role chip CSS missing.** `signin.html` references `.role-chip`
  in the chooser markup — needs a class on the stylesheet or it'll
  render unstyled. **Mitigation:** verify in `signin.html` before
  committing; add a minimal style if absent.
- **PIN stays in memory during chooser step.** `pinForChoose` holds
  the plaintext PIN between the two POSTs. Cleared on success and on
  Change-user. Not written anywhere persistent. **Mitigation:** the
  existing code already clears it; keep it that way.
- **GET roster is unauthenticated.** It returns name+role only — no
  PIN hash, no uuid, no telegram id. Same information already visible
  to anyone who opens the sign-in page. **Mitigation:** already
  scoped tightly in `handleRoster()`.

## Rollback

- Revert the PR. `signin.html` and `api/auth/signin.js` go back to
  `2b9dd0d`; next deploy restores prod.
- The migration's column is additive and the new `verify_pin()`
  signature is a superset, so the reverted Node code (which selects
  3 cols) keeps working without touching the DB. Leave the migration
  applied; no DB rollback needed.

## Deploy plan (for the human merging)

1. Apply p26 in Supabase (SQL editor → paste migration file).
2. Merge PR.
3. `npm run deploy` from `main`.
4. Smoke: sign in as Mike (operator) → lands on `/`. Sign in as Vic
   → sees chooser → picks driver → `/driver`. Sign out, same Vic →
   picks baker → `/baker`.
