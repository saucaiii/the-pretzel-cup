# PR — Payment flow (manager portal v1)

**Title:** `Payment flow — manager portal v1`
**Supersedes:** the "Not in scope v1: Payments / card-on-file. Invoices are reference only." line in [store-portal.md §Scope](./store-portal.md).

> This repo did not have a git remote when this change was built, so there
> is no "diff" PR to open. The initial import commit on `main` contains
> both the pre-existing codebase and the payment-flow work in one go. The
> files listed below are the ones that make up the payment flow — review
> those as the "PR". Once a GitHub remote is created and pushed, future
> features will land as clean branch-PR diffs on top of this baseline.

## Summary

- Stripe ACH Debit via Plaid Link, Stripe-hosted (no separate Plaid account).
- Opt-in per stop (cash by default; electronic + weekly/monthly cadence).
- Draft invoices auto-generate from `returns` on a daily cron (idempotent on existing drafts; monthly block on day 1).
- Operator reviews drafts in `/ops/payments`, approves one or in batch (rate-limited to ≤10/sec).
- Approve = create Stripe Invoice + items + finalize; auto_advance pulls funds ~1h later.
- Webhook (`setup_intent.succeeded`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalization_failed`, `payment_intent.processing`) reconciles status, deduped by `event.id` via `stripe_events`.
- Variance flag (`Review variance ±N%`) on drafts > ±25% of trailing 8-week average; blocks auto-approval.
- Failed-pulls block with Retry / Mark-paid / Void. R02/R03/R07/R10/R29 marked unretriable (manager must relink bank).
- Monthly reconciliation CSV at `GET /api/schedule?resource=reconciliation&month=YYYY-MM`.
- Audit trail on every state transition in `invoice_events`.
- Telegram alert on each `invoice.payment_failed` via existing `_lib/telegram.js` (best-effort).
- 12/12 Vercel Hobby functions preserved (zero new function files).

## Files

### New

- `supabase/migrations/p11_payment_flow.sql` — schema diff (spec names it p7; renamed to p11 to avoid collision with the existing `p7_store_codes.sql`).
- `api/_lib/stripe.js` — tiny Stripe REST helper + signature verifier (no `stripe` npm dep).
- `store/billing.html` — manager billing dashboard with Plaid Link.
- `ops/payments/index.html` — operator KPIs + Failed-pulls block + draft queue + reconciliation CSV.
- `.env.example` — documents every env var the operator needs to set in Vercel.
- `.gitignore` — standard ignore + `.secrets/`, service-account JSON patterns.
- `docs/pr-payment-flow.md` — this file.

### Modified

- `api/store.js` — new branches: `payment-setup`, `payment-method`, `invoices`, `stripe-webhook`. Body parser disabled; dispatcher reads raw body once so the webhook can verify signatures and other POST routes still see a parsed `req.body`.
- `api/schedule.js` — new branches: `stop-payment-settings`, `pending-invoices`, `approve-invoice`, `void-invoice`, `retry-invoice`, `mark-paid`, `generate-drafts` (bearer `CRON_SECRET`), `reconciliation`.
- `vercel.json` — Vercel Cron entry hitting `/api/schedule?resource=generate-drafts` daily at 03:00 UTC.
- `ops/stops/index.html` — Payment column per stop; chip cycles cash → ACH weekly → ACH monthly, shows connected bank's last-4.
- `ops/index.html` — Payments tool-tile with "Drafts Awaiting" badge.
- `store/index.html` — "Billing & invoices" link in the "What else?" grid.
- `docs/store-portal.md` — strikethrough + pointer superseding the "payments reference only" line.

## Env vars operator must set in Vercel

See `.env.example` for the full list. New vars for this PR:

```
STRIPE_SECRET_KEY=sk_test_… (restricted key preferred)
STRIPE_PUBLISHABLE_KEY=pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_SINGLE_PRICE_CENTS=215
STRIPE_DOUBLE_PRICE_CENTS=385
CRON_SECRET=<openssl rand -hex 32>
AUTO_APPROVE_ENABLED=0   # flip to 1 once trust is built
VARIANCE_FLAG_PCT=25
```

### Stripe dashboard setup (operator does, one-time)

1. Settings → Payment methods → ACH direct debit → turn on (requires PPF US bank account on file).
2. On the same page, enable "Instant verification with Plaid".
3. Developers → Webhooks → add endpoint `https://the-pretzel-cup.vercel.app/api/store?resource=stripe-webhook`. Subscribe to: `setup_intent.succeeded`, `invoice.paid`, `invoice.payment_failed`, `invoice.finalization_failed`, `payment_intent.processing`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Developers → API keys → create a RESTRICTED key with Customers, PaymentMethods, SetupIntents, Invoices, PaymentIntents, Webhooks write access only. Copy into `STRIPE_SECRET_KEY`.

## Test plan

Run locally against dev Supabase + Stripe test mode (`sk_test_…`).

1. **Migration** — apply `supabase/migrations/p11_payment_flow.sql`. Sanity-check tables: `invoices`, `invoice_payments`, `invoice_events`, `stripe_events` + new `stops` columns.
2. **Opt-in flow** — in `/ops/stops`, click a stop's Payment chip. Verify it cycles cash → ACH weekly → ACH monthly, and that the first flip to electronic creates a Stripe Customer (visible in Stripe test dashboard).
3. **Connect bank** — sign in to that stop at `/store/<slug>`, open `/store/billing`. Click Connect bank. Use Plaid sandbox credentials `user_good` / `pass_good` (bank: First Platypus Bank). Verify webhook fires `setup_intent.succeeded`, the stops row updates with `stripe_pm_id` + `bank_last4`.
4. **Draft generation** — hit `GET /api/schedule?resource=generate-drafts` with `Authorization: Bearer $CRON_SECRET`. Verify a draft row appears for the test stop (with real returns in the prior week), status=draft.
5. **Approve** — in `/ops/payments`, click Approve on the draft row. Verify Stripe shows a finalized test invoice; the webhook flips the row to `processing`, then `paid` within ~1 minute (Stripe test mode).
6. **Webhook dedupe** — replay the `invoice.paid` event from the Stripe dashboard; verify `stripe_events` has one row and the invoice stays `paid` (no double-handling).
7. **Signature check** — `curl -X POST /api/store?resource=stripe-webhook` with a bogus signature; verify 400.
8. **Reconciliation CSV** — download `GET /api/schedule?resource=reconciliation&month=YYYY-MM`; verify the paid row is present with Stripe IDs.
9. **Failed-pull path** — in Stripe test mode, use a bank account that generates insufficient funds. Verify the row flips to `failed`, Telegram alert fires if configured, the Failed-pulls block shows the row with Retry/Mark-paid/Void.

## Known-nots

- `AUTO_APPROVE_ENABLED` defaults off; auto-approval cron check is wired but inert until the operator flips it.
- Email pre-pull notice (spec v1.5) is NOT included.
- Toast / AR mirror-back is NOT included (confirmed out of scope; see the Toast dev-doc note in `docs/payment-flow.md`).
- Partial payments / refunds — operator voids and re-issues or refunds manually in Stripe for v1.

## References

- Full spec: [`docs/payment-flow.md`](./payment-flow.md)
- Clickable UX prototype: https://claude.ai/artifact/6kV76szyQR1cMAaMN6dPaj

🤖 Generated with [Claude Code](https://claude.com/claude-code)
