// GET /api/wholesale/order?session_id=cs_...
//
// Public endpoint used by /wholesale/success. Looks up an order by
// its stripe_session_id (unguessable → safe as a share token). Returns
// a receipt-shaped payload: items, totals, pickup info, and status.
//
// Returns 404 if the session id doesn't match. Returns the order even
// if status is 'awaiting_payment' — the success page will tell the
// customer their order is pending webhook confirmation.
//
// Deliberately NOT returned:
//   - customer email, phone (the customer already knows these; they're
//     also already shown by Stripe's receipt email anyway).
//   - internal ids (customer_id, email_send_id, src_tag).

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const sid = (req.query && req.query.session_id) ? String(req.query.session_id).trim() : '';
  // Stripe session ids look like cs_test_… / cs_live_… — reject
  // anything that doesn't fit, so SQL doesn't even see garbage.
  if (!sid || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sid)) {
    return res.status(400).json({ error: 'session_id required' });
  }

  const { data, error } = await sb
    .from('wholesale_orders')
    .select('status, items, subtotal_cents, discount_cents, total_cents, pickup_location, pickup_address, pickup_date, pickup_time, promo_code, created_at, paid_at')
    .eq('stripe_session_id', sid)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'lookup failed' });
  if (!data)  return res.status(404).json({ error: 'order not found' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ order: data });
};
