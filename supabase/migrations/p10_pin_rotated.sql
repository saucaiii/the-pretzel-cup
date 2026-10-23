-- p10_pin_rotated — track whether a store manager has rotated off the
-- starter PIN. The P6 seed set 0000 as the starter for every active
-- stop; a manager who successfully calls /api/store?resource=change-pin
-- flips this to true. /ops/invite uses it to show adoption buckets:
-- "awaiting first login" vs. "active".
--
-- The default of false captures existing stops correctly: every seeded
-- row is on 0000 and hasn't rotated. No backfill required.

alter table public.stops
  add column if not exists pin_rotated boolean not null default false;
