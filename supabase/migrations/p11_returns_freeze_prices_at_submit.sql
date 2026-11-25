-- p11_returns_freeze_prices_at_submit — freeze the per-unit prices the row
-- was billed at onto the row itself. Makes every historical sold_cents
-- reproducible without relying on current stops.price_* (which can change).

alter table public.returns
  add column if not exists price_single_cents_at_submit integer,
  add column if not exists price_double_cents_at_submit integer;

-- Backfill. For 100% of rows, ps was always 215 (no stop has ever had a
-- non-215 single price). pd can be recovered exactly for any row that
-- sold at least one double, because 215 is the only observed single
-- price and the derived pd always comes out a whole integer in [350, 385].
-- Rows with 0 doubles sold get the stop's current pd (or the 385 default)
-- — the pd wasn't exercised on that row so any sane number is consistent
-- with sold_cents.
update public.returns r
set
  price_single_cents_at_submit = 215,
  price_double_cents_at_submit = case
    when r.sold_doubles > 0
      then (r.sold_cents - r.sold_singles * 215) / r.sold_doubles
    else coalesce(
      (select s.price_double_cents from public.stops s where s.id = r.stop_id),
      385
    )
  end
where r.price_single_cents_at_submit is null
   or r.price_double_cents_at_submit is null;
