-- p26_secondary_role — dual-role sign-in.
--
-- Some people have a second role on specific days. Vic bakes M/W/Th/F
-- at the shop and drives the Tuesday route. One row in public.people
-- per person; secondary_role is additive. At sign-in the server returns
-- both roles and the client shows a one-tap chooser; the JWT is then
-- signed with the chosen role, so route gating downstream keeps working
-- unchanged.
--
-- verify_pin() is extended to return secondary_role alongside role so
-- the sign-in handler can branch without a second query. The signature
-- is a superset of the old one; callers that only select the first
-- three columns keep working, which is also our rollback story (revert
-- the Node code and leave this migration applied).

begin;

alter table public.people
  add column if not exists secondary_role user_role;

-- Dual-role seed. Vic is the only dual-role person today: primary
-- baker, drives the Tuesday route. Idempotent — safe to re-apply.
update public.people
   set secondary_role = 'driver'
 where name = 'Vic'
   and (secondary_role is null or secondary_role <> 'driver');

-- Redefine verify_pin to return secondary_role too. SECURITY DEFINER
-- and locked-down search_path carry over from the original definition
-- in schema.sql; extensions must stay listed or crypt() is unresolvable
-- on Supabase (pgcrypto installs into `extensions`, not `public`).
--
-- Postgres can't change a function's return signature with CREATE OR
-- REPLACE, so drop first. No callers hold a reference between these
-- statements inside the same transaction.
drop function if exists public.verify_pin(text, text);

create function public.verify_pin(p_name text, p_pin text)
returns table(id uuid, name text, role user_role, secondary_role user_role)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
    select p.id, p.name, p.role, p.secondary_role
    from public.people p
    where p.name = p_name
      and p.pin_hash = crypt(p_pin, p.pin_hash)
    limit 1;
end
$$;

revoke all on function public.verify_pin(text, text) from public, anon, authenticated;

commit;
