-- Migration applied during P1 (Oct 2026) — adds the set_pin RPC called
-- by /api/auth/change-pin. Kept separate from schema.sql because the
-- schema is a "paste once" doc; this is a point-in-time change.
--
-- Safe to re-run.

create or replace function public.set_pin(p_person_id uuid, p_new_pin text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_new_pin is null or p_new_pin !~ '^\d{4,6}$' then
    raise exception 'invalid pin';
  end if;
  update public.people
    set pin_hash = crypt(p_new_pin, gen_salt('bf', 10))
    where id = p_person_id;
  return found;
end
$$;
revoke all on function public.set_pin(uuid, text) from public, anon, authenticated;
