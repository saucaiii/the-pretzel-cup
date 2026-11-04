# Plan — Server-generated PDF invoice attachment

## Risk
**HIGH.** Touches the live-email path (`api/_lib/gmail.js` MIME assembly,
`api/wholesale/invoice.js` send flow), `api/_lib/*` (plan-first per
`.agent-policy/policy.sh`), and adds a Supabase schema migration. No
new serverless function is added — the PDF logic folds into the
existing `POST /api/wholesale/invoice`, so Vercel's 100-fn cap is
unaffected. Live sends remain env-gated (`EMAIL_SEND_LIVE_ENABLED=true`).

## Goal
When the operator clicks **Mark invoiced → Send invoice**, the customer
receives the existing markdown-rendered email **with a real PDF invoice
attached**, formatted to match the Pretzels of Long Island LLC invoice
template (header + "INVOICE NO. | DATE" row + Bill-To / Store-Address
columns + items table + totals). Dry-run returns the PDF as base64 so
the modal offers a **Download PDF** button for the operator to inspect
before sending.

Done = operator clicks *Mark invoiced* → modal preview shows HTML +
Download-PDF button → live *Send invoice* attaches the PDF to the Gmail
message → status flips to invoiced (CAS-guarded, same as today).

## Scope (files, worktree-relative)
Already widened in `.agent-control/scope.txt`:
- `.agent/plan.md`, `.agent/state.md`, `.agent/decisions.md`
- `supabase/migrations/p16_wholesale_invoice_number.sql`  (new)
- `api/_lib/invoice-pdf.js`                               (new)
- `api/_lib/gmail.js`                                     (modify)
- `api/wholesale/invoice.js`                              (modify)
- `ops/wholesale/index.html`                              (modify)
- `docs/wholesale.md`                                     (modify)
- `package.json`, `package-lock.json`                     (add pdfkit)

**No changes to** `.claude/`, `.agent-policy/`, `.agent-control/`,
`.env*`, `vercel.json`, any other `api/` file, or the markdown email
template (`api/_lib/invoice-template.js`).

## Steps

### 1. P16 migration + decision log
- Create `supabase/migrations/p16_wholesale_invoice_number.sql`:
  ```sql
  create sequence if not exists wholesale_invoice_number_seq
    start with 5000;
  alter table public.wholesale_orders
    add column if not exists invoice_number int;
  create unique index if not exists wholesale_orders_invoice_number_uidx
    on public.wholesale_orders (invoice_number)
    where invoice_number is not null;
  ```
  Partial unique index (not column-level UNIQUE) so retroactive NULLs
  on existing rows stay valid.
- Apply via Supabase MCP `apply_migration`. Idempotent — safe to re-run.
- Append to `.agent/decisions.md`:
  `- 2026-11-04 | sequence-based invoice_number starting at 5000 |
    matches existing 3000s–4000s manual numbering, stable across
    retries (retry reuses same number via COALESCE), sortable |
    rejected: UUID-prefix (random, breaks visual pattern), per-year
    reset (adds complexity for zero gain) | review-by 2027-11-04`.

### 2. pdfkit dependency
- Edit `package.json`: add `"pdfkit": "^0.15.0"` to `dependencies`.
- Run `npm install` in the worktree to update `package-lock.json`.
- Smoke-import: `node -e "const d = require('pdfkit'); console.log(typeof d)"`.

### 3. `api/_lib/invoice-pdf.js`  (new, ~180 lines)
Pure function `renderInvoicePdf({ order, customer, invoiceNumber, invoiceDate })`
returning a Promise that resolves to a `Buffer`. Layout:

- **Header band** — "Pretzels of Long Island LLC" bold, then
  "118 Broadway, Lynbrook, NY 11563 · 516-459-0954".
- **Invoice-no / date row** — left: `INVOICE NO. {{invoiceNumber}}`,
  right: `invoiceDate` formatted as `NOV 4, 2026`.
- **Bill-To / Store-Address row** — two columns.
  - Bill-To line 1: `customer.organization || customer.contact_name || customer.first_name || '—'`.
  - Bill-To line 2: `customer.pickup_address` if present, else nothing.
  - Store Address (fixed): `118 Broadway, Lynbrook, NY 11563`.
