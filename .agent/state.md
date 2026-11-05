# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/invoice-email-restyle (based on origin/main past PR #20 merge)
Task: Restyle operator-sent invoice email + drop DISCOUNT row from
      both customer-facing surfaces (PDF + email).

## Progress
- Branched off origin/main (PR #20 merged) → claude/invoice-email-restyle.
- Initial plan: single-file invoice-template.js rewrite (Shopify-style
  layout, PPF palette, "unpaid invoice" semantics). Approved.
- Mid-flight: user surfaced wholesale-e2e report finding #4
  (/tmp/wholesale-e2e-report.md) — DISCOUNT row frames the 100-for-25
  bonus as a price cut. Plan amended to drop the row from BOTH PDF
  and email; scope widened to include invoice-pdf.js; re-approved.
- Implemented:
  - api/_lib/invoice-template.js — full rewrite of the HTML branch
    (hand-built inline-CSS table layout: logo + invoice# header,
    "Thanks for your order — invoice attached." heading, "unpaid"
    paragraph, cream Amount-due callout above the fold, order summary
    rows, Subtotal + Amount due totals, Pickup / Bill-to two-column
    block, bordered PPF-green Payment panel, footer). Plain-text
    fallback preserved via buildBody+toPlainText.
  - api/_lib/invoice-pdf.js — removed the DISCOUNT totals row and
    its promo-label branch. discount_cents still accepted on input;
    just not rendered.
- Smokes all pass: no "Discount" anywhere on the email, no
  "DISCOUNT" in the PDF content stream. Visual previews saved
  to /tmp/invoice-email-smoke.html and /tmp/invoice-pdf-smoke.pdf;
  user eyeballed them and said "Ship it".
- Decision-log entries added for the inline-CSS-table choice and
  the discount-row-drop rationale.

## Review notes
- Reviewer subagent skipped. The change is small and localized
  (two files, both visual); the user eyeballed both the email and
  the PDF preview before approving the ship. CI (plan-gate,
  scope-check, agent-conflicts, test, CodeQL) will still run on
  the PR.

## Failures and root causes
- Mid-flight PDF edit was blocked by scope.txt not yet including
  invoice-pdf.js. Context/environment issue — scope must be widened
  *before* the edit tool runs. Fix: human re-ran the scope cat
  with the expanded list, then the edit landed. No code impact.

## Handoff — needs human
1. Review the branch; merge when CI is green. Visual-only, no
   schema change, no env change — same multipart/mixed attachment
   path, same assign_invoice_number RPC.
2. After merge + deploy: confirm the email render in a real Gmail
   inbox (Outlook-on-Windows is the usual offender for inline-CSS
   drift; capture a screenshot if it looks off).
