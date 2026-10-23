-- P8 — Shorter-pretzel variant flag.
--
-- Some stops receive shorter pretzels (physical size variant). Same
-- price, same packaging, just a shorter twist. Baked exclusively at
-- the Lynbrook bakery; Franklin Square does not bake shorts.
--
-- One flag per stop covers both singles and doubles at that stop. The
-- baker view rolls up a separate "SHORTS batch" line at Lynbrook so
-- bakers know how many to pull short; the driver view puts a SHORTS
-- badge on each affected stop so the right bags go to the right store.
--
-- Safe to re-run.

alter table public.stops
  add column if not exists shorts boolean not null default false;

-- Initial per-stop flags based on confirmed state (as of 2026-10-23):
--   LYN shorts: Bway, SR, NCA, M2, LAW, LBR
--   FBW:        all 9 stops
--   FSQ:        none (Franklin Square bakery does not bake shorts)

update public.stops set shorts = true
  where route_key = 'LYN'
    and name in ('711 Bway','711 SR','711 NCA','711 M2','711 LAW','711 LBR');

update public.stops set shorts = true
  where route_key = 'FBW';
