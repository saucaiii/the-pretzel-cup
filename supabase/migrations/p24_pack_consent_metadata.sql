-- p24_pack_consent_metadata — CAN-SPAM audit trail for pack_players.
--
-- Slice 2 of the operator-CRM work. Slice 1 shipped an unmasked view
-- of captured emails; this slice locks in WHY we're allowed to contact
-- them: at what moment (marketing_opt_in_at), via which flow
-- (marketing_opt_in_source), and under which version of the privacy
-- page (marketing_opt_in_version). US-only, implicit-consent model:
-- opening the packs + entering an email + verifying = opt-in, with
-- the privacy page disclosing it.
--
-- The existing `marketing_opt_in boolean` column is DEPRECATED and
-- kept for one release so any downstream caller still reading it
-- keeps working. Its value stays in sync (handleVerify writes true).
-- The three new columns are the source of truth from this migration
-- onward.
--
-- Backfill: every pack_players row where email_verified_at is not
-- null gets marketing_opt_in_at = email_verified_at, source and
-- version set to the defaults. These rows verified before this
-- migration under the pack 2 flow, which is the ONLY flow that
-- captures consent today, under the ONLY version of the privacy
-- page that exists today — so the defaults are correct for the
-- backfill, not a guess.

begin;

alter table public.pack_players
  add column if not exists marketing_opt_in_at       timestamptz,
  add column if not exists marketing_opt_in_source   text,
  add column if not exists marketing_opt_in_version  text;

-- Constraints are added separately (idempotent via DO blocks) so a
-- re-run of this migration on a partially-applied database succeeds.
do $$ begin
  alter table public.pack_players
    add constraint pack_players_opt_in_source_chk
    check (marketing_opt_in_source is null
           or marketing_opt_in_source in ('pack2_verify','pitch_kit','manual_backfill'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pack_players
    add constraint pack_players_opt_in_version_chk
    check (marketing_opt_in_version is null
           or char_length(marketing_opt_in_version) between 3 and 60);
exception when duplicate_object then null; end $$;

-- Backfill in the same transaction so the migration is all-or-nothing.
update public.pack_players
   set marketing_opt_in_at      = coalesce(marketing_opt_in_at,      email_verified_at),
       marketing_opt_in_source  = coalesce(marketing_opt_in_source,  'pack2_verify'),
       marketing_opt_in_version = coalesce(marketing_opt_in_version, 'privacy_v1_2026-11')
 where email_verified_at is not null
   and (marketing_opt_in_at is null
        or marketing_opt_in_source is null
        or marketing_opt_in_version is null);

-- Sort-friendly partial index for the Contacts tab's upcoming
-- "sort by consent date" query; partial keeps it small because
-- unverified rows never consent.
create index if not exists idx_pack_players_opt_in_at
  on public.pack_players (marketing_opt_in_at desc)
  where marketing_opt_in_at is not null;

comment on column public.pack_players.marketing_opt_in is
  'Deprecated 2026-11: use marketing_opt_in_at. Kept one release for backwards compat; still written by handleVerify.';

commit;

-- Rollback (reversible as long as no downstream reader has started
-- depending on the three new columns — operator CRM is the only
-- reader today and the UI has a backfill-safe fallback):
--
-- begin;
-- drop index  if exists public.idx_pack_players_opt_in_at;
-- alter table public.pack_players
--   drop constraint if exists pack_players_opt_in_source_chk,
--   drop constraint if exists pack_players_opt_in_version_chk,
--   drop column     if exists marketing_opt_in_at,
--   drop column     if exists marketing_opt_in_source,
--   drop column     if exists marketing_opt_in_version;
-- commit;
