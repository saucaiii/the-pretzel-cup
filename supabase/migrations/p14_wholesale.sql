-- P14 — Wholesale ordering + email tracking stack.
--
-- Replaces the external Google Form wholesale flow. Captures orders,
-- attributes them to a specific email send, supports a 100-for-25
-- promo (every full 100 units of a pretzel SKU adds 25 of the SAME
-- SKU as a $0 bonus line; stackable per SKU, per order).
--
-- Email tracking: campaign emails rendered server-side, destination
-- links rewritten to go through /api/track/click, 1x1 open pixel
-- appended. One row per (campaign_email, customer) send; dry_run rows
-- have sent_at=null, notes='dry_run'.
--
-- All content tables (products, campaigns, campaign emails) are
-- seeded by scripts/seed-wholesale.mjs. This migration is schema-only.
--
-- Safe to re-run.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ─── wholesale_products ────────────────────────────────────────────
-- unit_price_cents is the per-unit charge for billed units. Bonus
-- units from a promo are added as $0 line items by the submit handler.
create table if not exists public.wholesale_products (
  id                uuid primary key default gen_random_uuid(),
  sku               text not null unique,
  name              text not null,
  unit_price_cents  int  not null check (unit_price_cents >= 0),
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- ─── wholesale_customers ───────────────────────────────────────────
-- Email is the natural key. first_name is informal (used in greeting
-- merge). contact_name is "formal full name" for order confirmation
-- UI. tax_exempt flags EIN-holding orgs for future reporting.
create table if not exists public.wholesale_customers (
  id                uuid primary key default gen_random_uuid(),
  email             citext not null unique,
  first_name        text,
  contact_name      text,
  organization      text,
  pickup_location   text,
  pickup_address    text,
  phone             text,
  tax_exempt        boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now()
);

-- ─── wholesale_campaigns ───────────────────────────────────────────
create table if not exists public.wholesale_campaigns (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  starts_on   date,
  ends_on     date,
  created_at  timestamptz not null default now()
);

-- ─── wholesale_campaign_emails ─────────────────────────────────────
-- position is 1-based ordinal within the campaign. cta_src is the
-- ?src= tag embedded in every CTA link in body_md; the submit handler
-- uses it to resolve `src_tag → campaign_email.id → email_send.id` for
-- the ordering customer.
create table if not exists public.wholesale_campaign_emails (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.wholesale_campaigns(id) on delete cascade,
  position      int  not null,
  send_date     date,
  promo_code    text,
  subject       text not null,
  preheader     text,
  body_md       text not null,
  cta_label     text,
  cta_src       text,
  created_at    timestamptz not null default now(),
  unique (campaign_id, position)
);
create index if not exists wholesale_campaign_emails_src_idx
  on public.wholesale_campaign_emails (cta_src)
  where cta_src is not null;

-- ─── wholesale_email_sends ─────────────────────────────────────────
-- One row per (campaign_email, customer). Live-send success sets
-- sent_at. Failure sets bounced_at + notes. The track/open and
-- track/click endpoints update opened_at / first_clicked_at /
-- click_count. opened_at and first_clicked_at are set once only — the
-- handlers use COALESCE so a repeat open doesn't overwrite the first.
create table if not exists public.wholesale_email_sends (
  id                 uuid primary key default gen_random_uuid(),
  campaign_email_id  uuid not null references public.wholesale_campaign_emails(id) on delete cascade,
  customer_id        uuid not null references public.wholesale_customers(id) on delete cascade,
  sent_at            timestamptz,
  opened_at          timestamptz,
  first_clicked_at   timestamptz,
  click_count        int  not null default 0,
  bounced_at         timestamptz,
  notes              text,
  created_at         timestamptz not null default now(),
  unique (campaign_email_id, customer_id)
);
create index if not exists wholesale_email_sends_customer_idx
  on public.wholesale_email_sends (customer_id);
create index if not exists wholesale_email_sends_campaign_email_idx
  on public.wholesale_email_sends (campaign_email_id);

-- ─── wholesale_orders ──────────────────────────────────────────────
-- items is a jsonb array of {sku, name, qty, unit_price_cents,
-- line_total_cents, is_bonus}. Bonus lines have unit_price_cents=0 and
-- is_bonus=true. subtotal_cents = sum of billed line totals.
-- discount_cents = retail dollar value of the bonus units (qty * SKU
-- unit price) — informational, for reporting. total_cents = what the
-- customer actually paid via Stripe (= subtotal_cents under the
-- 100-for-25 scheme since bonus lines are $0). stripe_session_id is
-- also the sharable row id used by the success page.
do $$ begin
  create type wholesale_order_status as enum
    ('draft','awaiting_payment','paid','cancelled','refunded');
exception when duplicate_object then null;
end $$;

create table if not exists public.wholesale_orders (
  id                        uuid primary key default gen_random_uuid(),
  customer_id               uuid not null references public.wholesale_customers(id) on delete restrict,
  email_send_id             uuid references public.wholesale_email_sends(id) on delete set null,
  src_tag                   text,
  promo_code                text,
  pickup_location           text,
  pickup_date               date,
  pickup_time               text,
  items                     jsonb not null default '[]'::jsonb,
  subtotal_cents            int  not null default 0 check (subtotal_cents >= 0),
  discount_cents            int  not null default 0 check (discount_cents >= 0),
  total_cents               int  not null default 0 check (total_cents    >= 0),
  stripe_session_id         text unique,
  stripe_payment_intent_id  text,
  status                    wholesale_order_status not null default 'draft',
  notes                     text,
  created_at                timestamptz not null default now(),
  paid_at                   timestamptz
);
create index if not exists wholesale_orders_created_idx
  on public.wholesale_orders (created_at desc);
create index if not exists wholesale_orders_promo_status_idx
  on public.wholesale_orders (promo_code, status)
  where promo_code is not null;
create index if not exists wholesale_orders_customer_idx
  on public.wholesale_orders (customer_id);
create index if not exists wholesale_orders_email_send_idx
  on public.wholesale_orders (email_send_id)
  where email_send_id is not null;

-- ─── RLS ───────────────────────────────────────────────────────────
-- Default: deny all. API routes use the service role, which bypasses
-- RLS. No anon policies — all customer-facing reads/writes go through
-- the server-side API, where the handler decides what to return (see
-- api/wholesale/customer.js for the public-safe field whitelist and
-- api/wholesale/order.js for the stripe_session_id → row lookup).
--
-- NOTE: an earlier draft added a `using (stripe_session_id is not null)`
-- policy intending "callers can read their own order by session id,"
-- but that policy would have returned every row with a session id to
-- any anon SELECT (RLS USING is a per-row boolean, not a filter), so
-- it has been dropped. If a direct-from-browser flow is needed later,
-- re-add a policy that matches the session id against a JWT claim,
-- e.g. `using (stripe_session_id = current_setting('request.jwt.claim.session_id', true))`.
alter table public.wholesale_products         enable row level security;
alter table public.wholesale_customers        enable row level security;
alter table public.wholesale_campaigns        enable row level security;
alter table public.wholesale_campaign_emails  enable row level security;
alter table public.wholesale_email_sends      enable row level security;
alter table public.wholesale_orders           enable row level security;
