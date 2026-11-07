-- p21_pretzel_share: pretzel 4 becomes "Share with your group chat".
--
-- HUMAN STEP: apply this by hand in Supabase (or authorize the agent in
-- chat). Agents do not run it. Additive only: existing rows untouched,
-- so it is safe to apply while the old code (source 'app') is live.
--
-- Order: apply p21 -> merge + deploy the share code -> apply p22.
-- The share code writes source 'share' and pack_players.share_at, and
-- still reads legacy 'app' vouchers and app_at as pretzel 4 until p22
-- renames them.
--
-- Code rollback after the share release is deployed (before or after
-- p22): first turn share back into app (p22's rollback block, which also
-- copies share_at into app_at), or players who shared lose pretzel 4 on
-- the old code.
--
-- share_at: the player tapped share (honor system; a send cannot be
-- checked). Only a timestamp, no recipient or message data.

begin;

alter table public.pack_players
  add column if not exists share_at timestamptz;

alter table public.pack_vouchers drop constraint if exists pack_vouchers_source_check;
alter table public.pack_vouchers add constraint pack_vouchers_source_check
  check (source in ('first','email','instagram','app','share','bonus'));

commit;

-- Rollback (only if no 'share' vouchers exist):
--   alter table public.pack_vouchers drop constraint if exists pack_vouchers_source_check;
--   alter table public.pack_vouchers add constraint pack_vouchers_source_check
--     check (source in ('first','email','instagram','app','bonus'));
--   alter table public.pack_players drop column if exists share_at;
