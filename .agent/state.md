# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/invoice-pdf-branding (based on origin/main past PR #19 merge)
Task: PDF invoice branding pass (logo + PPF-green accents + cream header band).

## Progress
- Branched off origin/main (PR #19 merged) → claude/invoice-pdf-branding.
- Rewrote .agent/plan.md for the branding pass (scope: api/_lib/invoice-pdf.js
  + api/_lib/invoice-logo.jpg).
- Human re-ran approve-plan.sh 2026-11-04 → bound to the new plan hash.
- Copied ppf-logo.jpg (repo root) → api/_lib/invoice-logo.jpg so
  @vercel/nft picks it up statically.
- Edited api/_lib/invoice-pdf.js:
  - Loads LOGO_BYTES once via fs.readFileSync at module load with a
    silent try/catch (null fallback → text-only header).
  - Header lockup: logo at (M, M) with fit [54, 54], store name +
    address + phone shifted LOGO_W + 14pt to the right.
  - Rule under header: 1.0pt PPF green (#0D5237).
  - Items-table header row: cream (#FAF4E1) band, PPF-green labels.
  - Totals block: SUBTOTAL / DISCOUNT / SALES TAX stay 10pt black;
    TOTAL is 11pt bold PPF-green.
  - Thin rule above totals kept, now rendered in neutral gray #999.
  - fillColor/strokeColor paired with save/restore so color state
    doesn't leak between regions.
- Smoke render: /tmp/invoice-smoke.pdf, 286 KB, %PDF-1.3, opens cleanly.
  User previewed and said "ship it".
- Updated .agent/decisions.md with the co-locate-logo decision.

## Failures and root causes
- (none)

## Review notes
- User approved the visual output pre-commit. Skipping reviewer
  subagent for this contained visual-only change; CI (plan-gate,
  scope-check, agent-conflicts, test, CodeQL) still runs on the PR.

## Handoff — needs human
1. Review the branch; merge when CI is green. No schema change, no
   env change, no new function — pure visual pass on top of #19.
2. (Nothing else; prod DB, scope.txt, env all unchanged.)
