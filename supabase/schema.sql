-- ═══════════════════════════════════════════════════════════════════
-- PPF Ops Hub — schema
-- ═══════════════════════════════════════════════════════════════════
-- Paste this into Supabase → SQL Editor → Run. Safe to run twice:
-- every object is CREATE IF NOT EXISTS or guarded.
--
-- Auth model: we do NOT use Supabase Auth (no email/phone OTP). All
-- staff sign in with name picker + 4-6 digit PIN. PINs are stored as
-- bcrypt hashes via pgcrypto. A Vercel API route verifies the PIN,
-- issues an app JWT (signed with APP_JWT_SECRET), and sets it as an
-- httpOnly cookie. All DB access happens server-side with the service
-- role key; RLS is "deny all" so direct anon-key access from the
-- browser never leaks anything.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── enums ─────────────────────────────────────────────────────────
do $$ begin create type user_role    as enum ('operator','baker','driver'); exception when duplicate_object then null; end $$;
do $$ begin create type request_type as enum ('off','cover');               exception when duplicate_object then null; end $$;
do $$ begin create type req_status   as enum ('pending','approved','denied'); exception when duplicate_object then null; end $$;

-- ─── people ────────────────────────────────────────────────────────
-- One row per employee. Mike is the only 'operator' seat for now.
-- pin_hash stores crypt('<pin>', gen_salt('bf', 10)).
-- Verify with: pin_hash = crypt('<input>', pin_hash).
create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  role        user_role not null,
  pin_hash    text not null,
  telegram_id bigint,
  created_at  timestamptz not null default now()
);

-- ─── routes ────────────────────────────────────────────────────────
create table if not exists public.routes (
  key           text primary key,       -- 'FSQ' | 'LYN' | 'FBW'
  label         text not null,
  display_order int not null default 0
);

-- ─── shifts: who works where on which days ─────────────────────────
-- days is a Postgres array of weekday numbers (0=Sun … 6=Sat).
-- location is a human label; route_key is set only for driver route
-- shifts (left NULL for bakery shifts).
create table if not exists public.shifts (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.people(id) on delete cascade,
  role       user_role not null,
  location   text not null,
  route_key  text references public.routes(key) on delete set null,
  days       int[] not null check (array_length(days, 1) >= 1)
);
create index if not exists shifts_person_idx on public.shifts(person_id);
create index if not exists shifts_route_idx  on public.shifts(route_key);

-- ─── stops per route ───────────────────────────────────────────────
-- singles_drop_wknd / doubles_drop_wknd are only set when a stop has
-- a different weekend drop (IVB is the one example today). NULL means
-- "same as weekday".
create table if not exists public.stops (
  id                 uuid primary key default gen_random_uuid(),
  route_key          text not null references public.routes(key) on delete cascade,
  stop_order         int  not null,
  name               text not null,
  town               text not null,
  singles_drop       int  not null default 0,
  doubles_drop       int  not null default 0,
  singles_drop_wknd  int,
  doubles_drop_wknd  int,
  basket             text,
  note               text,
  active             boolean not null default true,
  shorts             boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (route_key, stop_order)
);
create index if not exists stops_route_idx on public.stops(route_key, stop_order);

-- ─── updates feed ──────────────────────────────────────────────────
-- audience is a subset of {'bakers','drivers'}; empty array = all hands.
create table if not exists public.updates (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  body                  text,
  audience              text[] not null default '{}',
  effective_date        date,
  posted_by             uuid references public.people(id) on delete set null,
  posted_at             timestamptz not null default now(),
  requires_ack          boolean not null default true,
  telegram_message_ids  jsonb
);
create index if not exists updates_posted_idx on public.updates(posted_at desc);

create table if not exists public.update_acks (
  update_id  uuid not null references public.updates(id) on delete cascade,
  person_id  uuid not null references public.people(id)  on delete cascade,
  acked_at   timestamptz not null default now(),
  primary key (update_id, person_id)
);

-- ─── time off + coverage ──────────────────────────────────────────
create table if not exists public.time_off_requests (
  id                uuid primary key default gen_random_uuid(),
  person_id         uuid not null references public.people(id) on delete cascade,
  type              request_type not null,
  requested_date    date not null,
  note              text,
  status            req_status not null default 'pending',
  cover_person_id   uuid references public.people(id) on delete set null,
  decided_by        uuid references public.people(id) on delete set null,
  decided_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists req_person_idx on public.time_off_requests(person_id, requested_date);
create index if not exists req_date_idx   on public.time_off_requests(requested_date, status);

create table if not exists public.cover_offers (
  request_id  uuid not null references public.time_off_requests(id) on delete cascade,
  person_id   uuid not null references public.people(id)            on delete cascade,
  offered_at  timestamptz not null default now(),
  primary key (request_id, person_id)
);

-- ─── driver returns per stop per day ───────────────────────────────
create table if not exists public.returns (
  id                   uuid primary key default gen_random_uuid(),
  for_date             date not null,
  route_key            text not null references public.routes(key),
  stop_id              uuid not null references public.stops(id),
  singles_back         int not null default 0,
  doubles_back         int not null default 0,
  submitted_by         uuid references public.people(id) on delete set null,
  submitted_at         timestamptz not null default now(),
  synced_to_sheet_at   timestamptz,
  unique (for_date, stop_id)
);
create index if not exists returns_date_idx on public.returns(for_date, route_key);

-- ─── RPC: verify_pin ───────────────────────────────────────────────
-- Called by the Vercel sign-in handler via the service role key.
-- Returns the person's id/name/role on success, nothing on failure.
-- SECURITY DEFINER lets this bypass RLS; crypt() does the bcrypt check.
-- NOTE: pgcrypto installs into the `extensions` schema on Supabase, not
-- `public`. SECURITY DEFINER functions get a locked-down search_path, so
-- we have to list `extensions` explicitly or crypt() is unresolvable.
create or replace function public.verify_pin(p_name text, p_pin text)
returns table(id uuid, name text, role user_role)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select p.id, p.name, p.role
    from public.people p
    where p.name = p_name
      and p.pin_hash = crypt(p_pin, p.pin_hash)
    limit 1;
end
$$;
revoke all on function public.verify_pin(text, text) from public, anon, authenticated;

-- ─── RLS: deny-by-default on every table ───────────────────────────
-- No tables grant any policies to anon/authenticated. The service role
-- bypasses RLS entirely, so our Vercel API routes still have full
-- access. Direct browser calls via anon key get nothing.
alter table public.people              enable row level security;
alter table public.routes              enable row level security;
alter table public.shifts              enable row level security;
alter table public.stops               enable row level security;
alter table public.updates             enable row level security;
alter table public.update_acks         enable row level security;
alter table public.time_off_requests   enable row level security;
alter table public.cover_offers        enable row level security;
alter table public.returns             enable row level security;
