# Working memory (short-term). Keep under 60 lines.
Branch: agent/revenue-rebuild
Task: revenue-rebuild
Status: in-progress (Phase A done)
Started: 2026-11-25

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
- Next: Phase B (freeze pricing on the returns row).

## Handoffs
- none (single-session)
