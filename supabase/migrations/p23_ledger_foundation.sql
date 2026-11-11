-- p23_ledger_foundation: referral-CRM + loyalty-ledger substrate.
--
-- HUMAN STEP: apply this by hand in Supabase (same pattern as p10..p22).
-- Agents do not run it. Safe to re-run.
--
-- Lays down the data substrate for the custom referral-CRM + games
-- suite: a stable `member` per person keyed on verified email, a unique
-- `referral_code` per member, and an append-only `ledger_event` log
-- that is the system of record for every economically significant
-- event. Balances are always SUM(amount) via the `member_balance`
-- view — no mutable balance column, no cache to stale.
--
-- The existing pack-game tables (pack_players, pack_vouchers,
-- pack_games, pack_magic_links) are UNTOUCHED. The ledger is a
-- parallel mirror written as a side-effect from api/_packs.js via
-- api/_lib/members.js. The ledger helper swallows its own errors so a
-- ledger outage never costs a customer their voucher.
--
-- Reads and writes come from api/_lib/members.js with the service-role
-- key. RLS on with no policies = deny-all for anon and authenticated.
--
-- Rollback block is at the bottom. Reversible as long as no
-- third-party code has started reading the ledger — which it will not,
-- in this PR.

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ─── enums ────────────────────────────────────────────────────────
-- Signed-amount convention: earned/granted > 0, spent/expired < 0; a
-- reversed row stores the negation of the row it points to so SUM()
-- still collapses to zero after a reversal.
do $$ begin
  create type public.ledger_event_type as enum ('earned','granted','spent','expired','reversed');
exception when duplicate_object then null; end $$;

-- `points` is the in-game currency the future games suite will spend.
-- `pretzel_voucher` and `golden_ticket` mirror pack_vouchers 1:1 so
-- the ledger reconciles against the pack-game table without a
-- background job: one pack_opened_* earn row per pretzel voucher
-- issued, one voucher_redemption spend row per redemption.
do $$ begin
  create type public.ledger_currency as enum ('points','pretzel_voucher','golden_ticket');
exception when duplicate_object then null; end $$;

-- ─── member ───────────────────────────────────────────────────────
-- One row per person. Verified email is the natural key when present;
-- `id` is the FK target everywhere else because pack-game events fire
-- before verify. `pack_player_id` is nullable so a wholesale customer
-- or a lead can become a member before (or without) ever opening a
-- pack. `referred_by` is set only when the referred member verifies
-- through a code; self-referral is blocked at write time in the
-- helper (an operator-created record may legitimately reference
-- itself).
--
-- member.email is citext to match wholesale_customers.email; the
-- pack_players.email column is text + lowercase-check (deliberate
-- inconsistency: both canonicalise to the same lowercased value, so a
-- FK-less linkage by email across sources is unambiguous).
create table if not exists public.member (
  id                 uuid primary key default gen_random_uuid(),
  email              citext unique,
  email_verified_at  timestamptz,
  display_name       text,
  pack_player_id     uuid unique references public.pack_players(id) on delete set null,
  referred_by        uuid references public.member(id) on delete set null,
  joined_source      text not null default 'pack_game'
                       check (joined_source in ('pack_game','pitch_kit','wholesale','manual','referral')),
  created_at         timestamptz not null default now(),
  check ((email is null) = (email_verified_at is null)),
  check (email is null or email = lower(email::text)::citext)
);

create index if not exists member_referred_by_idx
  on public.member (referred_by) where referred_by is not null;

-- ─── referral_code ────────────────────────────────────────────────
-- One row per member. `code` reuses the ASCII-safe alphabet used in
-- api/_packs.js (no 0/O/1/I/L). `revoked_at` not null means the code
-- no longer attributes new referrals but historical
-- `member.referred_by` pointers stay valid.
create table if not exists public.referral_code (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null unique references public.member(id) on delete cascade,
  code        text not null unique check (code ~ '^[A-Z0-9]{6,10}$'),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- ─── ledger_event ─────────────────────────────────────────────────
-- Append-only. The CHECK enforces the signed-amount convention and
-- the reversed <-> reverses_id dependency. `on delete restrict` on
-- member_id is deliberate: deleting a member must first zero out and
-- archive their ledger.
--
-- Idempotency: the UNIQUE index on (member_id, reason, ref) is the
-- sole dedup guarantee. A retry of handleOpen / handleVerify with the
-- same (voucher id, honor tap key) hits 23505; the helper catches it
-- and returns { deduped: true }. No application-level lock needed.
create table if not exists public.ledger_event (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references public.member(id) on delete restrict,
  event_type     public.ledger_event_type not null,
  currency       public.ledger_currency not null,
  amount         integer not null,
  reason         text not null check (char_length(reason) between 3 and 60),
  ref            text not null check (char_length(ref) between 1 and 120),
  reverses_id    uuid references public.ledger_event(id) on delete restrict,
  metadata       jsonb not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  check (
    (event_type in ('earned','granted') and amount > 0) or
    (event_type in ('spent','expired')  and amount < 0) or
    (event_type = 'reversed'            and reverses_id is not null)
  ),
  check ((event_type = 'reversed') = (reverses_id is not null))
);

create index if not exists ledger_event_member_currency_idx
  on public.ledger_event (member_id, currency);
create unique index if not exists ledger_event_reason_ref_uq
  on public.ledger_event (member_id, reason, ref);
create index if not exists ledger_event_occurred_idx
  on public.ledger_event (occurred_at desc);

-- ─── earn_rule / spend_rule ───────────────────────────────────────
-- Declarative. Later product code reads these instead of hard-coding
-- amounts. Operator edits them by SQL:
--   update public.earn_rule set amount = 25 where slug = 'pack_opened_first';
create table if not exists public.earn_rule (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique check (slug ~ '^[a-z][a-z0-9_]{2,40}$'),
  event_source   text not null check (event_source in ('pack_game','referral','wholesale','games_suite','manual')),
  currency       public.ledger_currency not null,
  amount         integer not null check (amount >= 0),
  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now()
);

create table if not exists public.spend_rule (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z][a-z0-9_]{2,40}$'),
  event_source    text not null check (event_source in ('games_suite','redemption','manual')),
  cost_currency   public.ledger_currency not null,
  cost_amount     integer not null check (cost_amount > 0),
  grants_currency public.ledger_currency,
  grants_amount   integer check (grants_amount is null or grants_amount > 0),
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  check ((grants_currency is null) = (grants_amount is null))
);

