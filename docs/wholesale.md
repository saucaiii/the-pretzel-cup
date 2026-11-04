# Wholesale ordering + email tracking

Replaces the external Google Form wholesale flow with an in-house
`/wholesale/` form, a server-authoritative 100-for-25 promo preview,
attribution back to the specific nurture-email send that drove the
order, and an operator dashboard at `/ops/wholesale/`.

Payment collection is **manual** in this version — the form captures
the order and the operator invoices the customer via their existing
channel (email, mail, etc.). The stripe_session_id /
stripe_payment_intent_id columns on `wholesale_orders` are retained
as nullable so a future payment-processor integration can slot in
without another migration.

## Shape

| Path | Who | What |
| --- | --- | --- |
| `/wholesale/` | public | Single-page order form. Pre-fills from `?contact=<uuid>&src=<cta_src>`. |
| `/wholesale/success?o=<order_id>` | public (order-id gated) | Receipt. "Invoice coming shortly" copy. |
| `POST /api/wholesale/submit` | public | Validates → upserts customer → applies 100-for-25 promo server-side → inserts order (status `awaiting_payment`) → returns `{ ok, order_id, success_url }`. |
| `GET /api/wholesale/customer[?id=<uuid>]` | public | Form bootstrap: active product list + public-safe pre-fill fields only. |
| `GET /api/wholesale/order?o=<order_id>` | public (unguessable uuid); operator session upgrades payload | Receipt payload for `/wholesale/success`. Operator caller gets audit columns + an `email_history` array (campaign sends this customer has received). |
| `PATCH /api/wholesale/order?o=<order_id>` | operator | Advance a wholesale order's status. Body `{status}`. Server-side transition table rejects invalid moves with 409. Stamps the matching audit column + operator id. |
| `POST /api/wholesale/invoice?o=<order_id>` | operator | Build + preview or send the invoice email **with a PDF invoice attached**. Body `{dry_run: true\|false}`. Dry-run returns `rendered_html` + `rendered_pdf_base64` (the Download-PDF button in the modal consumes it). Live is refused unless `EMAIL_SEND_LIVE_ENABLED=true`; on success it advances the order to `invoiced` (only when it was still `awaiting_payment`), allocates/reuses a sequential `invoice_number`, and returns it on the response. |
| `GET /api/wholesale/list` | operator | Recent orders + filters. |
| `GET /api/wholesale/metrics` | operator | Revenue + funnel (revenue is based on orders operators have marked `paid`). |
| `POST /api/campaigns/send` | internal (`CRON_SECRET`) **or** operator (session cookie) | Dry-run or live-send a specific campaign email. Operator-auth path powers the dashboard's Preview / Dry-run / Send-now buttons. |
| `GET /api/track/open?s=` | public | 1×1 GIF, stamps `opened_at` once. |
| `GET /api/track/click?s=&u=` | public | Click redirect with hard destination allowlist. |
| `/ops/wholesale/` | operator | Three-tab dashboard: Orders · Revenue · Funnel. |

## Data model

Six tables in `supabase/migrations/p14_wholesale.sql`:
`wholesale_products`, `wholesale_customers`, `wholesale_campaigns`,
`wholesale_campaign_emails`, `wholesale_email_sends`, `wholesale_orders`.
All uuid PK, `timestamptz`, `citext` emails. RLS on every table, no
anon policies — API routes use the service role.

`supabase/migrations/p15_wholesale_order_audit.sql` adds the
`invoiced` status value and five nullable audit columns on
`wholesale_orders`: `invoiced_at`, `invoiced_by`, `cancelled_at`,
`cancelled_by`, `paid_by`. Each `_by` is a nullable FK to
`public.people(id)` with `ON DELETE SET NULL` so audit rows outlive an
operator removal.

