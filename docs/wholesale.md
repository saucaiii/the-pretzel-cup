# Wholesale ordering + email tracking

Replaces the external Google Form wholesale flow with an in-house
`/wholesale/` → Stripe Checkout → `/ops/wholesale/` stack.

## Shape

| Path | Who | What |
| --- | --- | --- |
| `/wholesale/` | public | Single-page order form. Pre-fills from `?contact=<uuid>&src=<cta_src>`. |
| `/wholesale/success` | public (session-id gated) | Receipt. Falls back to Stripe's email if the webhook hasn't fired. |
| `POST /api/wholesale/submit` | public | Validates → upserts customer → applies 100-for-25 promo server-side → Stripe Checkout session. |
| `GET /api/wholesale/customer[?id=]` | public | Form bootstrap: active product list + public-safe pre-fill fields only (first_name, organization, pickup_location, pickup_address). |
| `GET /api/wholesale/order?session_id=` | public (session id) | Receipt payload for `/wholesale/success`. |
| `POST /api/wholesale/stripe-webhook` | Stripe | `checkout.session.completed` → paid; `.expired` → cancelled. |
| `GET /api/wholesale/list` | operator | Recent orders + filters. |
| `GET /api/wholesale/metrics` | operator | Revenue + funnel. |
| `POST /api/campaigns/send` | internal (`CRON_SECRET`) | Dry-run or live-send a specific campaign email. |
| `GET /api/track/open?s=` | public | 1×1 GIF, stamps `opened_at` once. |
| `GET /api/track/click?s=&u=` | public | Click redirect with hard destination allowlist. |
| `/ops/wholesale/` | operator | Three-tab dashboard: Orders · Revenue · Funnel. |

## Data model

Six tables in `supabase/migrations/p14_wholesale.sql`:
`wholesale_products`, `wholesale_customers`, `wholesale_campaigns`,
`wholesale_campaign_emails`, `wholesale_email_sends`, `wholesale_orders`.
All uuid PK, `timestamptz`, `citext` emails. RLS enabled: API routes
use the service role (bypasses RLS); the two anon policies on
`wholesale_orders` are a safety net for a future direct-from-browser
flow and rely on `stripe_session_id` being unguessable.

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Shared. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Shared. |
| `STRIPE_SECRET_KEY` | yes | Shared. `sk_test_…` for dev. |
| `STRIPE_WEBHOOK_SECRET` | yes | Shared. New webhook endpoint → new whsec. |
| `GOOGLE_SHEET_KEY_B64` | yes | Shared with `_lib/sheet.js`. Must also be shared with the Gmail delegation (see below). |
| `CRON_SECRET` | yes (for sends) | Bearer token for `/api/campaigns/send`. |
| `EMAIL_SEND_LIVE_ENABLED` | optional | Set to the literal string `true` to allow live sends. Default: live sends refused. |
| `WHOLESALE_BASE_URL` | optional | Overrides base URL in tracking links / Stripe success URLs. Falls back to `https://${VERCEL_URL}`, then `http://localhost:3000`. |

**Add to `.env.example` (names only, no values; the policy blocks
agents from editing `.env.example` directly):**

```
EMAIL_SEND_LIVE_ENABLED=   # literal "true" to allow /api/campaigns/send to actually transmit
WHOLESALE_BASE_URL=        # https://the-pretzel-cup.vercel.app in prod; omit for local
```

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

### 3. Local Stripe test

```
# Terminal 1
vercel dev

# Terminal 2
stripe listen --forward-to localhost:3000/api/wholesale/stripe-webhook
# Grab the whsec_… and export it as STRIPE_WEBHOOK_SECRET for the dev shell.
```

Then:

- Open http://localhost:3000/wholesale/
- Fill the form, use the Stripe test card `4242 4242 4242 4242`,
  any future expiry, any CVC and ZIP.
- Confirm the order shows `paid` in `/ops/wholesale/`.
- Confirm the Stripe test receipt arrived (Stripe's own, not ours
  yet).

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

## Verification matrix

Phase 6 of the task calls for:
- [ ] Migration applies on fresh schema.
- [ ] Seed runs twice with 0 duplicates (idempotent upserts).
- [ ] Test order through `/wholesale/` → Stripe test card → `paid` in `/ops/wholesale/`.
- [ ] Dry-run Email 1 writes `N` placeholder rows, returns a sample HTML that matches the template.
- [ ] A tracking click increments `click_count` and 302s to the right destination.
- [ ] A tracking open sets `opened_at` on the first hit only.
- [ ] Operator filter by promo code produces a revenue roll-up matching the raw rows.
- [ ] Function count: `find api -name '*.js' -not -path 'api/_lib/*' | wc -l` returns 22 (12 existing + 10 new); within Vercel Pro's 100-fn cap.
- [ ] No `.env` secrets or real customer emails appear in any commit.

## Rollback

- Phase 1 (migration): `drop table` the six new tables (no FK to
  existing data, so cascade is safe).
- Phases 2–5: `git revert` the PR merge commit. Vercel redeploys the
  previous SHA.
- Deploy itself is human-only via `npm run deploy`.
