# Plan — Wholesale ordering + email tracking stack

**Risk: HIGH** (not critical; see below).
- *Operational:* new public API surface, Stripe webhook, DB migration. Reversible by `git revert` + `drop … cascade` (migration is additive). Deploys stay human-only.
- *Security:* new PII table (`wholesale_customers.email`, phone), Stripe payment session creation, Gmail API send scope expansion. No change to auth middleware. RLS limits anon reads to the caller's own `stripe_session_id`.
- *Compliance:* customer emails and names handled under existing privacy posture. **No real customer emails in prompts/plans/memory/logs** — redacted counts only. Gmail scope requires domain-wide delegation (human-side Google admin step, documented in runbook, not performed by this task).

**Not CRITICAL** per the kit's table: no live money movement without a human (Stripe stays in test mode for this task), no deploy step, no automated decisions about people. The one critical-adjacent action — enabling live email sends — is env-flag-gated (`EMAIL_SEND_LIVE_ENABLED=true`) and requires a separate human-only Google admin delegation. Flipping that flag is out of scope for this task.

## Function cap — resolved

Vercel upgraded to **Pro**. The 12-fn Hobby cap no longer applies. Shipping the brief's per-endpoint file structure as-written: 10 new serverless functions.

CLAUDE.md's Pretzel Cup specifics still mention the Hobby cap; its "fold into `?resource=`" rule is now historical for this task but should stay in CLAUDE.md as the pattern of record for anyone back on Hobby. No doc edit in this task.

## Goal

Replace the external Google Form wholesale flow with an in-house system that attributes orders to specific email sends, computes authoritative promo bonuses server-side, and surfaces revenue + funnel in `/ops/wholesale/`. Enables the Winter 2026-27 "Made to Crave" nurture (6 emails, 3 promos).

## Scope (file list proposed for `.agent-control/scope.txt`)

```
supabase/migrations/p14_wholesale.sql
scripts/seed-wholesale.mjs
wholesale/index.html
wholesale/success.html
api/wholesale/submit.js
api/wholesale/customer.js
api/wholesale/order.js
api/wholesale/stripe-webhook.js
api/wholesale/list.js
api/wholesale/metrics.js
api/campaigns/send.js
api/track/open.js
api/track/click.js
api/_lib/gmail.js
api/_lib/md.js
api/_lib/promo.js
ops/wholesale/index.html
docs/wholesale.md
.env.example
```

**scope.txt does not currently exist.** Human sets it to the above before approving.

## Steps — 6 phases

### Phase 1 — Supabase schema + seed script
- Migration `p14_wholesale.sql`: 6 tables (`wholesale_products`, `wholesale_customers`, `wholesale_campaigns`, `wholesale_campaign_emails`, `wholesale_email_sends`, `wholesale_orders`), RLS policies, indexes exactly as specified in the brief. All uuid PK, `timestamptz`, `citext` emails. Enable `pgcrypto` + `citext` extensions if not present.
- `scripts/seed-wholesale.mjs` (modeled on `scripts/import-store-contacts.mjs`): idempotent upsert of 7 products, 1 campaign (`winter-2026-27`), 6 campaign emails. Reads customers from Google Sheet `1Br-…` tab Wholesale (gid 164530681) using existing `googleapis` + `GOOGLE_SA_EMAIL`. Dedupe by lowercased email (col R). Logs redacted counts only.
- **Commit:** `feat: add wholesale supabase schema and seed script`

