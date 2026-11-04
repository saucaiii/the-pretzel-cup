-- P15 — Wholesale order audit columns + 'invoiced' status.
--
-- Follow-up to P14: adds the operator control surface state.
--   - 'invoiced' slots into the status enum between 'awaiting_payment'
--     and 'paid'. Lifecycle today:
--         awaiting_payment → invoiced → paid
--                           ↘        ↘
--                           cancelled cancelled
--   - Five nullable audit columns on wholesale_orders record WHO
--     transitioned the order and WHEN. Operator id is the signed-in
--     people.id (JWT sub); FK is ON DELETE SET NULL so audit rows
--     outlive an operator removal.
--
-- Safe to re-run:
--   ADD VALUE IF NOT EXISTS   on the enum,
--   ADD COLUMN IF NOT EXISTS  on the table.
--
-- NOTE: ALTER TYPE … ADD VALUE cannot run inside a transaction block.
-- Apply this file statement-by-statement (the Supabase MCP
-- apply_migration call handles that; psql does too when the file is
-- piped without a wrapping BEGIN).

alter type wholesale_order_status add value if not exists 'invoiced' before 'paid';

alter table public.wholesale_orders
  add column if not exists invoiced_at   timestamptz,
  add column if not exists invoiced_by   uuid references public.people(id) on delete set null,
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid references public.people(id) on delete set null,
  add column if not exists paid_by       uuid references public.people(id) on delete set null;
