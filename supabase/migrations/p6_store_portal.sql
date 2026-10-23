-- P6 — Store portal: per-stop PIN logins, issues, and drop-change requests.
--
-- Store managers (7-Eleven franchisees) sign in with their stop as the
-- identity. They are NOT people rows — no row in `people`, no entry in the
-- user_role enum. Instead the stops table carries a bcrypt pin_hash and
-- the sign-in RPC returns the stop id, which the Vercel handler mints
-- into a JWT with role='store' (JWT-only role; schema is unchanged).
--
-- Safe to re-run.

-- ─── stops: PIN + display columns ──────────────────────────────────
alter table public.stops
  add column if not exists store_pin_hash     text,
  add column if not exists store_display_name text,
  add column if not exists contact_phone      text;

-- Only one active stop per (route, name, town) can be the login identity;
-- the sign-in picker shows id directly so no uniqueness constraint is
-- needed on display_name.

-- ─── enums for issues + change requests ────────────────────────────
do $$ begin create type stop_issue_kind    as enum ('short_count','long_count','missed','damage','other'); exception when duplicate_object then null; end $$;
do $$ begin create type stop_issue_status  as enum ('open','acknowledged','resolved');                     exception when duplicate_object then null; end $$;
do $$ begin create type stop_change_kind   as enum ('double','skip','custom');                             exception when duplicate_object then null; end $$;
do $$ begin create type stop_change_status as enum ('pending','approved','denied','applied');              exception when duplicate_object then null; end $$;

-- ─── stop_issues: short counts, damage, misses ─────────────────────
-- for_date is nullable (an 'other' issue not tied to a specific drop).
create table if not exists public.stop_issues (
  id          uuid primary key default gen_random_uuid(),
  stop_id     uuid not null references public.stops(id) on delete cascade,
  for_date    date,
  kind        stop_issue_kind   not null,
  note        text              not null,
  status      stop_issue_status not null default 'open',
  resolved_by uuid references public.people(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists stop_issues_stop_idx on public.stop_issues(stop_id, created_at desc);
create index if not exists stop_issues_open_idx on public.stop_issues(status) where status <> 'resolved';

-- ─── stop_change_requests: future-dated drop adjustments ───────────
-- 'double'/'skip' leave the deltas NULL — operator applies the semantic.
-- 'custom' uses singles_delta / doubles_delta as explicit overrides.
create table if not exists public.stop_change_requests (
  id             uuid primary key default gen_random_uuid(),
  stop_id        uuid not null references public.stops(id) on delete cascade,
  effective_date date not null,
  kind           stop_change_kind   not null,
  singles_delta  int,
  doubles_delta  int,
  note           text,
  status         stop_change_status not null default 'pending',
  decided_by     uuid references public.people(id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists stop_change_stop_idx    on public.stop_change_requests(stop_id, effective_date);
create index if not exists stop_change_pending_idx on public.stop_change_requests(status) where status = 'pending';

-- ─── RPC: verify_stop_pin ──────────────────────────────────────────
-- Mirrors verify_pin for staff. Returns the stop's id/name/town on
-- success. SECURITY DEFINER + explicit search_path so pgcrypto's crypt()
-- in the `extensions` schema resolves inside the locked-down path.
create or replace function public.verify_stop_pin(p_stop_id uuid, p_pin text)
returns table(id uuid, name text, town text, route_key text, store_display_name text)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select s.id, s.name, s.town, s.route_key, s.store_display_name
    from public.stops s
    where s.id = p_stop_id
      and s.active
      and s.store_pin_hash is not null
      and s.store_pin_hash = crypt(p_pin, s.store_pin_hash)
    limit 1;
end
$$;
revoke all on function public.verify_stop_pin(uuid, text) from public, anon, authenticated;

-- ─── RLS: deny-all on the new tables ──────────────────────────────
alter table public.stop_issues          enable row level security;
alter table public.stop_change_requests enable row level security;

-- ─── Convenience: a helper to hash a plaintext PIN for operator CLI
-- usage. Not called from app code; a one-liner for running in the SQL
-- editor to seed PINs. Example:
--   update public.stops set store_pin_hash = public.hash_pin('0000') where id = '...';
create or replace function public.hash_pin(p_pin text)
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select crypt(p_pin, gen_salt('bf', 10));
$$;
revoke all on function public.hash_pin(text) from public, anon, authenticated;
