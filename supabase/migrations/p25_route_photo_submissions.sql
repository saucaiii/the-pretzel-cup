-- p25_route_photo_submissions — bi-weekly Friday box-photo tracking.
--
-- Drivers photograph every box on their route every other Friday
-- (anchor: 2026-12-05). Photos land in Google Drive; this table is
-- the source of truth for enforcement:
--   * photos_count gates the "submit route" button server-side.
--   * telegram_message_id guarantees we post the Drive folder link to
--     the group chat EXACTLY ONCE per (for_date, route, driver),
--     even if the driver re-submits.
--
-- Drive is the medium (photos); this table is the state. A companion
-- row is also appended to the "Box Photos" tab in the Daily Delivery
-- Sales Report as a human-readable log (best-effort, non-blocking).

begin;

create table if not exists public.route_photo_submissions (
  id                   uuid primary key default gen_random_uuid(),
  for_date             date not null,
  route_key            text not null references public.routes(key),
  driver_id            uuid not null references public.people(id),
  drive_folder_id      text not null,
  drive_folder_link    text not null,
  photos_count         int  not null default 0,
  telegram_message_id  bigint,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (for_date, route_key, driver_id)
);

create index if not exists route_photo_submissions_date_idx
  on public.route_photo_submissions (for_date);

-- Deny-all RLS; service role bypass (same convention as returns/people).
alter table public.route_photo_submissions enable row level security;

commit;
