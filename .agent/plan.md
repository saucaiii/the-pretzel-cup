# Plan — Invoice email restyle + drop DISCOUNT row from customer-facing invoice surfaces

## Risk
**HIGH.** Edits `api/_lib/invoice-template.js` AND `api/_lib/invoice-pdf.js`
(both plan-first per `.agent-policy/policy.sh`). Visual-only — no
schema change, no change to the send flow, no new serverless
function, no env, no secret. Live sends remain env-gated
(`EMAIL_SEND_LIVE_ENABLED=true`). `api/wholesale/invoice.js` and
`api/_lib/gmail.js` are untouched. `discount_cents` on the order row
stays populated (wholesale-e2e report: "fine to keep for internal
ops analytics — retail value of gifts given").

## Goal
Two coupled customer-facing changes:

1. **Email restyle (primary):** restyle the operator-triggered
   invoice email body to borrow the Shopify order-confirmation
   layout (logo + order-number header, large heading, order-summary
   rows, totals block, customer-info columns, footer) while keeping
   the actual flow semantics — the customer's order is confirmed AND
   there's an **open, unpaid invoice attached**. Copy, labels, and
   emphasis must reflect that — not the post-payment "Thank you for
   your purchase" shape Pudgy's email has. Payment instructions are
   the primary CTA.

2. **Drop DISCOUNT row from customer-facing surfaces (coupled fix):**
   the wholesale-e2e report (/tmp/wholesale-e2e-report.md, §#4 and
   addendum "Still open after PR #20") flagged that the 100-for-25
   bonus is a **free gift**, not a price cut, and that printing
   `DISCOUNT -$27.50` next to an unchanged TOTAL both reads like
   broken math AND assigns a public dollar value to a gift. Drop
   the DISCOUNT row from both the PDF renderer and the email —
   the `(free)` line item on each line-items table already carries
   the story. `discount_cents` stays on the order row for internal
   analytics; it just stops being rendered on customer surfaces.

The PDF invoice is still attached to the email. The plain-text
fallback keeps working for clients that don't render HTML.

## Scope (files, worktree-relative)
- `.agent/plan.md`, `.agent/state.md`, `.agent/decisions.md`
- `api/_lib/invoice-template.js`   (modify — rewrite the HTML branch + drop the markdown `Discount:` line; keep plain-text fallback)
- `api/_lib/invoice-pdf.js`        (modify — remove the DISCOUNT totals row; `discount_cents` is still accepted on the input order, it just stops being rendered)

**No changes to** `.claude/`, `.agent-policy/`, `.agent-control/`,
`.env*`, `vercel.json`, `supabase/migrations/`, `api/_lib/gmail.js`,
`api/_lib/md.js`, `api/wholesale/*`, `ops/wholesale/index.html`, or
`docs/wholesale.md`.

## Steps
1. **Introduce `buildHtml({ order, customer })`** in `invoice-template.js`.
   Returns a full HTML string with inline styles — no stylesheet, no
   `<link>`, no external CSS. Table-based layout (the only shape that
   renders reliably across Gmail, Outlook, Apple Mail). 600 px fixed
   width container, mobile-responsive via a `<style>` tag with
   `@media (max-width: 600px)` resetting widths to 100 % (same trick
   the Pudgy template uses).
2. **Sections, top to bottom:**
   - **Header row.** Left cell: `<img src="${BASE_URL}/ppf-logo.jpg"
     width="160" alt="Philly Pretzel Factory">`. Right cell: uppercase
     gray "INVOICE #<invoice_number-or-short>". `BASE_URL` defaults to
     `https://the-pretzel-cup.vercel.app` with an override for
     `process.env.WHOLESALE_BASE_URL`. We say INVOICE, not ORDER — the
     attached PDF and the customer's mental model both expect it.
   - **Content heading.** "Thanks for your order — invoice attached."
     (24 px, PPF green). Below it, one plain paragraph: "Your wholesale
     order is confirmed. The PDF invoice attached is **unpaid** — see
     *Payment* below for how to settle it. We'll have your order ready
     for the pickup date listed." This is the key semantic difference
     from a Shopify receipt: we tell the customer up front there's
     money due.
   - **Amount-due callout.** A single cream-background cell at the top
     of the body (before the order summary) that reads
     "**Amount due:** $N.NN" in 20 px PPF-green bold. Operators need
     the recipient to see the dollar amount without scrolling.
   - **Order summary.** `<h3>Order summary</h3>`, then one row per
     line item: title (bold, 16 px) + optional "(free)" subtitle for
     bonus items, right-aligned line total. Thin `#e5e5e5` rule
     between rows.
   - **Subtotals.** Subtotal only. **No Discount row** (coupled fix:
     the `(free)` line items on the item table already tell the
     story; printing a dollar discount frames the bonus as a price
     cut). Bold PPF-green **Amount due** (24 px) — label reads
     "Amount due", not "Total", to match the "unpaid" framing.
   - **Pickup / Bill-to row.** Two columns. **Pickup** heading →
     location + date + time from the order (what the customer needs
     to plan around). **Bill-to** heading → organization / contact
     name / address lines from `customer.pickup_address`. Same two-
     column `<h4>` pattern Pudgy uses for Shipping/Billing.
   - **Payment section.** Full-width panel with a visible border and
     a PPF-green "Payment" heading — raised in visual weight relative
     to the surrounding sections so it reads as the primary CTA. Body
     is the existing `WHOLESALE_INVOICE_PAYMENT_HELP` env (markdown,
     run through `renderMarkdown` so operators keep their current
     payment-instructions text).
   - **Footer.** Horizontal rule, then "Questions? Reply to this email
     or write to mcaiazzoppffs@gmail.com." in 14 px gray.
3. **Plain-text body stays as-is.** `bodyMd` + `toPlainText(bodyMd)`
   still drive the `text/plain` part — an unstyled reader still gets
   a usable receipt.
4. **Helpers.** Reuse `money`, `mdSafe`, `escapeHtml` from the
   existing file / `md.js`. Every templated value that's user-sourced
   goes through `escapeHtml` before being inlined into the HTML
   string (defense in depth — `mdSafe` stays for the markdown path
   only).
5. **PDF renderer parallel fix.** In `api/_lib/invoice-pdf.js`,
   remove the DISCOUNT totals row (the `if (Number(order &&
   order.discount_cents) > 0) { totalsRow(...) }` branch). Keep
   `discount_cents` in the input shape (we still accept it; we just
   don't render it). The `(free)` cell in the items table already
   signals the bonus.
6. **Decision-log entries** in `.agent/decisions.md`:
   - `- 2026-11-05 | hand-build the invoice email HTML with inline-
     CSS tables, bypass renderMarkdown for the HTML part | the
     campaign markdown renderer can't express tables, images, or
     styled container widths, and Gmail/Outlook need table-based
     layout for visual consistency | rejected swapping in mjml or a
     heavier renderer (adds a dep, build-time step); rejected
     teaching md.js tables (bigger surface, risk to campaign sends)
     | review-by 2027-11-05`.
   - `- 2026-11-05 | drop the DISCOUNT totals row from both the PDF
     and the email; keep discount_cents on the order for internal
     analytics | 100-for-25 is a comped-units gift, not a price cut
     — publishing a dollar discount on a gift reads like broken math
     and assigns a public dollar value to a gift (per the
     wholesale-e2e report §#4) | rejected keep-and-relabel (e.g.
     "Promo credit") because any dollar figure still invites the
     "broken math" misread; rejected drop discount_cents from the
     DB (ops uses it as "retail value of gifts given") | review-by
     2027-11-05`.

## Success criteria

### Quantitative
- `node --check api/_lib/invoice-template.js` clean.
- `node --check api/_lib/invoice-pdf.js` clean.
- `node -e "require('./api/_lib/invoice-template').renderInvoice({ order: FIXTURE, customer: FIXTURE })"` returns `{ subject, bodyMd, html, text }` with:
  - `html.includes('Amount due')` true,
  - `html.includes('Order summary')` true,
  - `html.includes('Payment')` true,
  - `html.includes('ppf-logo.jpg')` true,
  - `html` carries the dollar total at least twice (callout + totals row),
  - `!html.includes('Discount')` and `!bodyMd.includes('Discount')` (gift-framing fix),
  - `text.length > 50` (plain-text fallback still populated),
  - no `undefined` / `[object Object]` tokens in `html`.
- `renderInvoicePdf(FIXTURE_WITH_BONUS).then(buf => …)` succeeds, buffer still `%PDF-`, and a tiny `pdf-parse`-free string check confirms the output does not include the substring "DISCOUNT". (Smoke: grep the raw buffer for the literal word — pdfkit writes it verbatim into the content stream.)
- CI passes (plan-gate, scope-check, agent-conflicts, test, CodeQL).

### Qualitative
- The rendered HTML shown in the dashboard's invoice-modal iframe (sandboxed) reads at a glance as "order confirmed, invoice attached, here's the amount due, here's how to pay" — not "thanks for your purchase, see you later".
- Amount-due dollar figure is visible above the fold (within the first 400 px of email height) in Gmail / Apple Mail.
- Layout borrows from Pudgy (logo + INVOICE # header, section headings, two-column customer block, totals, footer) while the copy makes clear the invoice is open.
- The modal **Download PDF** button still works unchanged (depends on `rendered_pdf_base64`, which this PR doesn't touch).
- Live send still attaches the PDF (Gmail MIME path unchanged).
- With `EMAIL_SEND_LIVE_ENABLED` unset: send button still refused with the same `live_disabled_reason`.

## Risks + mitigations
- **Client rendering drift.** Gmail/Outlook/Apple Mail interpret CSS
  very differently. Mitigation: table-based layout with inline styles
  (what Pudgy and every transactional-email vendor uses) + a single
  `<style>` block for the `@media` mobile override, matching the
  reference exactly.
- **Logo served from a public URL.** The browser loads
  `${BASE_URL}/ppf-logo.jpg` at display time. Risk: if the prod URL
  is unreachable, the recipient sees a broken image. Mitigation: the
  file is already hosted at `https://the-pretzel-cup.vercel.app/ppf-logo.jpg`
  (shipped with the repo, served by Vercel's static handler), and
  every alt text reads "Philly Pretzel Factory" so a blocker image
  still reads sensibly. No inline-attachment / CID path in this cut.
- **HTML-escape regression.** Customer org / contact name / promo
  code flow into `escapeHtml` before concatenation into the HTML
  string. Covered by existing test on the markdown path (mdSafe)
  and the new reliance on `escapeHtml`.
- **Plain-text drift.** Keeping `bodyMd` → `toPlainText` means the
  text fallback is unchanged; reviewers can still validate the
  pre-restyle behavior by diffing the text output against today's.

## Rollback
- `git revert` the merge commit → Vercel redeploys previous SHA.
- No schema change, no env change. Pure template rewrite.

## Escalation
- Rendering looks right in the dashboard iframe but breaks for a
  specific real email client (Outlook-on-Windows is the usual
  offender) → capture a screenshot, record the client version in
  `.agent/state.md`, flag to human. Don't swap in a heavier framework
  without replanning.