-- ─── member_balance view ──────────────────────────────────────────
-- Balance = SUM(amount) per (member, currency). The ledger is
-- append-only and small, so the view is always correct by
-- construction and there is nothing to invalidate. If this ever gets
-- hot a materialised view can replace it without changing any call
-- site.
create or replace view public.member_balance as
  select member_id, currency, sum(amount)::bigint as balance
    from public.ledger_event
   group by member_id, currency;

-- ─── RLS ──────────────────────────────────────────────────────────
alter table public.member        enable row level security;
alter table public.referral_code enable row level security;
alter table public.ledger_event  enable row level security;
alter table public.earn_rule     enable row level security;
alter table public.spend_rule    enable row level security;

-- ─── seed data ────────────────────────────────────────────────────
-- Amounts are PLACEHOLDERS. The operator sets the real economy by SQL:
--   update public.earn_rule set amount = <new> where slug = '<slug>';
-- pretzel_voucher_granted and golden_ticket_granted are the
-- currency-mirror rules — their `amount` is the voucher count granted
-- per pack-game open, not a points value. This is how the ledger
-- stays in sync with pack_vouchers without a background job.
insert into public.earn_rule (slug, event_source, currency, amount, notes) values
  ('pack_opened_first',       'pack_game',    'points',          10, 'Opening the free first pack'),
  ('pack_opened_instagram',   'pack_game',    'points',          10, 'Opening the Instagram pack'),
  ('pack_opened_email',       'pack_game',    'points',          10, 'Opening the verified-email pack'),
  ('pack_opened_share',       'pack_game',    'points',          10, 'Opening the share-with-group pack'),
  ('pack_opened_bonus',       'pack_game',    'points',          50, 'Trading all 4 for the Golden Ticket'),
  ('pretzel_voucher_granted', 'pack_game',    'pretzel_voucher',  1, 'Currency mirror: 1 voucher per pack open'),
  ('golden_ticket_granted',   'pack_game',    'golden_ticket',    1, 'Currency mirror: 1 ticket per bonus open'),
  ('email_verified',          'pack_game',    'points',          20, 'First-time email verification'),
  ('instagram_tap',           'pack_game',    'points',           5, 'Honor-system Instagram tap'),
  ('share_tap',               'pack_game',    'points',           5, 'Honor-system share tap'),
  ('referral_converted',      'referral',     'points',         100, 'Referred member verified their email'),
  ('wholesale_order_paid',    'wholesale',    'points',           1, 'Per pretzel on a paid wholesale order')
on conflict (slug) do nothing;

-- Placeholders for the games suite. Not yet wired by any handler.
insert into public.spend_rule (slug, event_source, cost_currency, cost_amount, grants_currency, grants_amount, notes) values
  ('play_mini_game',         'games_suite', 'points',          20, 'pretzel_voucher', 1,    'Spend 20 points for one play; a win grants one voucher'),
  ('voucher_redemption',     'redemption',  'pretzel_voucher',  1, null,              null, 'Pretzel voucher burned at the counter'),
  ('golden_ticket_redeemed', 'redemption',  'golden_ticket',    1, null,              null, 'Golden Ticket burned at the counter')
on conflict (slug) do nothing;

commit;

-- ─── rollback ─────────────────────────────────────────────────────
-- Only safe while no third-party code has started reading the ledger.
-- Run first: select count(*) from public.ledger_event;
-- If that returns 0, the rollback is clean. Otherwise archive first.
--
--   drop view  if exists public.member_balance;
--   drop table if exists public.ledger_event;
--   drop table if exists public.spend_rule;
--   drop table if exists public.earn_rule;
--   drop table if exists public.referral_code;
--   drop table if exists public.member;
--   drop type  if exists public.ledger_currency;
--   drop type  if exists public.ledger_event_type;
