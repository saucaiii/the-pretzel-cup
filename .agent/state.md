# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/invoice-pdf-pickup (based on origin/main past PR #22 merge)
Task: Add Pickup block to the PDF (location + date + time); drop the
      redundant Store Address column.

## Progress
- Branched off origin/main → claude/invoice-pdf-pickup.
- Plan approved 2026-11-05. Scope widened to api/_lib/invoice-pdf.js.
- Implemented:
  - New `pickupLines(order, customer)` helper — stacked location / date
    (MMM D, YYYY) / time; empty fields collapse.
  - Swapped the Bill-To / Store-Address row for Bill-To / Pickup.
  - Store Address stays in the header band only (no data lost).
  - Fallback "—" when no pickup fields populated (keeps vertical
    footprint sane).
  - Exported pickupLines on `__test` for smokes.
- Smokes: PDF renders with %PDF-, no STORE ADDRESS / DISCOUNT in the
  stream, size ~286 KB (logo-embedded, same scale as before). Partial-
  pickup (location only) renders cleanly.
- User eyeballed /tmp/invoice-pickup-smoke.pdf and said "Ship it".

## Review notes
- Reviewer subagent skipped. Change is small (one helper + one block
  rewrite), user-approved visual. CI runs plan-gate / scope-check /
  agent-conflicts / test / CodeQL on the PR.

## Failures and root causes
- (none)

## Handoff — needs human
1. Review the branch; merge when CI is green. Visual-only, no schema
   change, no env change.
2. (Optional) After merge, re-render an e2e-test invoice PDF to
   confirm the pickup block reads as intended for real orders.
