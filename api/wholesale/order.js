// GET / PATCH /api/wholesale/order?o=<order_id>
//
// GET  (public, order-id gated): receipt-shaped payload used by
//      /wholesale/success. Anyone with the unguessable UUID can see the
//      order, same model Stripe receipt emails use.
//      If the caller ALSO has a valid operator session, the response
//      grows an `email_history` array (campaign emails this customer
//      has received) and exposes a few operator-only fields. Public
//      callers never see email_history.
//
// PATCH (operator-gated): advance the order's status. Body `{status}`.
//      Server-side transition table:
//        awaiting_payment → invoiced | paid | cancelled
//        invoiced         → paid     | cancelled
//        (anything else)  → 409 Conflict
//      On a valid transition, stamps the matching audit column
//      (<state>_at + <state>_by, where <state>_by is the operator's
//      people.id read from the JWT `sub` claim).
//
// The order_id is the sharable, unguessable UUID. GET deliberately
// omits: customer email/phone/notes (customer knows those), internal
// src_tag / email_send_id — unless the caller is an operator.

const { createClient } = require('@supabase/supabase-js');
const { readSession } = require('../_lib/auth');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Terminal states have no outgoing transitions here (refunded + draft
// are reserved for future / out-of-band handling).
const TRANSITIONS = {
  awaiting_payment: new Set(['invoiced', 'paid', 'cancelled']),
  invoiced:         new Set(['paid', 'cancelled']),
  paid:             new Set(),
  cancelled:        new Set(),
  refunded:         new Set(),
  draft:            new Set(),
};

// Fields returned to anyone with a valid order UUID (public receipt).
const PUBLIC_SELECT =
  'status, items, subtotal_cents, discount_cents, total_cents, ' +
  'pickup_location, pickup_date, pickup_time, promo_code, created_at, paid_at';

// Full row for operators. Audit columns included so the dashboard can
// show "invoiced by …, paid by …" without a second query.
const OPERATOR_SELECT =
  PUBLIC_SELECT +
  ', id, customer_id, email_send_id, src_tag, notes, ' +
  'invoiced_at, invoiced_by, cancelled_at, cancelled_by, paid_by';

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Older Vercel runtime: stream the body.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { return {}; }
}

async function emailHistoryFor(customerId) {
  // Join through campaign_email so each row carries the email's
  // position + subject. Ordered by send-position for a stable UI.
  const { data, error } = await sb
    .from('wholesale_email_sends')
    .select(`
      sent_at, opened_at, first_clicked_at, click_count,
      campaign_email:wholesale_campaign_emails (
        position, subject, send_date
      )
    `)
    .eq('customer_id', customerId);
  if (error) return [];
  const rows = (data || []).map(r => ({
    position:         r.campaign_email ? r.campaign_email.position  : null,
    subject:          r.campaign_email ? r.campaign_email.subject   : null,
    send_date:        r.campaign_email ? r.campaign_email.send_date : null,
    sent_at:          r.sent_at,
    opened_at:        r.opened_at,
    first_clicked_at: r.first_clicked_at,
    click_count:      r.click_count,
  }));
  rows.sort((a, b) => (a.position || 0) - (b.position || 0));
  return rows;
}

async function handleGet(req, res, id) {
  // Operator session is optional on GET — the UUID-gated public receipt
  // path stays intact. `readSession` returns the payload or null.
  const sess = await readSession(req);
  const isOperator = !!(sess && sess.role === 'operator');

  const { data, error } = await sb
    .from('wholesale_orders')
    .select(isOperator ? OPERATOR_SELECT : PUBLIC_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'lookup failed' });
  if (!data)  return res.status(404).json({ error: 'order not found' });

  res.setHeader('Cache-Control', 'no-store');
  const payload = { order: data };
  if (isOperator && data.customer_id) {
    payload.email_history = await emailHistoryFor(data.customer_id);
  }
  return res.status(200).json(payload);
}

async function handlePatch(req, res, id) {
  const sess = await readSession(req);
  if (!sess)                        return res.status(401).json({ error: 'not signed in' });
  if (sess.role !== 'operator')     return res.status(403).json({ error: 'wrong role' });

  const body = await readJsonBody(req);
  const next = typeof body.status === 'string' ? body.status.trim() : '';
  if (!next || !(next in TRANSITIONS)) {
    return res.status(400).json({ error: 'invalid status' });
  }

  const { data: current, error: curErr } = await sb
    .from('wholesale_orders')
    .select('id, status')
    .eq('id', id)
    .maybeSingle();
  if (curErr)   return res.status(500).json({ error: 'lookup failed' });
  if (!current) return res.status(404).json({ error: 'order not found' });

  // No-op transitions return 409 rather than silently succeeding —
  // the UI should disable buttons for the current state.
  if (current.status === next) {
    return res.status(409).json({
      error: 'order already in that status',
      current: current.status,
    });
  }
  const allowed = TRANSITIONS[current.status] || new Set();
  if (!allowed.has(next)) {
    return res.status(409).json({
      error: `cannot move from ${current.status} to ${next}`,
      current: current.status,
      allowed: Array.from(allowed),
    });
  }

  const now = new Date().toISOString();
  const patch = { status: next };
  if (next === 'invoiced')  { patch.invoiced_at  = now; patch.invoiced_by  = sess.sub; }
  if (next === 'paid')      { patch.paid_at      = now; patch.paid_by      = sess.sub; }
  if (next === 'cancelled') { patch.cancelled_at = now; patch.cancelled_by = sess.sub; }

  const { data: updated, error: upErr } = await sb
    .from('wholesale_orders')
    .update(patch)
    .eq('id', id)
    .select(OPERATOR_SELECT)
    .single();
  if (upErr) return res.status(500).json({ error: 'update failed' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ order: updated });
}

module.exports = async function handler(req, res) {
  const id = (req.query && req.query.o) ? String(req.query.o).trim() : '';
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'order id required' });
  }
  if (req.method === 'GET')   return handleGet(req, res, id);
  if (req.method === 'PATCH') return handlePatch(req, res, id);
  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'method not allowed' });
};
