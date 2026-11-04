-- p20_leads — Inbound-lead capture for /apply.
--
-- Every prospect who fills the route-delivery pitch packet's QR / web
-- form lands here. Chris reads them via Telegram (the api/leads.js
-- POST handler notifies the ops group on insert) and later via an
-- /ops/leads admin view (follow-up PR).
--
-- No user-facing reads: writes come from the serverless function
-- using the service-role key. RLS stays deny-all.

create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),

  -- Lifecycle. 'new' on insert; operator mutates via admin view.
  status            text not null default 'new'
                    check (status in ('new','contacted','qualified','signed','dead')),

  -- Business + contact fields the form collects. Business name,
  -- contact name, and phone are the three we actually need; the rest
  -- are nice-to-have so the form stays short.
  business_name     text not null,
  contact_name      text not null,
  role              text,
  address           text,
  city              text,
  state             text,
  zip               text,
  phone             text not null,
  email             text,
  est_foot_traffic  integer
                    check (est_foot_traffic is null or est_foot_traffic between 0 and 1000000),
  notes             text,

  -- Attribution: where the lead came from (pitch-kit QR, direct URL,
  -- referral, etc.). Default assumes the pitch packet since that's
  -- the only driver at launch.
  source            text not null default 'pitch-kit-qr',

  -- Audit fields set by the serverless handler, not the form.
  user_agent        text,
  ip_hash           text,                 -- sha256(ip + salt), not raw IP

  -- Follow-up tracking set when operator acts on the lead.
  handled_by        uuid references public.people(id) on delete set null,
  handled_at        timestamptz
);

-- Fast "show me new leads newest-first" for the admin view.
create index if not exists leads_status_created_idx
  on public.leads(status, created_at desc);

-- Dedupe lookup: avoid logging the same prospect twice if they
-- resubmit within a few minutes (the POST handler checks).
create index if not exists leads_phone_recent_idx
  on public.leads(phone, created_at desc);

-- Lock the table down. RLS on + no policies = only service role reads/writes.
alter table public.leads enable row level security;
