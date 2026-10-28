-- P13 — Per-stop price overrides.
--
-- Default pricing is $2.15 single / $3.85 double (215/385 cents, hardcoded in
-- api/driver/submit.js and driver/index.html). Some 7-Eleven stops get shorter
-- pretzels at a different price. Rather than hardcoding exceptions, store the
-- override on the stop. Null = fall back to the global default.
--
alter table public.stops
  add column if not exists price_single_cents integer null,
  add column if not exists price_double_cents integer null;

do $$ begin
  alter table public.stops
    add constraint stops_price_single_cents_chk check (price_single_cents is null or price_single_cents between 0 and 10000);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.stops
    add constraint stops_price_double_cents_chk check (price_double_cents is null or price_double_cents between 0 and 10000);
exception when duplicate_object then null; end $$;

-- Guy Lombardo (711 GL) and ATLF (711 ATLF): doubles priced at $3.50.
update public.stops
   set price_double_cents = 350
 where name in ('711 GL', '711 ATLF');
