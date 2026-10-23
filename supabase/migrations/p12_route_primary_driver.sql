-- p11_route_primary_driver — one primary driver per route, used to
-- auto-fill the "Your pretzels come from …" driver card in the print
-- bundle. Nullable so rolling out migration p11 before setting the
-- values doesn't break anything; the print bundle falls back to a
-- generic card when a route has no primary driver yet.
--
-- No backfill: operator sets these via /ops/driver-routes.

alter table public.routes
  add column if not exists primary_driver_id uuid references public.people(id) on delete set null;

create index if not exists routes_primary_driver_idx
  on public.routes(primary_driver_id)
  where primary_driver_id is not null;
