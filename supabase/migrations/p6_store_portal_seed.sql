-- P6 seed — optional day-1 convenience.
--
-- Give every active stop PIN "0000" and a sensible display name, so
-- Chris can hand out the stub PIN on the next round of deliveries and
-- have each store manager rotate to their own PIN on first sign-in
-- (the portal treats 0000 as must-rotate).
--
-- Run AFTER p6_store_portal.sql. Idempotent: only sets a PIN where
-- one is not already set, and only backfills a display name where
-- none is set.

update public.stops
set store_pin_hash = public.hash_pin('0000')
where active and store_pin_hash is null;

update public.stops
set store_display_name = concat(name, ' — ', town)
where active and store_display_name is null;
