-- P7 — Human-readable store codes for URLs.
--
-- Each stop can carry a short alphanumeric identifier (e.g. "711 SRRVC")
-- that becomes its sign-in URL slug: /store/711SRRVC. Codes are stored
-- as the operator types them (preserved for display) but matched on a
-- normalized form (uppercase, no whitespace). A unique index on the
-- normalized form prevents two stops colliding.
--
-- Safe to re-run.

alter table public.stops
  add column if not exists store_code text;

-- The normalized form used for URL/API lookup. GENERATED ALWAYS so the
-- app never has to remember to update it.
alter table public.stops
  add column if not exists store_code_norm text
  generated always as (regexp_replace(upper(coalesce(store_code,'')), '[^A-Z0-9]', '', 'g')) stored;

-- Unique across non-empty codes.
create unique index if not exists stops_code_norm_uniq
  on public.stops(store_code_norm)
  where store_code_norm <> '';

-- RPC: resolve a store by code (normalized match), returning its id for
-- the sign-in flow. SECURITY DEFINER + explicit search_path for safety.
create or replace function public.find_stop_by_code(p_code text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select s.id from public.stops s
  where s.active
    and s.store_code_norm = regexp_replace(upper(coalesce(p_code,'')), '[^A-Z0-9]', '', 'g')
    and s.store_code_norm <> ''
  limit 1;
$$;
revoke all on function public.find_stop_by_code(text) from public, anon, authenticated;
