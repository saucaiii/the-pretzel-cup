-- P16 — Wholesale invoice numbering.
--
-- Follow-up to P14+P15: adds a sequential `invoice_number` so the
-- server-generated PDF invoice carries a stable, human-sortable number
-- in the style of the Pretzels of Long Island LLC paper invoices (today
-- numbered in the 3000s-4000s). Sequence starts at 5000 to sit above
-- the existing manual range without colliding.
--
-- Allocation rule: the number is bound at the moment an order first
-- transitions to 'invoiced'. The RPC `assign_invoice_number` does this
-- inside a single UPDATE (CAS on status + COALESCE on the column) so:
--   - two operators racing both see one winner (CAS),
--   - a send that fails and rolls status back keeps the number (COALESCE
--     on retry reuses it — no new number burned, no duplicate issued).
--
-- Safe to re-run:
--   `create sequence if not exists`,
--   `add column if not exists`,
--   `create unique index if not exists` (partial, allows NULLs),
--   `create or replace function` for the RPC.

create sequence if not exists public.wholesale_invoice_number_seq
  start with 5000
  increment by 1;

alter table public.wholesale_orders
  add column if not exists invoice_number int;

-- Partial unique index: allows historical NULLs (orders that never got
-- invoiced, or pre-existing rows) while guaranteeing no two orders
-- share the same allocated number.
create unique index if not exists wholesale_orders_invoice_number_uidx
  on public.wholesale_orders (invoice_number)
  where invoice_number is not null;

-- RPC: atomic CAS-claim + invoice-number allocation.
--
-- Called only by api/wholesale/invoice.js on the live-send path. Does
-- the same job as the plain `.update({ status, invoiced_at, invoiced_by })`
-- claim in the existing code, plus allocates/reuses `invoice_number`
-- in the same statement. Returns a single row on success, empty set on
-- CAS miss (so the caller sees `data=null` the same way a `.maybeSingle()`
-- update does).
--
-- SECURITY DEFINER is deliberately NOT set — the handler calls this
-- with the service-role key, which already bypasses RLS. Running as
-- the caller keeps the privilege surface identical to today.
create or replace function public.assign_invoice_number(
  p_order_id       uuid,
  p_required_from  wholesale_order_status,
  p_invoiced_by    uuid,
  p_invoiced_at    timestamptz
) returns table (
  invoice_number int
) language sql as $$
  update public.wholesale_orders
     set status         = 'invoiced',
         invoiced_at    = p_invoiced_at,
         invoiced_by    = p_invoiced_by,
         invoice_number = coalesce(invoice_number,
                                   nextval('public.wholesale_invoice_number_seq'))
   where id     = p_order_id
     and status = p_required_from
  returning wholesale_orders.invoice_number;
$$;

-- Service role calls the RPC; no grants needed beyond defaults. If a
-- future caller hits this with the anon key, Postgres will fail the
-- UPDATE under RLS before the function runs.