`supabase/migrations/p16_wholesale_invoice_number.sql` adds the
`wholesale_invoice_number_seq` sequence (starts at 5000, above the
existing 3000s-4000s manual invoice numbers), a nullable
`invoice_number int` column on `wholesale_orders` with a partial
unique index (NULLs allowed on historical rows, uniqueness enforced
on allocated values), and the `assign_invoice_number(order_id,
required_from, invoiced_by, invoiced_at)` RPC that performs the
CAS-claim and sequence allocation in one atomic UPDATE (COALESCE on
retry so a resend after a failed Gmail call reuses the same number).

## Order lifecycle (manual invoicing)

```
customer submits /wholesale/
            │
            ▼
    status = 'awaiting_payment'   ← default after submit
            │
            │  operator reviews in /ops/wholesale/
            │  ↳ "Mark invoiced" → optional live email (dry-run default)
            ▼
    status = 'invoiced'           ← operator has invoiced the customer
            │
            │  customer sends payment via their usual channel
            ▼
    status = 'paid'               ← operator "Mark paid" after check/ACH

    status = 'cancelled'          ← operator "Cancel" from any live state
```

Dashboard supports all transitions directly from the order drawer.
Each transition stamps `<state>_at` + `<state>_by` (operator's
`people.id`). The server-side table rejects invalid moves with 409:

| From               | Allowed next                        |
| ------------------ | ----------------------------------- |
| `awaiting_payment` | `invoiced`, `paid`, `cancelled`     |
| `invoiced`         | `paid`, `cancelled`                 |
| other              | none (via this endpoint)            |

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Shared with the rest of the app. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Shared. |
| `GOOGLE_SHEET_KEY_B64` | yes | Shared with `_lib/sheet.js`. Also used by the Gmail sender. |
| `CRON_SECRET` | yes (for sends) | Bearer token for `/api/campaigns/send`. |
| `EMAIL_SEND_LIVE_ENABLED` | optional | Set to the literal string `true` to allow live sends (campaign nurture AND operator-triggered invoice emails). Default: refused. |
| `WHOLESALE_BASE_URL` | optional | Overrides base URL in tracking links / success-page redirects. Falls back to `https://${VERCEL_URL}`, then `http://localhost:3000`. |
| `WHOLESALE_INVOICE_PAYMENT_HELP` | optional | Free-form markdown that renders inside the invoice email's "Payment" block (where to send payment, who to make the check out to, etc.). Default: `"We'll follow up with payment details shortly."` so an unconfigured install never implies wire details that aren't there. |

The env template in the repo root doesn't yet include the two new
`EMAIL_SEND_LIVE_ENABLED=` / `WHOLESALE_BASE_URL=` variables because
the policy hook blocks the agent from editing it. Append those two
lines (names only, no values) yourself before the first production
deploy.

## Setup

### 1. Apply the migration

```
psql $SUPABASE_URL -f supabase/migrations/p14_wholesale.sql
```

Or paste into the Supabase SQL editor. Safe to re-run.

### 2. Seed products, campaign, emails, and customers

The seed is idempotent and reads customers live from the wholesale
lead-form Google Sheet. Grant the service account **Viewer** access
first:

- Sheet: `1Br-5b7Sl3-3OKB4q4Xs8mqAM_6vl_DBijbXzf9cq8eA`, tab `Wholesale`
- Add the `client_email` from your `GOOGLE_SHEET_KEY_B64` service
  account JSON as a Viewer.

Then from the repo root:

```
node --env-file=.env scripts/seed-wholesale.mjs           # dry run
node --env-file=.env scripts/seed-wholesale.mjs --apply   # write
```

Dry run reports what would land. Customer emails and names are never
printed — counts only.

Expected after `--apply`:
- 7 `wholesale_products` rows
- 1 `wholesale_campaigns` row (`winter-2026-27`)
- 6 `wholesale_campaign_emails` rows (positions 1–6)
- N `wholesale_customers` rows (one per unique email in the sheet)

### 3. End-to-end order test (no Stripe required)

With `vercel dev` running:

- Open http://localhost:3000/wholesale/
- Fill the form, click **Place order**
- Expect a redirect to `/wholesale/success?o=<uuid>` showing items,
  total, and "an invoice will land in your inbox shortly" copy.
- Confirm the order appears in `/ops/wholesale/` with status
  `awaiting payment`.

