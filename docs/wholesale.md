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
| `GET /api/wholesale/order?o=<order_id>` | public (unguessable uuid) | Receipt payload for `/wholesale/success`. |
| `GET /api/wholesale/list` | operator | Recent orders + filters. |
| `GET /api/wholesale/metrics` | operator | Revenue + funnel (revenue is based on orders operators have marked `paid`). |
| `POST /api/campaigns/send` | internal (`CRON_SECRET`) | Dry-run or live-send a specific campaign email. |
| `GET /api/track/open?s=` | public | 1×1 GIF, stamps `opened_at` once. |
| `GET /api/track/click?s=&u=` | public | Click redirect with hard destination allowlist. |
| `/ops/wholesale/` | operator | Three-tab dashboard: Orders · Revenue · Funnel. |

## Data model

Six tables in `supabase/migrations/p14_wholesale.sql`:
`wholesale_products`, `wholesale_customers`, `wholesale_campaigns`,
`wholesale_campaign_emails`, `wholesale_email_sends`, `wholesale_orders`.
All uuid PK, `timestamptz`, `citext` emails. RLS on every table, no
anon policies — API routes use the service role.

## Order lifecycle (manual invoicing)

```
customer submits /wholesale/
            │
            ▼
    status = 'awaiting_payment'   ← default after submit
            │
            │  operator reviews in /ops/wholesale/, sends invoice
            │  via their usual channel (email, mail, …)
            ▼
    status = 'paid'               ← operator marks after check / ACH clears
                                    (dashboard action — follow-up PR)

    status = 'cancelled'          ← operator cancels at any point
```

The dashboard today **displays** orders at every status but does not
yet include UI buttons for the operator to transition state — that
lands in a follow-up PR (along with the invoice-template workflow).
Operators can transition status directly in Supabase as a stopgap.

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Shared with the rest of the app. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Shared. |
| `GOOGLE_SHEET_KEY_B64` | yes | Shared with `_lib/sheet.js`. Also used by the Gmail sender. |
| `CRON_SECRET` | yes (for sends) | Bearer token for `/api/campaigns/send`. |
| `EMAIL_SEND_LIVE_ENABLED` | optional | Set to the literal string `true` to allow live sends. Default: refused. |
| `WHOLESALE_BASE_URL` | optional | Overrides base URL in tracking links / success-page redirects. Falls back to `https://${VERCEL_URL}`, then `http://localhost:3000`. |

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

## Follow-up

- Operator UI for status transitions in `/ops/wholesale/` (buttons
  for Mark invoiced / Mark paid / Cancel on the row drawer).
- Invoice template + automated send via Gmail using the same delegation
  setup as the nurture emails.
- Column-P/Q cleanup on the old wholesale lead form (credit-card
  cleartext — PCI exposure, out of scope here).

## Rollback

- Phase 1 migration: `drop table` the six new tables (no FK into
  existing data).
- Code: `git revert` the PR merge commit; Vercel redeploys the
  previous SHA.
