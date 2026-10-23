-- p9_store_onboarding — new store onboarding wizard support
-- Adds franchisee-manager contact fields and the per-stop delivery-day
-- mask to the stops table so /ops/onboard can persist what the wizard
-- collects. All columns are nullable; existing stops stay valid.

alter table public.stops
  add column if not exists manager_first_name text,
  add column if not exists manager_last_name  text,
  add column if not exists manager_email      text,
  add column if not exists manager_phone      text,
  -- Subset of {'mon','tue','wed','thu','fri','sat','sun'}; empty = unset.
  add column if not exists delivery_days      text[] not null default '{}'::text[];

-- Quick lookup when the welcome-email job scans for stops to notify.
create index if not exists stops_manager_email_idx
  on public.stops(manager_email)
  where manager_email is not null;
