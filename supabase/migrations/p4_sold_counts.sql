-- P4 — add sold_singles / sold_doubles columns to returns.
--
-- Driver UI now takes counts (singles sold, doubles sold) per stop.
-- Server computes sold_cents = singles * 215 + doubles * 385 using the
-- fixed pricing. Nullable so existing rows don't break.
--
-- Safe to re-run.
alter table public.returns add column if not exists sold_singles int;
alter table public.returns add column if not exists sold_doubles int;