- **Items table** — columns QUANTITY | DATE PERFORMED | UNIT PRICE | TOTAL.
  One row per `order.items[*]`. `DATE PERFORMED` = `order.pickup_date`
  (formatted) on every row; `UNIT PRICE` / `TOTAL` show `$` amounts;
  bonus items show `(free)` in the UNIT PRICE column.
- **Totals block** — `SUBTOTAL` (always), `DISCOUNT` (only when
  `discount_cents > 0`, with promo code in parens), `SALES TAX $0.00`
  (we're tax-exempt in this cut), bold `TOTAL`.

PDF options: Letter page, Helvetica + Helvetica-Bold (built-in), 0.75"
margins. All user-sourced strings pass through a tiny `safePdfText()`
that strips control chars (`[\x00-\x08\x0B-\x1F\x7F]`) before the
`doc.text()` call — defense in depth against anything the form could
have smuggled past the submit path.

Exports: `renderInvoicePdf`, `__test_buildBuffer` (internal, for CI).

### 4. `api/_lib/gmail.js` MIME upgrade
- Extend `buildRaw({ to, subject, html, text, preheader, attachments })`:
  - `attachments` defaults to `[]`. When empty → emit today's
    `multipart/alternative` layout **byte-for-byte unchanged** (so the
    campaign-nurture path stays regression-free).
  - When non-empty → wrap the plain+html alternative in an outer
    `multipart/mixed` boundary; append each attachment as a part with
    `Content-Type: <mime>; name="<file>"`, `Content-Disposition:
    attachment; filename="<file>"`, `Content-Transfer-Encoding: base64`,
    body chunked to 76 chars/line.
- `sendEmail({..., attachments})` passes through unchanged otherwise.
- Export an internal `__test_buildRaw` for a no-attachment snapshot
  check (gated on `NODE_ENV === 'test'` or similar; CI not required
  because there's no test runner, but the export makes a manual smoke
  trivial).

### 5. Wire `api/wholesale/invoice.js`
- **Dry-run branch:** after `renderInvoice(...)`, also call
  `renderInvoicePdf({ order, customer, invoiceNumber: 'DRAFT',
  invoiceDate: new Date() })`. Attach `rendered_pdf_base64:
  buf.toString('base64')` to the response payload. Status untouched.
- **Live branch:** inside the existing CAS UPDATE, additionally set
  `invoice_number: coalesce(invoice_number, nextval(...))`.
  - Since supabase-js can't express `coalesce(col, nextval(seq))` in an
    `.update({})` call, call a small RPC `assign_invoice_number(order_id,
    required_status)` added in the P16 migration — it returns the
    `(invoice_number, status_updated)` pair atomically. The RPC
    performs `UPDATE wholesale_orders SET status='invoiced', invoiced_at,
    invoiced_by, invoice_number = COALESCE(invoice_number,
    nextval('wholesale_invoice_number_seq')) WHERE id=$1 AND
    status=$2 RETURNING invoice_number;` — single statement, atomic.
  - Render PDF with the real number. Pass
    `[{ filename: 'invoice-<n>.pdf', mime: 'application/pdf', content: buffer }]`
    to `sendEmail`.
  - On send failure, roll the status back to `awaiting_payment` as
    today **but leave `invoice_number` in place**. Number is bound; next
    retry sees `invoice_number` already set and reuses it via COALESCE.
  - Response payload gains `invoice_number` (int).

### 6. Dashboard: Download-PDF button
- `ops/wholesale/index.html` (invoice modal):
  - Add `<button class="btn-sm ghost" id="invoice-download-pdf" disabled>Download PDF</button>`
    next to the existing Cancel button.
  - In `openInvoiceModal` success branch: if `d.rendered_pdf_base64`,
    enable the button and wire its click to:
    ```js
    const bin = atob(d.rendered_pdf_base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), {
      href: url, download: `invoice-${currentOrder.id.slice(0,8)}.pdf`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ```
  - Disable on modal close.

### 7. Docs
- Append to `docs/wholesale.md`:
  - A "PDF invoice" subsection under the existing Operator UI section
    naming the template, numbering scheme (sequence starts at 5000),
    where the number comes from (RPC-allocated at CAS time), and the
    MIME structure.
  - Update the `POST /api/wholesale/invoice` row in the shape table to
    note `rendered_pdf_base64` on dry-run and `invoice_number` on live.
  - Add P16 to the migrations list and Rollback section.

## Success criteria

### Quantitative
- CI passes (plan-gate, scope-check, agent-conflicts, test, CodeQL).
- `node -e "require('./api/_lib/invoice-pdf').renderInvoicePdf({ order: FIXTURE, customer: FIXTURE, invoiceNumber: 5000, invoiceDate: new Date() }).then(b => { if (!b.slice(0,5).toString().startsWith('%PDF-')) process.exit(1); })"` succeeds — buffer starts with the PDF magic bytes.
- `node -e "const g = require('./api/_lib/gmail'); const a = g.__test_buildRaw({ to: 'x@y', subject: 's', html: '<p>h</p>', text: 't' }); const b = g.__test_buildRaw({ to: 'x@y', subject: 's', html: '<p>h</p>', text: 't', attachments: [] }); if (a !== b) process.exit(1);"` — no-attachment path is byte-identical to today.
- `supabase/migrations/p16_wholesale_invoice_number.sql` applies cleanly via Supabase MCP and is idempotent (re-apply is a no-op).
- Dry-run response includes non-empty `rendered_pdf_base64`; live response includes an `invoice_number` integer ≥ 5000.
- No new code-scanning alerts (CodeQL).

### Qualitative
- The PDF visually matches the Pretzels of Long Island LLC invoice template (header, invoice-no + date row, two-column Bill-To / Store-Address, items table with QUANTITY · DATE PERFORMED · UNIT PRICE · TOTAL, totals block, bold TOTAL line).
- With `EMAIL_SEND_LIVE_ENABLED` unset: send button still refused with the same `live_disabled_reason`.
- CAS continues to serialize concurrent "Send invoice" clicks: no two emails for the same order; retry after a send failure reuses the first `invoice_number` (verified by log line or a manual re-send against a staged failing SMTP).
- Download-PDF button on the modal produces a valid PDF that opens in Preview / Acrobat.
- Markdown-email body is unchanged (PDF is strictly additive).

## Risks + mitigations

- **PDF size vs. Gmail / Vercel limits.** One-page PDF with built-in fonts is well under 50 KB; Gmail allows 25 MB and the serverless response payload stays under 4.5 MB. No image embedding in this cut.
- **Invoice number collisions on retry.** `invoice_number` is allocated inside the single CAS UPDATE via COALESCE + nextval; the partial unique index enforces no duplicates. Retry after a failed send reuses the already-allocated number.
- **MIME regression in the campaign-nurture path.** `attachments` defaults to `[]`; when empty, `buildRaw` emits the current `multipart/alternative` byte-for-byte. Covered by the `__test_buildRaw` snapshot check above. A regression would surface instantly in the next campaign send (plain-text + HTML stops rendering) rather than silently.
- **Service-account access to attachments.** Gmail's `users.messages.send` accepts the attachment inline in the `raw` field — no extra scope needed beyond today's `gmail.send`. No new credentials, no new secret.
- **`pdfkit` build at Vercel.** Pure JS, no native compilation. Lockfile committed; Vercel's `npm ci` will install exactly the pinned version.

## Rollback
- Revert the PR → Vercel redeploys the previous SHA.
- Migration rollback:
  ```sql
  drop index if exists wholesale_orders_invoice_number_uidx;
  alter table wholesale_orders drop column if exists invoice_number;
  drop sequence if exists wholesale_invoice_number_seq;
  drop function if exists assign_invoice_number(uuid, wholesale_order_status);
  ```

## Escalation
- Any send-path failure that the existing CAS claim cannot cleanly roll back → stop, record root cause in state.md, flag to human. Do not invent a retry policy.
- PDF rendering throws unexpectedly on a specific order → treat as a data bug, escalate with the offending `order.id` (never log PII — redact customer fields).
