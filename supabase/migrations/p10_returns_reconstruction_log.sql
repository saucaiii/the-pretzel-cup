-- p10_returns_reconstruction_log — audit sidecar for the Sheet-based
-- reconstruction of returns.submitted_by. Every UPDATE the
-- .agent/reconstruct-submitted-by.mjs script performs writes one row here
-- (old/new submitter, source rule, timestamp) so the backfill is fully
-- reversible.

create table if not exists public.returns_reconstruction_log (
  id                uuid        primary key default gen_random_uuid(),
  for_date          date        not null,
  stop_id           uuid        not null references public.stops(id),
  old_submitted_by  uuid                 references public.people(id),
  new_submitted_by  uuid        not null references public.people(id),
  source            text        not null check (source in (
                      'sheet_named',
                      'fallback_chris_blank',
                      'fallback_chris_no_sheet'
                    )),
  ran_at            timestamptz not null default now()
);

create index if not exists returns_reconstruction_log_for_date_stop_idx
  on public.returns_reconstruction_log (for_date, stop_id);

alter table public.returns_reconstruction_log enable row level security;
-- Deny-all RLS is the schema default; server reads via service role.
