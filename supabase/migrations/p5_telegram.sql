-- P5 — Telegram link columns on people.
--
-- telegram_handle:  the @username operator types in /ops/people, no "@" prefix.
-- telegram_user_id: the numeric Telegram user id. Filled in automatically on
-- the first "Got it" tap in Telegram (we look up the person by handle at
-- that moment and persist the id so later taps bind instantly without a
-- lookup). Nullable because new users will be bound lazily.
--
-- Safe to re-run.
alter table public.people add column if not exists telegram_handle  text;
alter table public.people add column if not exists telegram_user_id bigint;

-- Unique when set (two people can't share a Telegram id).
create unique index if not exists people_tg_user_id_uniq
  on public.people(telegram_user_id) where telegram_user_id is not null;
create unique index if not exists people_tg_handle_uniq
  on public.people(lower(telegram_handle)) where telegram_handle is not null;
