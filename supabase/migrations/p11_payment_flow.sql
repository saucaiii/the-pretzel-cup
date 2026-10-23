-- P11 — Payment flow: Stripe ACH Debit settlement for 7-Eleven stops.
--
-- (Spec names this p7_payment_flow.sql; renamed to p11 because p7 is
--  already p7_store_codes.sql. Content matches docs/payment-flow.md
--  §Schema diff exactly.)
--
-- Store managers whose stop is opted in to electronic settlement get an
-- invoice generated per billing cycle (weekly or monthly). The operator
-- reviews drafts, approves (optionally in batch), and Stripe pulls funds
-- via the saved ACH mandate. Our Supabase is the system of record;
-- Stripe is the money mover. Webhooks reconcile money state back to us.
--
-- Safe to re-run.

-- ─── stops: payment settings ──────────────────────────────────────
alter table public.stops
  add column if not exists payment_mode       text not null default 'cash',
  add column if not exists billing_cadence    text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_pm_id       text,
  add column if not exists plaid_connected_at timestamptz,
  add column if not exists payment_notes      text,
  add column if not exists bank_last4         text;

do $$ begin
  alter table public.stops add constraint stops_payment_mode_chk
    check (payment_mode in ('cash','electronic'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.stops add constraint stops_billing_cadence_chk
    check (billing_cadence is null or billing_cadence in ('weekly','monthly'));
exception when duplicate_object then null;
end $$;

-- ─── enum: invoice status ─────────────────────────────────────────
do $$ begin
  create type invoice_status as enum
    ('draft','approved','processing','paid','failed','void');
exception when duplicate_object then null;
end $$;

-- ─── invoices ─────────────────────────────────────────────────────
create table if not exists public.invoices (
  id                     uuid primary key default gen_random_uuid(),
  stop_id                uuid not null references public.stops(id) on delete restrict,
  period_start           date not null,
  period_end             date not null,
  cadence                text not null check (cadence in ('weekly','monthly')),
  singles_count          int  not null default 0,
  doubles_count          int  not null default 0,
  singles_cents          int  not null default 0,
  doubles_cents          int  not null default 0,
  total_cents            int  not null,
  status                 invoice_status not null default 'draft',
  stripe_invoice_id      text,
  stripe_payment_intent  text,
  created_at             timestamptz not null default now(),
  approved_at            timestamptz,
  approved_by            uuid references public.people(id) on delete set null,
  pulled_at              timestamptz,
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
create index if not exists invoices_stripe_invoice_idx
  on public.invoices (stripe_invoice_id) where stripe_invoice_id is not null;

-- ─── invoice_payments ─────────────────────────────────────────────
-- One row per Stripe PaymentIntent attempt. A failed+retried pull keeps
-- full history (invoice may have N payments; only one succeeds).
create table if not exists public.invoice_payments (
  id                        uuid primary key default gen_random_uuid(),
  invoice_id                uuid not null references public.invoices(id) on delete cascade,
  stripe_payment_intent_id  text not null,
  status                    text not null,
  amount_cents              int  not null,
  attempted_at              timestamptz not null default now(),
  settled_at                timestamptz,
  error_code                text,
  error_message             text,
  unique (stripe_payment_intent_id)
);
create index if not exists invoice_payments_invoice_idx
  on public.invoice_payments (invoice_id, attempted_at desc);

-- ─── invoice_events ───────────────────────────────────────────────
-- Append-only audit trail. One row per state transition. Required for
-- any dispute conversation.
create table if not exists public.invoice_events (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  from_status invoice_status,
  to_status   invoice_status not null,
  actor       text not null,
  source      text,
  note        text,
  at          timestamptz not null default now()
);
create index if not exists invoice_events_invoice_idx
  on public.invoice_events (invoice_id, at desc);

-- ─── stripe_events ────────────────────────────────────────────────
-- Webhook dedupe: insert on conflict do nothing on receipt.
create table if not exists public.stripe_events (
  id       text primary key,
  type     text,
  seen_at  timestamptz not null default now()
);

-- ─── RLS: deny-all on new tables ──────────────────────────────────
alter table public.invoices         enable row level security;
alter table public.invoice_payments enable row level security;
alter table public.invoice_events   enable row level security;
alter table public.stripe_events    enable row level security;
