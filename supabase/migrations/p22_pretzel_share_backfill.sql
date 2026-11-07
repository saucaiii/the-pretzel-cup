-- p22_pretzel_share_backfill: rename legacy pretzel 4 rows from 'app'
-- to 'share'.
--
-- HUMAN STEP: apply ONLY AFTER the share code is deployed (p21 first).
-- Applied while the old code is live, a player mid-game could open a
-- second pretzel 4 (old code would no longer see their 'app' voucher).
--
-- The share code reads both names, so this is cleanup: stats and rows
-- then use one name. app_at is kept (not dropped) so the rollback below
-- stays possible; drop it in a later cleanup.

begin;

-- Stop before changing anything if a player holds both an 'app' and a
-- 'share' voucher for one offer (only possible after a code rollback, or
-- from very old builds; the share code voids such a duplicate on email
-- merge). Renaming one would break the unique constraint, and leaving it
-- would fail the new check. Look at those rows by hand, then re-run.
do $$
declare n integer;
begin
  select count(*) into n
    from public.pack_vouchers a
    join public.pack_vouchers s
      on s.player_id = a.player_id and s.offer_key = a.offer_key and s.source = 'share'
   where a.source = 'app';
  if n > 0 then
    raise exception 'p22: % player(s) hold both app and share vouchers; resolve them first', n;
  end if;
end $$;

update public.pack_vouchers set source = 'share' where source = 'app';

update public.pack_players
   set share_at = app_at
 where share_at is null and app_at is not null;

alter table public.pack_vouchers drop constraint if exists pack_vouchers_source_check;
alter table public.pack_vouchers add constraint pack_vouchers_source_check
  check (source in ('first','email','instagram','share','bonus'));

commit;

-- Check after applying (expect 0):
--   select count(*) from public.pack_vouchers where source = 'app';
--
-- Rollback (before redeploying code older than the share release; also
-- run the two updates alone if p22 was never applied):
--   begin;
--   alter table public.pack_vouchers drop constraint if exists pack_vouchers_source_check;
--   alter table public.pack_vouchers add constraint pack_vouchers_source_check
--     check (source in ('first','email','instagram','app','share','bonus'));
--   update public.pack_vouchers set source = 'app' where source = 'share';
--   update public.pack_players set app_at = coalesce(app_at, share_at) where share_at is not null;
--   commit;
