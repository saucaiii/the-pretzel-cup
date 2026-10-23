# Payment Flow — design doc

Automated invoice settlement for 7-Eleven store managers using the client
portal defined in [store-portal.md](./store-portal.md). Stripe ACH Debit
via Plaid, pulled at PPF's discretion on a weekly or monthly cadence.
Operator reviews drafts in a batch-approval queue before pulls fire.

**Supersedes** the "Not in scope v1: Payments / card-on-file" line in
`store-portal.md` §Scope. Payments are now in v1. Invoices are no longer
"reference only" — they're billable and settle through Stripe.

Toast remains PPF's existing POS/AR system for everything it does today.
This flow runs separately. No Toast integration in v1. (See research
findings in session scoping notes: Toast has no invoice API, no stored
ACH mandates, no payment-event webhook — it can't drive this flow.)

---

## Scope (locked)

| Decision | Choice |
| --- | --- |
| Rail | **Stripe ACH Debit** via **Plaid Link** (Stripe-hosted). No card option in v1. |
| Opt-in | **Per-stop.** Each stop is `cash` (default, no settlement) or `electronic` (opted in to Stripe pull). |
| Cadence | **Weekly default.** Monthly available per-stop. Operator sets cadence in `/ops`. Portal nudges weekly stops to switch to monthly ("~$X/yr in fees saved"). |
| Fee burden | **PPF absorbs.** Managers see the invoice total; no surcharge line. ACH only, so fees are 0.8% capped at $5/pull. |
| Invoice origin | **Operator-reviewed draft** for v1. Graduate to **fully automatic** later once trust is built. |
| Approval UX | **Batch approval with cutoff.** Drafts generated at cycle boundary; operator has until a cutoff to flag anomalies; everything untouched at cutoff auto-approves and pulls. |
| Pull trigger | **PPF-initiated.** Managers do not click "pay now" — approved invoices charge automatically via saved ACH mandate. |
| System of record | **Our Supabase.** Stripe is the money mover; our DB owns invoice state. Webhooks reconcile. |

Not in scope v1:
- Card payments (Stripe Issuing / Checkout). ACH only.
- Mirror paid status back into Toast's AR module. v2 nice-to-have, manual for now.
- Franchise-group billing (one invoice spanning multiple stops). Each stop invoices separately.
- Manager-initiated early payment ("pay now" button). Pulls happen on cadence.
- Automated cadence conversion (weekly → monthly). Operator flips it manually.
- Partial payments, credits, refunds. v2 if needed; for v1 the operator voids and re-issues.

---

## Hosting + function budget

The portal spec lands at 12 / 12 functions. This spec adds **zero**
new functions by folding every new endpoint into existing dispatchers:

- **Store-manager Stripe endpoints** → `/api/store.js` under new `?resource=` branches (`payment-setup`, `payment-method`, `invoices`).
- **Operator approval endpoints** → `/api/schedule.js` under new `?resource=` branches (`pending-invoices`, `approve-invoice`, `void-invoice`).
- **Stripe webhook** → `/api/store.js` under `?resource=stripe-webhook`. Branch skips the `role=store` cookie gate and validates Stripe signature instead. Webhook URL is `https://the-pretzel-cup.vercel.app/api/store?resource=stripe-webhook`.
- **Cron for draft generation** → Vercel Cron (Hobby allows 2 jobs; use one). Target is `/api/schedule.js?resource=generate-drafts` with a Vercel-cron bearer secret. Runs weekly Sun 23:00 ET; a lightweight day-of-month check inside the handler also runs monthly drafts on the 1st.

Final: 12 functions, same cap.

---

## Schema diff — `supabase/migrations/p7_payment_flow.sql`

### Alter `stops`

```sql
alter table public.stops
  add column if not exists payment_mode       text not null default 'cash'
    check (payment_mode in ('cash','electronic')),
  add column if not exists billing_cadence    text
    check (billing_cadence in ('weekly','monthly')),
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_pm_id       text,            -- ACH payment method
  add column if not exists plaid_connected_at timestamptz,
  add column if not exists payment_notes      text;            -- operator-only notes
```

Rules enforced at the API layer, not in SQL (keep the constraint simple):
- When `payment_mode = 'electronic'`, `billing_cadence` must be set.
- When `payment_mode = 'cash'`, Stripe/Plaid columns stay null.
- A stop with `payment_mode = 'electronic'` but no `stripe_pm_id` is "opted in but not yet connected" — portal shows the Connect Bank CTA.

### New table — `invoices`

```sql
create type invoice_status as enum
  ('draft','approved','processing','paid','failed','void');

create table if not exists public.invoices (
  id                     uuid primary key default gen_random_uuid(),
  stop_id                uuid not null references public.stops(id) on delete restrict,
  period_start           date not null,
  period_end             date not null,                       -- inclusive
  cadence                text not null check (cadence in ('weekly','monthly')),
  singles_count          int  not null default 0,
  doubles_count          int  not null default 0,
  singles_cents          int  not null default 0,             -- extended total
  doubles_cents          int  not null default 0,
  total_cents            int  not null,                       -- singles + doubles
  status                 invoice_status not null default 'draft',
  stripe_invoice_id      text,
  stripe_payment_intent  text,
  created_at             timestamptz not null default now(),
  approved_at            timestamptz,
  approved_by            uuid references public.people(id) on delete set null,
  pulled_at              timestamptz,                         -- when charge attempted
  paid_at                timestamptz,
  failed_at              timestamptz,
  voided_at              timestamptz,
  failure_code           text,
  failure_message        text,
  unique (stop_id, period_start, period_end)
);

create index if not exists invoices_stop_period_idx
  on public.invoices (stop_id, period_end desc);
create index if not exists invoices_status_idx
  on public.invoices (status) where status in ('draft','approved','processing','failed');
```

### New table — `invoice_payments`

Separate so a failed-then-retried pull keeps full history.

```sql
create table if not exists public.invoice_payments (
  id                        uuid primary key default gen_random_uuid(),
  invoice_id                uuid not null references public.invoices(id) on delete cascade,
  stripe_payment_intent_id  text not null,
  status                    text not null,                    -- 'processing','succeeded','failed'
  amount_cents              int not null,
  attempted_at              timestamptz not null default now(),
  settled_at                timestamptz,
  error_code                text,
  error_message             text,
  unique (stripe_payment_intent_id)
);
create index if not exists invoice_payments_invoice_idx
  on public.invoice_payments (invoice_id, attempted_at desc);
```

### RLS

Deny-all on both new tables. All access via service role.

---

## Stripe account setup (one-time, operator does)

Prereq: PPF Stripe account exists and ACH Debit is enabled.

1. **Enable ACH Debit** in Stripe dashboard → Settings → Payment methods → ACH direct debit → turn on. Requires US bank account on file for PPF.
2. **Enable Plaid** for instant bank verification. Stripe hosts the Plaid relationship — no separate Plaid account needed. Settings → Payment methods → ACH direct debit → "Enable instant verification with Plaid".
3. **Create a webhook endpoint.** Dashboard → Developers → Webhooks → add endpoint `https://the-pretzel-cup.vercel.app/api/store?resource=stripe-webhook`. Subscribe to:
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice.finalization_failed`
   - `payment_intent.processing`
   - `setup_intent.succeeded`
4. **Copy the webhook signing secret** into `STRIPE_WEBHOOK_SECRET` env var.
5. **Copy the restricted API key** (not the full secret key — restrict to Customers, PaymentMethods, SetupIntents, Invoices, PaymentIntents, Webhooks) into `STRIPE_SECRET_KEY`.
6. **Copy the publishable key** into `STRIPE_PUBLISHABLE_KEY` for the portal client.

Env vars go in Vercel project settings. `.env.development.local` for local dev.

---

## Flow 1 — Opt a store in (operator)

1. Operator opens `/ops/stops`, selects a 7-Eleven location.
2. Operator sets `payment_mode = 'electronic'` and `billing_cadence = 'weekly'` or `'monthly'`.
3. API endpoint `POST /api/schedule?resource=stop-payment-settings` persists the change. If this is the first time, it also calls Stripe `customers.create({ name: display_name, email: contact_email, metadata: { stop_id } })` and stores `stripe_customer_id`.
4. Operator tells the store manager "you'll see a Connect Bank button in your portal — click it when you're ready."

## Flow 2 — Manager connects bank (manager)

1. Portal dashboard shows a "Connect Bank" banner when `payment_mode='electronic'` and `stripe_pm_id is null`.
2. Manager clicks → portal calls `POST /api/store?resource=payment-setup` → backend creates a `SetupIntent`:
   ```js
   const si = await stripe.setupIntents.create({
     customer: stop.stripe_customer_id,
     payment_method_types: ['us_bank_account'],
     payment_method_options: {
       us_bank_account: { verification_method: 'instant' }, // Plaid
     },
   });
   return { client_secret: si.client_secret };
   ```
3. Frontend uses Stripe.js `stripe.collectBankAccountForSetup()` which opens Plaid Link.
4. Manager auths with their bank.
5. On success, Stripe fires `setup_intent.succeeded` webhook → backend records `stripe_pm_id`, `plaid_connected_at` on the stop row.
6. Portal refreshes; banner replaced with "Bank account connected" status card showing last 4 digits of account.

## Flow 3 — Draft generation (cron)

Runs **weekly Sunday 23:00 ET** via Vercel Cron. Handler at `/api/schedule?resource=generate-drafts` with a `CRON_SECRET` bearer check.

Logic:
```
weekly_period = (prev_monday ... prev_sunday)
for each stop where payment_mode='electronic' and billing_cadence='weekly':
  aggregate returns for weekly_period
  if singles_count + doubles_count == 0: skip (don't create zero-dollar invoice)
  upsert invoice (status='draft')

if today is day 1 of month:
  monthly_period = (first ... last of prev month)
  for each stop where payment_mode='electronic' and billing_cadence='monthly':
    aggregate returns for monthly_period
    if zero: skip
    upsert invoice (status='draft')
```

The upsert uses `(stop_id, period_start, period_end)` unique key — re-running the cron on the same period is idempotent and refreshes figures if `returns` was corrected.

**Pricing** reads from the existing stop price fields (or `products` table, whichever the current ops stack uses). Not duplicated here.

## Flow 4 — Operator review (operator)

New tab on `/ops`: **Pending Invoices**.

- Fetches `GET /api/schedule?resource=pending-invoices`.
- Payload: list of draft + failed invoices, each with:
  ```ts
  { id, stop: { name, town, display_name }, period_start, period_end,
    cadence, singles_count, doubles_count, total_cents, status, created_at }
  ```
- Each row has `[Approve]` `[Void]` buttons; "Approve all" at the top for batch.
- Approve calls `POST /api/schedule?resource=approve-invoice` with `{ invoice_id }`. Backend:
  1. Loads the invoice + stop (checks `stripe_customer_id`, `stripe_pm_id` are both set — if not, mark as failed with code `no_payment_method`).
  2. Creates a Stripe Invoice:
     ```js
     const inv = await stripe.invoices.create({
       customer: stop.stripe_customer_id,
       default_payment_method: stop.stripe_pm_id,
       collection_method: 'charge_automatically',
       auto_advance: true,
       metadata: { local_invoice_id: invoice.id, stop_id: stop.id },
     });
     if (singles_count > 0)
       await stripe.invoiceItems.create({
         customer: stop.stripe_customer_id,
         invoice: inv.id,
         quantity: singles_count,
         unit_amount: SINGLE_PRICE_CENTS,
         description: `Soft pretzel (single) × ${singles_count}`,
       });
     // same for doubles
     await stripe.invoices.finalizeInvoice(inv.id);
     ```
  3. Updates local row: `status='approved'`, `approved_at=now()`, `approved_by=sess.sub`, `stripe_invoice_id=inv.id`.
  4. Stripe `auto_advance: true` triggers the charge within ~1 hour of finalization. Local row transitions to `processing` → `paid`/`failed` via webhook.
- Void calls `POST /api/schedule?resource=void-invoice` → sets local status to `void`. If a Stripe invoice already exists, call `stripe.invoices.voidInvoice()`.

**Auto-approval cutoff.** A cron check runs on cutoff days (Wed 23:00 ET weekly, 5th 23:00 ET monthly) and auto-approves any lingering drafts for stops with a valid payment method. Env flag `AUTO_APPROVE_ENABLED=1` must be set to arm the auto-approver — defaults off during initial rollout so the operator stays in the loop until trust builds.

## Flow 5 — Stripe webhook (public endpoint)

`/api/store?resource=stripe-webhook` branch, before any cookie-based auth:

```js
if (resource === 'stripe-webhook') {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  await handleStripeEvent(event);
  return res.status(200).json({ received: true });
}
```

Handled events:

| Event | Action |
| --- | --- |
| `setup_intent.succeeded` | Pull `payment_method` + `customer` from event. Find stop by `stripe_customer_id`. Update `stripe_pm_id`, `plaid_connected_at`. |
| `invoice.paid` | Find local invoice by `stripe_invoice_id`. Status → `paid`, `paid_at=now()`. Insert `invoice_payments` row. |
| `invoice.payment_failed` | Status → `failed`, `failed_at=now()`, store `failure_code` + `failure_message`. Insert `invoice_payments` row with `status='failed'`. Notify operator via Telegram (`_lib/telegram.js`). |
| `invoice.finalization_failed` | Status → `failed`. Rare; usually a Stripe config issue. |
| `payment_intent.processing` | Status → `processing`, `pulled_at=now()`. ACH takes 1–3 business days to clear. |

Idempotency: use the Stripe `event.id` as a dedupe key (small cache or `insert ... on conflict do nothing` into a `stripe_events` table — add if needed). For v1, the status-transition checks (`status='processing' → 'paid'` only, not `'paid' → 'paid'`) are enough; Stripe retries are idempotent naturally.

Raw body: Vercel's Node runtime needs `export const config = { api: { bodyParser: false } }` for the webhook branch, OR the function reads `req` as a stream before Vercel parses. Easiest: use a conditional raw-body read when the first query param check matches `stripe-webhook`.

## Flow 6 — Manager views invoices (manager)

New endpoint `GET /api/store?resource=invoices&limit=12` returns the last 12 invoices for the signed-in stop:

```ts
[{
  id, period_start, period_end, cadence, status,
  singles_count, doubles_count, total_cents,
  paid_at, failed_at, failure_message
}]
```

New route `/store/billing.html`:
- Lists invoices with status chips (`Paid`, `Processing`, `Failed`, `Scheduled`, `Void`).
- Each row expands to show line items.
- "Connect Bank" CTA at top if not connected.
- Cadence selector (weekly/monthly) — self-serve? **No for v1.** Portal shows current cadence but changes require operator action. (Rationale: operator wants to control cadence while rolling this out.)
- "Switch to monthly" nudge banner for weekly stops: *"Your weekly invoices average $X. Switching to monthly saves ~$Y/year in processing fees. Ask us to switch."*

Linked from the dashboard footer, replacing the current "Download invoice" link which was reference-only.

## Flow 7 — Failed-payment recovery (operator)

Pending Invoices tab also shows `status='failed'` invoices. Each has:
- `[Retry]` — creates a new PaymentIntent on the same invoice (`stripe.invoices.pay(id)`), inserts a new `invoice_payments` row. Only visible if the failure is retriable (not `account_closed`).
- `[Mark paid manually]` — operator confirms payment was received outside Stripe (check, cash catch-up). Sets `status='paid'`, `paid_at=now()`, no Stripe side-effect.
- `[Void]` — write off.

Common failure codes:
- `insufficient_funds` → retriable after 48h
- `account_closed` / `no_account` → not retriable; disconnect and reconnect bank
- `debit_not_authorized` → requires manager to re-auth via Plaid

---

## Reconciliation + ACH ops hygiene

The hard part of a billing system isn't pulling money — it's proving a
week later that every dollar that was supposed to arrive actually did.
Three money states have to agree. Mismatches surface in the monthly
reconciliation.

| State | Source of truth | Our column | Lands via |
| --- | --- | --- | --- |
| Invoice | `invoices` row | `total_cents`, `status` | We generate it from `returns` |
| Stripe charge | Stripe `PaymentIntent` | `stripe_payment_intent` on `invoice_payments` | `invoice.paid` webhook |
| Stripe payout | Stripe `Payout` | not stored v1 (fetch on demand via API) | Daily Stripe → Chase batch |
| Bank deposit | PPF's Chase statement | operator confirms manually | Monthly reconciliation CSV |

### ACH settlement timing

- `payment_intent.processing` → funds held by Stripe; nothing has moved yet. Day 0.
- `invoice.paid` → ACH cleared on Stripe's side. Day +2 banking days.
- Stripe payout → Chase deposit. Day +1 after `paid`, so day +3 end-to-end.
- Chase statement line → operator reconciles monthly.

Nothing is "really done" until the Chase line matches. The portal
displays `paid` once Stripe confirms; the operator reconciles against
the actual bank statement at month-end.

### ACH return codes we handle

| Code | Meaning | Handling |
| --- | --- | --- |
| R01 | Insufficient funds | Retriable. Auto-retry once after 48h; operator then decides. |
| R02 | Account closed | Not retriable. Disconnect PM, prompt manager to re-link. |
| R03 | No account / unable to locate | Treat as R02. |
| R07 | Authorization revoked by customer | Pause pulls for that store; operator talks to manager. |
| R10 | Customer advises unauthorized | Dispute. Pause further pulls. Operator calls manager within 24h. |
| R20 | Non-transaction account | Prompt manager to connect a different account. |
| R29 | Corporate customer advises not authorized | Pause pulls; manager re-authorizes via Plaid. |

Code + message land on `invoices.failure_code` / `failure_message`.
Operator queue groups by code so similar failures triage together.

**Note on dispute windows.** ACH disputes have a short business-to-business
window (2 banking days for an authorized business transaction) versus
60 days for consumer transactions. We debit business accounts under a
business ACH authorization, so our exposure is small — but still, surface
R10/R29 to the operator immediately via Telegram.

### Idempotency — every Stripe write

- Every Stripe API call sends an `Idempotency-Key` header: `invoice-<local_invoice_id>-<attempt_number>`. A double-click or network retry can't double-charge.
- Webhook events dedupe by `event.id`. Add a tiny table `stripe_events (id text primary key, seen_at timestamptz default now())`; `insert ... on conflict do nothing` on receipt — if the insert conflicts, skip the handler body.
- The draft-generation cron is already idempotent via the `unique (stop_id, period_start, period_end)` constraint on `invoices`. Re-running on the same period refreshes figures and creates no duplicates.

### Variance alerts (pre-approval)

The approval queue flags any draft whose total is more than
`VARIANCE_FLAG_PCT` away (default 25%) from the stop's trailing 8-week
average. Rendered as a `Review variance` chip. Still approvable, just
not auto-approvable. Catches:

- Duplicate drop entries
- Missed drops the baker is catching up on
- Price rule changes applied unevenly
- A route realignment that stacked drops

### Pre-pull notice (v1.5 — not v1)

Email each manager a copy of their draft invoice 48 hours before the
auto-approval cutoff. Prevents surprise pulls, gives managers time to
flag or to make sure the account has funds. Template: period, line
items, total, "flag by Wed 11pm to pause this pull."

Skip for v1 because the operator is still manually approving every pull;
turn it on when `AUTO_APPROVE_ENABLED=1`.

### Audit trail

Every state transition on an invoice writes a row to `invoice_events`:

```sql
create table if not exists public.invoice_events (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  from_status invoice_status,
  to_status   invoice_status not null,
  actor       text not null,         -- 'operator:<user_id>', 'system:cron', 'system:webhook'
  source      text,                  -- stripe event.id, cron run id, etc.
  note        text,
  at          timestamptz not null default now()
);
create index on public.invoice_events (invoice_id, at desc);
```

Append-only. Shown as a timeline on each invoice detail view. Required
for any dispute conversation ("here's exactly who did what, when").

### Monthly reconciliation CSV

`GET /api/schedule?resource=reconciliation&month=YYYY-MM` returns:

```
invoice_id, stop_name, period_start, period_end, total_cents,
status, paid_at, stripe_invoice_id, stripe_payment_intent,
stripe_payout_id, payout_arrival_date
```

Operator opens their Chase statement, matches each payout line to the
CSV, flags any missing deposits for follow-up. v1 is manual; v2 can
auto-sync Chase transactions via Plaid's Transactions API if needed.

### Rate limiting / backpressure

Stripe live-mode write limit is ~25 req/sec with ~100 burst. On "Approve
all 14" the handler should serialize approvals at ≤10/sec to leave
headroom for inbound webhooks and user traffic. Not a scale problem at
30 stops; the explicit throttle just prevents it becoming one.

### Observability on `/ops`

Numbers worth seeing on the ops dashboard header:

- **DSO** — days sales outstanding, avg(`paid_at - period_end`) over trailing 30 days. Target < 7 for weekly stops.
- **Failure rate** — `failed / (failed + paid)` over trailing 30 days. Alert threshold > 3%.
- **Pulls in flight** — count of `invoices.status='processing'`.
- **Not-yet-connected** — electronic opt-in with no `stripe_pm_id`.

### Alerts (Telegram, best-effort)

Fire-and-forget via existing `_lib/telegram.js`:

- Any `invoice.payment_failed` webhook (always).
- Any `Review variance` chip on a draft > $500.
- **Two consecutive failures** for the same store → auto-pause (flip `payment_mode='cash'`, send operator alert, require manual re-enable). Prevents chasing an obviously broken bank connection week after week.

---

## Env vars

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SINGLE_PRICE_CENTS=215
STRIPE_DOUBLE_PRICE_CENTS=385
CRON_SECRET=<random 32-char>
AUTO_APPROVE_ENABLED=0        # flip to 1 after trust-building period
VARIANCE_FLAG_PCT=25          # draft > ±N% of 8-wk avg → operator review chip
OPERATOR_PHONE=+1XXXXXXXXXX   # already in portal spec
```

Prices are env vars so they can rotate without a schema migration. If the ops stack already has a per-stop or per-product pricing table, the handler should read from that instead and this env var is unused.

---

## Open items — operator decides before build

1. **Weekly cutoff timing.** Default proposed: drafts generate Sun 23:00 ET; auto-approve (when enabled) fires Wed 23:00 ET. Confirm the gap gives enough review time.
2. **Monthly cutoff timing.** Default: drafts generate 1st of month 00:30 ET; auto-approve fires 5th 23:00 ET. Confirm.
3. **Failed-pull notification channel.** Default: Telegram via `_lib/telegram.js` (already in codebase). Alternatives: email, in-app banner in `/ops`. Default is Telegram.
4. **Who's the operator identity on `approved_by`?** The signed-in `people.id` from the JWT. Same pattern as everywhere else in the codebase.
5. **Invoice display name for the Stripe-hosted receipt.** Falls back to Stripe Customer `name` = store `display_name`. Any customization (logo, memo) can be set in Stripe Dashboard → Branding, not in code.
6. **Dollar handling of adjustments.** If a manager disputes a line and operator agrees pre-pull, operator voids and the next cycle picks up the corrected returns data. Post-pull disputes = Stripe refund (manual in Stripe Dashboard for v1).

---

## Build order (suggested, for the portal session)

1. Migration `p7_payment_flow.sql` — the schema diff above.
2. Stripe setup in dashboard (user does, not code).
3. `/api/store.js` — add `payment-setup`, `payment-method`, `invoices`, `stripe-webhook` branches.
4. `/api/schedule.js` — add `stop-payment-settings`, `pending-invoices`, `approve-invoice`, `void-invoice`, `generate-drafts` branches.
5. Vercel cron config in `vercel.json` → `/api/schedule?resource=generate-drafts`.
6. `/store/billing.html` + Connect Bank flow with Stripe.js + Plaid Link.
7. `/ops` — Pending Invoices tab, Payment Settings panel on each stop.
8. Smoke test with Stripe test mode (test bank credentials in Plaid sandbox) end-to-end before going live.
9. Flip `AUTO_APPROVE_ENABLED=1` after ~1 month of manual approvals.
