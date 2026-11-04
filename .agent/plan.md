# Plan — Wholesale operator control surface

- **Risk:** high
- **Goal:** Give operators a complete control surface over wholesale order
  status (`awaiting_payment` → `invoiced` → `paid`, plus `cancelled`), with
  an optional invoice email sent in the same operator click, preview /
  dry-run / live-send controls for nurture campaigns (today a terminal
  curl), and per-customer email history inside the order drawer.
- **Scope (paths/files):** supabase/migrations/p15_wholesale_order_audit.sql, api/wholesale/order.js, api/wholesale/invoice.js, api/campaigns/send.js, api/_lib/invoice-template.js, ops/wholesale/index.html, docs/wholesale.md

Scope entries for `.agent-control/scope.txt` — the main repo owns this
file (worktree reads it through `AGENT_REPO_ROOT`). Already set by the
human to the list below:

```
.claude/worktrees/eager-einstein-93e3e9/.agent/
.claude/worktrees/eager-einstein-93e3e9/supabase/migrations/p15_wholesale_order_audit.sql
.claude/worktrees/eager-einstein-93e3e9/api/wholesale/order.js
.claude/worktrees/eager-einstein-93e3e9/api/wholesale/invoice.js
.claude/worktrees/eager-einstein-93e3e9/api/campaigns/send.js
.claude/worktrees/eager-einstein-93e3e9/api/_lib/invoice-template.js
.claude/worktrees/eager-einstein-93e3e9/ops/wholesale/index.html
.claude/worktrees/eager-einstein-93e3e9/docs/wholesale.md
```

## Steps

### Phase 1 — Migration
File: `supabase/migrations/p15_wholesale_order_audit.sql`
- `ALTER TYPE wholesale_order_status ADD VALUE IF NOT EXISTS 'invoiced'
  BEFORE 'paid';` — must run outside a transaction (Postgres constraint).
  The Supabase MCP `apply_migration` handles the transaction mode.
- Add nullable columns to `wholesale_orders`:
  `invoiced_at timestamptz`,
  `invoiced_by uuid references public.people(id) on delete set null`,
  `cancelled_at timestamptz`,
  `cancelled_by uuid references public.people(id) on delete set null`,
  `paid_by     uuid references public.people(id) on delete set null`.
- Safe to re-run — `ADD VALUE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`.
- Commit: `feat(wholesale): add order-audit columns and 'invoiced' status`.

### Phase 2 — Order PATCH + email-history on GET
File: `api/wholesale/order.js` (modified)
- Keep the public GET (receipt view) unchanged in payload and auth.
- Add method dispatch: `PATCH /api/wholesale/order?o=<id>`, operator-gated
  via `requireRole(req, res, ['operator'])`. Body: `{status}`.
- Server-side transition table (anything else → 409):
  - `awaiting_payment` → `invoiced`, `paid`, `cancelled`
  - `invoiced`         → `paid`, `cancelled`
  - `paid` / `cancelled` / `refunded` / `draft` → no transitions here.
- On transition, stamp the matching audit column + operator id from
  `sess.sub`: invoiced_at/by, paid_at/by, cancelled_at/by. Return the
  updated order payload (operator-shape; see below).
- GET upgrade: if the caller has a valid operator session (the UUID-gated
  public receipt path is preserved for `/wholesale/success`), include an
  `email_history` array pulled from `wholesale_email_sends` joined to
  `wholesale_campaign_emails` keyed on the order's `customer_id`.
  Fields per row: `position, subject, send_date, sent_at, opened_at,
  first_clicked_at, click_count`. Order by `position asc`.
- Commit: `feat(wholesale): add order PATCH endpoint and operator email history`.

