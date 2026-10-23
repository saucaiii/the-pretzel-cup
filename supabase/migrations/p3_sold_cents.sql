-- P3 fix — the returns table was built around returns (singles_back,
-- doubles_back). Flipped to direct sold dollars per stop to match the
-- Google Form drivers already use.
--
-- sold_cents = integer dollars-and-cents the driver typed, e.g. 1970
-- for $19.70. Nullable because singles_back / doubles_back rows live
-- here too (legacy, from the one P3 test row).
--
-- Safe to re-run.

alter table public.returns add column if not exists sold_cents integer;
