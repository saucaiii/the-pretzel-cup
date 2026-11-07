-- p11_pretzel_packs_bonus: Golden Ticket pack + per-player game record.
--
-- HUMAN STEP: apply this by hand in Supabase (or authorize the agent in
-- chat). Agents do not run it. Additive only: existing rows untouched.
--
-- Golden Ticket: one extra voucher (source 'bonus') after all 4 free
-- pretzels (first, instagram, email, app). Same unique
-- (player_id, offer_key, source) caps it at 1 per player per offer.
-- The prize is one fixed item per offer (not a draw). The texts are
-- copied onto the voucher when it opens:
--   prize_title, prize_public  shown to the customer
--   prize_staff                internal, shown only to staff after the PIN
--
-- pack_games: how each player's game went, per offer. Only a score, an
-- end state and timestamps against the existing player id. No email, IP
-- or device data.
--   ended null            still playing, or left (reported at last score)
--   ended 'completed'     opened all 4 pretzels (completed_all = true)
--   ended 'stopped_at_3'  tapped "I don't need another app" at 3
--
-- Reads and writes come only from api/_packs.js with the service-role
-- key. RLS on with no policies = deny-all for anon and authenticated.

alter table public.pack_vouchers drop constraint if exists pack_vouchers_source_check;
alter table public.pack_vouchers add constraint pack_vouchers_source_check
  check (source in ('first','email','instagram','app','bonus'));

alter table public.pack_vouchers
  add column if not exists prize_title  text check (prize_title  is null or char_length(prize_title)  <= 40),
  add column if not exists prize_public text check (prize_public is null or char_length(prize_public) <= 120),
  add column if not exists prize_staff  text check (prize_staff  is null or char_length(prize_staff)  <= 60);

create table if not exists public.pack_games (
  player_id      uuid not null references public.pack_players(id) on delete cascade,
  offer_key      text not null,
  score          integer not null default 0 check (score between 0 and 4),
  ended          text check (ended is null or ended in ('completed','stopped_at_3')),
  completed_all  boolean not null default false,
  started_at     timestamptz not null default now(),
  last_at        timestamptz not null default now(),
  ended_at       timestamptz,
  primary key (player_id, offer_key),
  check ((ended is null) = (ended_at is null)),
  check (completed_all = (ended is not distinct from 'completed'))
);

create index if not exists pack_games_offer_idx
  on public.pack_games(offer_key, ended, score);

alter table public.pack_games enable row level security;

-- Rollback (only if no 'bonus' vouchers exist):
--   drop table if exists public.pack_games;
--   alter table public.pack_vouchers drop column if exists prize_title,
--     drop column if exists prize_public, drop column if exists prize_staff;
--   alter table public.pack_vouchers drop constraint if exists pack_vouchers_source_check;
--   alter table public.pack_vouchers add constraint pack_vouchers_source_check
--     check (source in ('first','email','instagram','app'));