### Phase 3 — Invoice workflow
Files: `api/_lib/invoice-template.js` (new), `api/wholesale/invoice.js` (new)
- Template module exports `renderInvoice({ order, customer, baseUrl })` →
  `{ subject, bodyMd, html, text }`. Body is markdown (rendered via the
  existing `md.js`): greeting, itemized line list (billed items + bonus
  lines marked "(free)"), subtotal / discount / total, pickup block,
  then the payment-instructions block from env
  `WHOLESALE_INVOICE_PAYMENT_HELP` (default literal: "We'll follow up
  with payment details shortly."). HTML version runs through
  `renderMarkdown` + `escapeHtml`; raw user fields (customer names, pickup
  text) are escaped.
- `POST /api/wholesale/invoice?o=<order_id>`, operator-gated. Body:
  `{dry_run: true|false}`.
  - Loads the order + customer. 404 if not found.
  - Builds the invoice markdown + html + text.
  - Mode resolution: `mode = (dry_run !== true && EMAIL_SEND_LIVE_ENABLED
    === 'true') ? 'live' : 'dry_run'` (same pattern as `send.js`).
  - Dry-run: returns `{mode, sent: false, subject, to, rendered_html,
    live_disabled_reason?}`.
  - Live: sends via `sendEmail({to, subject, html, text})`; on success,
    update the order to `status='invoiced', invoiced_at=now(),
    invoiced_by=sess.sub` IF the current status is `awaiting_payment`
    (if it moved out from under us, the send still counts; the response
    reports `status_updated: false`). Return
    `{mode, sent: true, subject, to, status_updated}`.
- Vercel function-count: +1 new endpoint; well within Pro's 100 cap.
- Commit: `feat(wholesale): invoice template + operator invoice send endpoint`.

### Phase 4 — Campaign operator-auth branch
File: `api/campaigns/send.js` (modified)
- Current auth: `Authorization: Bearer $CRON_SECRET`.
- New auth: accept EITHER a valid Bearer header OR a valid operator
  session cookie (via `readSession` + role check). No valid bearer and
  no operator session → 401 as today.
- No other behavior change. Dry-run default and
  `EMAIL_SEND_LIVE_ENABLED` gate stay unconditional.
- Commit: `feat(campaigns): accept operator session alongside cron bearer`.

### Phase 5 — Ops dashboard UI
File: `ops/wholesale/index.html` (modified)
- Status pill: add `.status-pill.invoiced` (amber/brown so it reads
  distinct from `.awaiting` and `.paid`).
- Orders drawer:
  - Three row-level action buttons: **Mark invoiced**, **Mark paid**,
    **Cancel**. Each disabled when the current status doesn't allow
    the move (mirrors server-side transition table).
  - **Mark invoiced** opens the invoice modal: shows the generated
    subject + rendered HTML preview in an iframe (`srcdoc=` with
    `sandbox="allow-same-origin"` so inline styles render but scripts
    don't), customer email pre-filled, two buttons — **Send invoice**
    (POST `/api/wholesale/invoice?o=<id>` with `dry_run=false`) and
    **Just mark invoiced** (PATCH `/api/wholesale/order?o=<id>` with
    `status='invoiced'`).
  - **Mark paid** and **Cancel** are plain `confirm()` → PATCH calls.
  - **Email history** section listing the campaign emails the customer
    received, with send/open/click stamps. Hidden when empty.
- Funnel tab: three row-level buttons per campaign email:
  - **Preview** — POST `send.js?dry_run=true` with operator cookie;
    open a modal rendering the returned `sample_html` in an iframe.
  - **Dry-run** — same POST; display the counts inline in the row.
  - **Send now** — opens a modal that requires the operator to type
    the campaign slug exactly, then POSTs with `dry_run=false`. If
    `live_disabled_reason` comes back, surface it in the modal and stop.
- All browser calls use `credentials: 'same-origin'` so the operator
  JWT cookie carries them.
- Commit: `feat(ops/wholesale): operator action buttons, invoice modal, email history`.

### Phase 6 — Docs
File: `docs/wholesale.md` (modified)
- Update the order-lifecycle diagram to the four-state flow
  (`awaiting_payment → invoiced → paid`, plus `cancelled`).
- Mark the previous "Follow-up" bullets as **done** (operator UI for
  status transitions; invoice template + send).
- Document `WHOLESALE_INVOICE_PAYMENT_HELP` (optional, markdown).
- Document `PATCH /api/wholesale/order` and `POST /api/wholesale/invoice`.
- Document the operator-auth branch added to `/api/campaigns/send`.
- Commit: `docs(wholesale): document operator controls, invoice flow, and email history`.

## Success criteria

- [ ] Required checks pass (plan-gate, scope-check, agent-conflicts, CI).
- [ ] Only files in the declared scope changed.
- [ ] No new code scanning alerts.
- [ ] `p15_wholesale_order_audit` applied in dev Supabase; the `invoiced`
      enum value and five audit columns are present; no FK orphan rows.
- [ ] Operator can advance a test order through
      `awaiting_payment → invoiced → paid` from the dashboard UI alone;
      `invoiced_by`/`paid_by`/`cancelled_by` all record the operator's
      `people.id`.
- [ ] Dry-run of `POST /api/wholesale/invoice` returns a correctly
      escaped HTML invoice body. Live mode is refused when
      `EMAIL_SEND_LIVE_ENABLED` is not set.
- [ ] `POST /api/campaigns/send` accepts both bearer and operator
      cookie; bearer-path behavior is unchanged.
- [ ] Email-history section in the drawer lists the campaign emails sent
      to that order's customer (empty hidden).
- [ ] Reviewer subagent run against the diff; HIGH findings addressed
      before un-drafting.

## Risks + mitigations

- **Status transitions on real orders.** Server-side transition table
  rejects invalid moves (409). All transitions audited with
  `<state>_at` + `<state>_by` columns. Dev-DB walkthrough before any
  PR flip from draft.
- **Accidental live invoice send.** Live mode gated by
  `EMAIL_SEND_LIVE_ENABLED=true` (reused from campaign sender). Dry-run
  default. "Just mark invoiced" path does not send.
- **Accidental mass-send of a campaign.** The Send-now modal requires
  the operator to type the campaign slug; refuses without env flag;
  `wholesale_email_sends` UNIQUE constraint prevents double-sends to a
  single customer (upgrades in place, same as today).
- **Email-history leak via public GET.** `email_history` is attached
  only when the caller has a valid operator session; the public receipt
  payload stays unchanged.
- **Enum-value add in a transaction.** The Supabase MCP `apply_migration`
  runs each statement separately; `ADD VALUE IF NOT EXISTS 'invoiced'
  BEFORE 'paid'` is re-run safe.
- **Operator id not a valid people row later.** FK is `ON DELETE SET NULL`:
  if an operator is later removed, audit rows persist with NULL `_by`.
  We never fabricate the id — `sess.sub` is `people.id` as minted at
  sign-in.

## Rollback / escalation plan

- **Code:** `git revert <merge-sha>`; Vercel redeploys previous SHA.
- **Migration:** p15 adds only nullable columns + one enum value.
  Columns are dropped with
  `ALTER TABLE wholesale_orders DROP COLUMN invoiced_at, DROP COLUMN
  invoiced_by, DROP COLUMN cancelled_at, DROP COLUMN cancelled_by,
  DROP COLUMN paid_by;`. Enum values cannot be removed in Postgres
  without a type rebuild — leave `'invoiced'` in place after rollback.
- **Escalation:** >2 failed retries, scope change, or any live-send
  surprise → stop and file an escalation note in `.agent/state.md`
  with root cause (`reasoning | tool-misuse | context/env`).
