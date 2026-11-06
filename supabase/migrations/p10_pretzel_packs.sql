-- p10_pretzel_packs: pack-opening game on /free-pretzels.
--
-- HUMAN STEP: apply this by hand in Supabase. Agents do not run it.
--
-- Every pack wins one free pretzel. A player gets one pack per offer,
-- plus one for a verified email, one for an Instagram follow and one for
-- an App Store download tap: at most 4 per player per offer. The cap and the double-open race are
-- enforced by the unique (player_id, offer_key, source) constraint, so
-- two taps at once can never mint two vouchers for the same slot.
--
-- Personal data: pack_players.email is set only after the magic link is
-- clicked. Retention (follow-up job, not built here): emails without
-- marketing_opt_in are deleted 30 days after the offer ends.
--
-- Reads and writes come only from api/_packs.js with the service-role
-- key. RLS on with no policies = deny-all for anon and authenticated.

create table if not exists public.pack_players (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,               -- lowercased, verified only
  email_verified_at  timestamptz,
  marketing_opt_in   boolean not null default false,
  instagram_at       timestamptz,
  app_at             timestamptz,                 -- App Store download tap (honor system)
  created_at         timestamptz not null default now(),
  check (email is null or email = lower(email)),
  check ((email is null) = (email_verified_at is null))
);

create table if not exists public.pack_vouchers (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique
                  check (code ~ '^[A-Z0-9]{8}$'),
  player_id       uuid not null references public.pack_players(id) on delete cascade,
  offer_key       text not null,
  source          text not null check (source in ('first','email','instagram','app')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  redeemed_at     timestamptz,
  redeemed_store  text check (redeemed_store is null or redeemed_store in ('lynbrook','franklin_square')),
  pin_failures    integer not null default 0 check (pin_failures >= 0),
  unique (player_id, offer_key, source)
);

create index if not exists pack_vouchers_player_offer_idx
  on public.pack_vouchers(player_id, offer_key);
create index if not exists pack_vouchers_offer_idx
  on public.pack_vouchers(offer_key, created_at desc);

create table if not exists public.pack_magic_links (
  token_hash        text primary key,           -- sha256 hex of the emailed token
  player_id         uuid not null references public.pack_players(id) on delete cascade,
  email             text not null check (email = lower(email)),
  marketing_opt_in  boolean not null default false,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  used_at           timestamptz
);

create index if not exists pack_magic_links_expires_idx
  on public.pack_magic_links(expires_at);

alter table public.pack_players     enable row level security;
alter table public.pack_vouchers    enable row level security;
alter table public.pack_magic_links enable row level security;