### Phase 2 — Public form + submit API
- `wholesale/index.html`: brand-matched (diamond-plate top strip, #0D5237 CTA, Made to Crave® footer). Pre-fills from `?contact=<id>&src=<tag>` via `GET /api/wholesale/customer?id=<uuid>` (returns public-safe fields only — first_name, organization, pickup_location, pickup_address). Fields per brief; client-side bonus preview informational.
- `POST /api/wholesale/submit`: validate → lookup-or-create `wholesale_customers` by email → compute authoritative promo (every full 100 of any pretzel SKU adds 25 of same SKU @ $0; stackable per SKU) in `api/_lib/promo.js` → create `wholesale_orders` draft (status `awaiting_payment`) → create Stripe Checkout session with bonus as $0 line items → resolve `email_send_id` from `src_tag → campaign_email.cta_src → wholesale_email_sends` for this customer → return Checkout URL.
- `GET /api/wholesale/customer?id=<uuid>`: public-safe fields only. No phone, no notes, no email.
- **Commit:** `feat: add public wholesale order form and submit API`

### Phase 3 — Stripe webhook + success page
- `POST /api/wholesale/stripe-webhook`: raw-body signature verification (reuses `_lib/stripe.verifyStripeSignature`). `checkout.session.completed` → status=paid, set `paid_at`, `stripe_payment_intent_id`, final `total_cents`. `checkout.session.expired` → `cancelled`. Idempotent on `stripe_session_id`. `module.exports.config = { api: { bodyParser: false } }` so Stripe sig verification works.
- `wholesale/success.html`: order summary via `GET /api/wholesale/order?session_id=…` (RLS filters to that session only). Link home.
- **Commit:** `feat: handle stripe checkout webhook and success page`

### Phase 4 — Campaign sender + tracking
- `POST /api/campaigns/send`: internal, requires `Authorization: Bearer $CRON_SECRET`. `?dry_run=true|false`. **Live sends refuse unless `EMAIL_SEND_LIVE_ENABLED=true`** (env var added to `.env.example` with name-only comment).
  - For each customer in campaign without an existing `wholesale_email_sends` row for this `campaign_email_id`:
    - Render `body_md` with `{{first_name}} {{organization}} {{pickup_location}} {{pickup_address}}` → HTML via `api/_lib/md.js` (small zero-dep markdown-to-HTML helper covering headings, bold, italic, links, lists, paragraphs — enough for the 6 templates).
    - Rewrite destination links to `${BASE_URL}/api/track/click?s=<send_id>&u=<base64url(url)>` (destination allowlist: `the-pretzel-cup.vercel.app`, `docs.google.com`; others rejected 400 at click time).
    - Append 1×1 pixel `${BASE_URL}/api/track/open?s=<send_id>`.
    - `dry_run`: insert send row with `sent_at=null, notes='dry_run'`. Return rendered HTML for one sample customer.
    - Live: send via Gmail API as the confirmed send-as address, using service-account JWT with `gmail.send` scope + subject-impersonation. On 2xx: set `sent_at`. On error: set `bounced_at` + reason string; **no retry inside handler**.
  - Return `{sent, skipped, errors}`.
- `GET /api/track/open?s=<id>`: records `opened_at` on FIRST hit only (SQL `COALESCE`); returns transparent 1×1 GIF with `Cache-Control: no-store`.
- `GET /api/track/click?s=<id>&u=<b64>`: increments `click_count` atomically, sets `first_clicked_at` if null, host-validates decoded `u` against allowlist, 302 to `u` (else 400). No open-redirect.
- `api/_lib/gmail.js`: thin wrapper around `googleapis` for domain-wide-delegated send. Reuses the key material `_lib/sheet.js` already loads. Scope: `https://www.googleapis.com/auth/gmail.send`.
- **Commit:** `feat: add campaign sender via gmail api and tracking endpoints`

### Phase 5 — Operator dashboard
- `ops/wholesale/index.html`: gated by `POST /api/auth/me` (reuses `ops/stops/index.html` pattern verbatim). Three sections:
  1. **Orders** table (org + first name, items summary, total, promo, status, pickup date/location, src_tag); row → detail drawer; filter by status/promo/date.
  2. **Revenue** this-week/this-month/campaign-to-date; by-promo bar; by-product table; CSV export.
  3. **Funnel** per campaign email: sent / opened / clicked / ordered (count + %) + revenue, with sparkline per row.
- `GET /api/wholesale/list`: operator-gated, recent orders.
- `GET /api/wholesale/metrics`: operator-gated, revenue rollups + per-email funnel.
- **Commit:** `feat: add operator wholesale dashboard with revenue and funnel`

### Phase 6 — Verification + runbook
- Run seed against dev Supabase; confirm 7 products, 1 campaign, 6 emails, N customers (redacted count only in state.md).
- Local Stripe test: `stripe listen --forward-to localhost:3000/api/wholesale/stripe-webhook`; test card 4242…; confirm `paid` in dashboard.
- Dry-run Email 1: confirm 25 send rows with `sent_at=null, notes='dry_run'`.
- `docs/wholesale.md`: seed, local Stripe test, dry-run send, how to enable live sends (sets `EMAIL_SEND_LIVE_ENABLED=true` + configure Gmail API domain-wide delegation for `GOOGLE_SA_EMAIL` on the send-as address with `gmail.send` scope — link Google's delegation docs).
- Run `scripts/agent/eval-report.sh`.
- Invoke `reviewer` subagent; record signoff in `.agent/state.md`.
- **Commit:** `docs: add wholesale runbook and verification evidence`

## Success criteria

**Quantitative:**
- All migrations apply cleanly on a fresh schema.
- Seed script runs twice in a row with 0 duplicates.
- `scope-check.sh` passes (only files in scope.txt modified).
- CodeQL: no new high/critical alerts.
- `grep -r 'EMAIL_SEND_LIVE_ENABLED' api/` shows the live-send gate at the one correct place.
- Function count after Phase 5: 22 (12 existing + 10 new); within Pro's 100-fn cap.
- No `.env` or secret values appear in any committed file (`git log -p` greps for the var names and sees only `.env.example` comment lines).

**Qualitative:**
- A test order through `/wholesale/` with Stripe test card lands in `/ops/wholesale/` as paid, with the right promo, right bonus units, and right `email_send_id` attribution when the referral came via a tracked link.
- A dry-run of Email 1 produces 25 pending send rows and one rendered HTML sample that visually matches the template (merge fields replaced, tracking links point to our domain, pixel is at end-of-body).
- A click on a tracked link increments `click_count` once per hit and lands the user on the right page.
- An open of a tracked message sets `opened_at` once; a second open does not overwrite it.
- Operator can filter orders by promo code and the revenue rolls up to a round number matching the raw rows.

## Risks + mitigations

- **Stripe webhook raw-body**: handler sets `bodyParser: false` in `module.exports.config`. Mitigation: unit-smoke the signature verification against a stripe-listen test event before merge.
- **Open redirect via track-click**: hard allowlist on decoded `u`. Reject with 400 if host not in `the-pretzel-cup.vercel.app` or `docs.google.com`.
- **Gmail scope misuse**: service account send scope allows sending as any delegated user. Mitigation: domain-wide delegation configured for ONE address only; handler hardcodes the from address; code review flags any dynamic from.
- **PII leaks**: no customer email in state.md, decisions.md, plans, logs, or commits. Redacted counts only. `api/wholesale/customer` returns PUBLIC-safe fields only (no email, no phone, no notes).
- **Promo stackability**: multiple SKUs each hit 100 → each gets its own 25 bonus. Property-based unit cases in a scratchpad script before shipping — not a committed test (no test suite yet, per CLAUDE.md).
- **Live sends by accident**: `EMAIL_SEND_LIVE_ENABLED` default `undefined` → handler refuses live. Dry-run path also refuses to flip rows to `sent_at` set.

## Rollback

- Phase 1 migration: `drop table` the 6 new tables cascade; no FK to existing data.
- Phase 2-5: `git revert` the branch merge; Vercel redeploys previous SHA.
- Deploy itself is human-only via `npm run deploy` and remains outside this task.

## Evidence plan

- `.agent/state.md` records: migration applied, seed counts (redacted), each commit SHA, Stripe test session id, dry-run response, click/open spot-checks, reviewer signoff.
- PR description includes: screenshots of `/wholesale/` form and `/ops/wholesale/` dashboard; the three Phase-6 verification bullets; the function-count check output; the Responsible AI checklist.
- `scripts/agent/eval-report.sh` output attached to PR.

## Gates

- **Scope gate:** human sets `.agent-control/scope.txt` to the file list above.
- **Plan gate:** human runs `scripts/agent/approve-plan.sh` after confirming scope.
- **PR gate:** PR opens as **DRAFT**. Never ready-for-review, never merged, never approved from this agent.

## Confirmed before approval

1. **Send-as Gmail address:** `mcaiazzoppffs@gmail.com` (hard-coded in `api/_lib/gmail.js`; domain-wide delegation configured for this one address only).
2. **Base URL env var:** `WHOLESALE_BASE_URL`, with fallback to `https://${process.env.VERCEL_URL}` and final fallback to `http://localhost:3000` for local dev.
