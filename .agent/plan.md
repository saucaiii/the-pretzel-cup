# Plan — PDF invoice: show pickup time (and fix the Bill-To / Store-Address redundancy)

## Risk
**HIGH.** Edits `api/_lib/invoice-pdf.js` (plan-first per
`.agent-policy/policy.sh`). Visual-only — no schema change, no change
to the send flow, no new serverless function, no env, no secret. Live
sends remain env-gated (`EMAIL_SEND_LIVE_ENABLED=true`). The PDF
attachment flow in `api/wholesale/invoice.js` + `api/_lib/gmail.js`
is untouched.

## Goal
The customer's PDF invoice carries the **pickup block** the e2e
report flagged as missing:

- **Pickup location** is today buried in the BILL-TO address (from
  `customer.pickup_address`) — reads as the customer's billing
  address, not as "where to come pick up".
- **Pickup time** does not appear on the PDF at all.
- **Pickup date** is in the DATE PERFORMED column of the items
  table, which is correct but implicit.

Replace the two-column **Bill-To / Store-Address** row with a two-
column **Bill-To / Pickup** row. The Store Address was duplicative —
`118 Broadway, Lynbrook, NY 11563` already sits in the header band
right above. The reclaimed column surfaces Pickup properly:
location (line 1), date formatted MMM D, YYYY (line 2), time
verbatim (line 3). This mirrors the invoice-email layout shipped in
PR #22 (Pickup / Bill-to two-column block).

## Scope (files, worktree-relative)
- `.agent/plan.md`, `.agent/state.md`, `.agent/decisions.md`
- `api/_lib/invoice-pdf.js`   (modify)

**No changes to** `.claude/`, `.agent-policy/`, `.agent-control/`,
`.env*`, `vercel.json`, `supabase/migrations/`,
`api/_lib/invoice-template.js`, `api/_lib/gmail.js`,
`api/wholesale/*`, `ops/wholesale/index.html`, or `docs/wholesale.md`.

## Steps
1. **Replace the Bill-To / Store-Address row with Bill-To / Pickup.**
   - Left column header: `BILL TO` (unchanged). Body from
     `billToLines(customer)` as today.
   - Right column header: `PICKUP` (new). Body stacked:
     `order.pickup_location` → line 1 (fall through to
     `customer.pickup_location` if the order didn't carry one),
     `formatDateMDY(order.pickup_date)` → line 2, `order.pickup_time`
     → line 3. Any field that's empty is just skipped — the column
     collapses to fewer lines rather than showing a blank.
2. **Keep the DATE PERFORMED column.** This is the industry-style
   "date the work was performed / goods delivered" column the
   template uses; it stays populated from `order.pickup_date`. The
   PICKUP block above answers "where / when do I pick up?" vs. the
   per-row answer "what day does this line item bill against?".
3. **No change to the Items / Totals blocks.** This is a pure
   header-row swap.
4. **Fallback behavior preserved.** `safePdfText` still strips
   control chars from the pickup fields. A customer with no
   `pickup_location` / `pickup_date` / `pickup_time` (unusual, but
   possible via T6h-style direct-API bypass pre-#23 merge) renders
   as `PICKUP` + an empty body — not a broken layout.
5. **Decision-log entry** in `.agent/decisions.md`:
   `- 2026-11-05 | replace the PDF's Store Address column with a
     Pickup block (location + date + time) | the Store Address was
     duplicating the header band; PICKUP is what customers need to
     act on (e2e report §#Pickup rows); matches the invoice email's
     Pickup/Bill-to two-column shape from PR #22 | rejected adding a
     third column (page width is already tight at 504pt usable);
     rejected a separate PICKUP row below Bill-To (adds vertical
     space without reclaiming any) | review-by 2027-11-05`.

## Success criteria

### Quantitative
- `node --check api/_lib/invoice-pdf.js` clean.
- Smoke: `renderInvoicePdf({ order, customer })` with
  `order.pickup_location="118 Broadway, Lynbrook, NY 11563"`,
  `order.pickup_date="2026-11-15"`, `order.pickup_time="10:00 AM"`
  produces a PDF whose content stream contains `PICKUP` and does
  NOT contain `STORE ADDRESS` (compressed-stream caveat: pdfkit's
  text operators emit the strings in a Tj / TJ instruction, so a
  raw-buffer search still sees them when the stream isn't
  compressed; smoke script toggles pdfkit's `compress: false` for
  the assertion).
- Smoke: order with only `pickup_location` set (no date, no time)
  renders a PDF with `PICKUP` label and a single body line (no
  stray blank lines).
- CI passes (plan-gate, scope-check, agent-conflicts, test, CodeQL).
- No new code-scanning alerts.

### Qualitative
- Visual: the PDF's upper block now reads
  `BILL TO : {customer}` | `PICKUP : {location / date / time}`,
  with no duplicated Lynbrook address.
- Still single-page for a typical 1–4 item wholesale order.
- `EMAIL_SEND_LIVE_ENABLED` unset path still refuses live sends.
- MIME attachment flow unchanged.

## Risks + mitigations
- **Operators expect a Store Address somewhere on the paper
  invoice.** The header band still carries
  `Pretzels of Long Island LLC. 118 Broadway, Lynbrook, NY 11563 ·
  516-459-0954` — no actual information is lost, only a duplicate.
- **Column-width change layout drift.** The widths stay 50/50;
  only the column label and body contents change. No column math
  is recomputed, so the items table below is unaffected.
- **Pickup-time truncation.** The right column's `colW` is
  `USABLE_W/2 - 10` (~242 pt) — fits "10:00 AM – 12:00 PM" easily.
  `safePdfText` trims control chars but preserves whatever the
  customer typed; pdfkit wraps long lines automatically.

## Rollback
- `git revert` the merge commit → Vercel redeploys previous SHA.
- No schema change, no env change.

## Escalation
- If removing Store Address breaks a downstream operator process
  (printing the PDF and mailing it to an address the customer
  reads off the sheet), restore Store Address as a tight third line
  in the header band and move Pickup to a separate labeled row
  below Bill-To — but flag before doing so.