### 4. Campaign dry-run

The sender refuses live sends unless `EMAIL_SEND_LIVE_ENABLED=true`.
Dry-run writes placeholder rows (`sent_at=null, notes='dry_run'`)
and returns rendered HTML for one sample customer. Those rows get
upgraded in place by a subsequent live run.

```
curl -X POST http://localhost:3000/api/campaigns/send?dry_run=true \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"campaign_slug":"winter-2026-27","email_position":1}'
```

Expected response shape:

```
{
  "mode": "dry_run",
  "eligible": N,
  "sent":     N,
  "skipped":  0,
  "errors":   [],
  "sample_html": "...rendered HTML of the first customer's email..."
}
```

Confirm `select count(*) from wholesale_email_sends where campaign_email_id = <id> and notes = 'dry_run';` matches `eligible`.

### 5. Enabling live sends (production)

Two things must both be true, both are HUMAN steps:

**(a) Set `EMAIL_SEND_LIVE_ENABLED=true` in the Vercel project env.**

**(b) Configure Gmail API delegation on the `From:` address.** The
sender uses JWT subject-impersonation with the shared service account
to send **as** `mcaiazzoppffs@gmail.com`.

- If the From address is a **Google Workspace** user: configure
  domain-wide delegation in the Workspace admin console under
  Security → Access and data control → API controls → Manage domain-
  wide delegation. Add the service account's client-id with the one
  scope `https://www.googleapis.com/auth/gmail.send`. Then, in the
  Workspace Gmail settings for the From user, enable API access to
  this scope. Google's docs:
  https://developers.google.com/workspace/gmail/api/auth/service-account
- If the From address is a **personal `@gmail.com`**: service-account
  impersonation is not supported for consumer Gmail. Switch to OAuth
  with a stored refresh token: run a one-time consent flow with the
  From user, store the refresh token in a new env var, and replace
  `api/_lib/gmail.js`'s JWT auth with
  `google.auth.OAuth2(client_id, client_secret, redirect)` +
  `.setCredentials({ refresh_token })`. This is a code change, not a
  config change — flag it as a follow-up before the first live send.

Once (a) and (b) are both in place, re-run the same curl with
`?dry_run=false`. Dry-run rows already queued for that email get
upgraded in place (sent_at stamped, notes cleared on success; or
bounced_at stamped with the error reason on failure, no retry).

## Operator UI (dashboard)

`/ops/wholesale/` has three tabs — Orders, Revenue, Funnel.

- **Orders** → row click opens the drawer. The drawer carries three
  action buttons (Mark invoiced / Mark paid / Cancel), each disabled
  when the current status doesn't allow the move, plus the customer's
  **Email history** (every campaign send they've received, with send /
  open / click timestamps).
- **Mark invoiced** opens an invoice modal: a sandboxed iframe preview
  of the rendered HTML, the destination email, and four buttons —
  **Send invoice** (live), **Just mark invoiced** (status change only,
  no email), **Download PDF** (saves the dry-run PDF locally for
  operator review), and **Cancel**. The live path is refused unless
  `EMAIL_SEND_LIVE_ENABLED=true` and the modal surfaces the reason.
  The live send **attaches a PDF invoice** to the Gmail message (see
  "PDF invoice" below).
- **Funnel** → per campaign-email row: **Preview** (opens a sandboxed
  iframe with the rendered HTML for the first eligible customer),
  **Dry-run** (writes placeholder send rows and reports counts inline),
  **Send now** (type-the-slug confirmation modal, then live send).

The dashboard calls `/api/campaigns/send` with the operator's session
cookie — no bearer token needed from the browser. The cron
bearer path is unchanged and still powers scheduled sends.

## PDF invoice

The live `Send invoice` path attaches a server-generated PDF to the
Gmail message. The PDF is rendered by `api/_lib/invoice-pdf.js` using
`pdfkit` (pure JS, built-in Helvetica — no font files are shipped and
no network fetches happen at render time) and matches the Pretzels of
Long Island LLC invoice template:

- Header: `Pretzels of Long Island LLC · 118 Broadway, Lynbrook, NY
  11563 · 516-459-0954`.
- Invoice-no / date row: left `INVOICE NO. <n>`, right date as
  `MON D, YYYY`.
- Bill-To / Store-Address two-column block. Bill-To line 1 =
  `organization || contact_name || first_name`; line 2 =
  `pickup_address` when set. Store Address is the fixed Lynbrook
  address.
- Line items table: `QUANTITY · DATE PERFORMED · UNIT PRICE · TOTAL`.
  `DATE PERFORMED` is `order.pickup_date` on every row. Bonus
  (100-for-25 promo) rows show "(free)" in the unit-price column.
- Totals block: SUBTOTAL, DISCOUNT (only when `discount_cents > 0`,
  with the promo code in parens), SALES TAX `$0.00`, bold TOTAL.

### Numbering

Invoice numbers are allocated from the `wholesale_invoice_number_seq`
sequence (starts at 5000). Allocation happens inside the same
`UPDATE` that CAS-claims the order's transition to `invoiced` —
`invoice_number = COALESCE(invoice_number,
nextval('wholesale_invoice_number_seq'))`. That means:

- Two operators racing on *Send invoice* produce one winner and one
  409; only the winner's PDF goes out, with one number burned.
- If the Gmail send fails, the status rolls back to
  `awaiting_payment` but the already-allocated `invoice_number` stays
  on the row. The next retry sees it set and reuses it — the customer
  never receives two different invoice numbers for the same order.
- Historical orders (pre-P16) have `invoice_number = NULL`; the
  partial unique index allows this.

### MIME shape

`api/_lib/gmail.js` emits `multipart/mixed` only when the caller
passes a non-empty `attachments` array — the campaign-nurture send
path (no attachments) stays on `multipart/alternative` byte-for-byte
(modulo the random boundary string). The attachment part carries
`Content-Type: application/pdf; name="invoice-<n>.pdf"`,
`Content-Disposition: attachment; filename="invoice-<n>.pdf"`, and
base64-encoded content wrapped at 76 chars/line per RFC 2045.

### Dry-run preview

The dashboard's invoice modal calls the endpoint with `dry_run: true`
and renders both the HTML preview (sandboxed iframe) and the PDF
(via the Download PDF button, which turns the `rendered_pdf_base64`
field into a local Blob and triggers a browser download named
`invoice-<order-prefix>.pdf`). Nothing is sent and no status change
happens. On dry-run, `invoice_number` shows `DRAFT` unless the order
has already been invoiced (in which case the real number is shown).

## Follow-up

- Column-P/Q cleanup on the old wholesale lead form (credit-card
  cleartext — PCI exposure, out of scope here).
- Persistent audit trail for **invoice sends**. Today an invoice send
  only leaves a mark on `wholesale_orders.invoiced_at` /
  `invoiced_by` (one per order). Bounces, retries, and sends that
  the status flip missed are not individually auditable the way
  campaign sends are through `wholesale_email_sends`. A follow-up
  migration could either add a dedicated `wholesale_invoice_sends`
  table or repurpose `wholesale_email_sends` with a nullable
  `campaign_email_id` and a `kind` discriminator.

## Rollback

- P14 migration: `drop table` the six new tables (no FK into
  existing data).
- P15 migration: drop the five audit columns; the `'invoiced'` enum
  value cannot be removed in Postgres without a type rebuild and can
  safely stay in place after rollback.
  ```sql
  alter table wholesale_orders
    drop column invoiced_at,
    drop column invoiced_by,
    drop column cancelled_at,
    drop column cancelled_by,
    drop column paid_by;
  ```
- P16 migration:
  ```sql
  drop function if exists assign_invoice_number(uuid, wholesale_order_status, uuid, timestamptz);
  drop index if exists wholesale_orders_invoice_number_uidx;
  alter table wholesale_orders drop column if exists invoice_number;
  drop sequence if exists wholesale_invoice_number_seq;
  ```
- Code: `git revert` the PR merge commit; Vercel redeploys the
  previous SHA.
