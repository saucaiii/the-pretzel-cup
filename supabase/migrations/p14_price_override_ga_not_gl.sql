-- P14 — Move the FBW shorts-doubles override from 711 GL to 711 GA.
--
-- Earlier p13 seeded both 711 GL and 711 ATLF with price_double_cents = 350.
-- The GL assignment was wrong: the stop that gets $3.50 doubles on the Baldwin
-- route is 711 GA, not 711 GL. 711 ATLF stays at $3.50.
--
-- Idempotent: null-coalesces GL back to global default; sets GA.
update public.stops set price_double_cents = null where name = '711 GL';
update public.stops set price_double_cents = 350  where name = '711 GA';
