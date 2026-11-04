// GET /api/wholesale/order?o=<order_id>
//
// Public endpoint used by /wholesale/success. Looks up an order by
// its id (a UUID, unguessable → safe as a share token). Returns a
// receipt-shaped payload: items, totals, pickup info, and status.
//
// The order_id is passed back in the submit response and embedded in
// the success-page URL. Anyone with the URL can see the order, which
// is the same model Stripe's receipt emails use.
//
// Returns 404 if the id doesn't match. Returns the order even when
// status is still `awaiting_payment` — that is the normal state
// immediately after submission.
//
// Deliberately NOT returned:
//   - customer email, phone, notes (customer already knows these).
//   - internal ids (customer_id, email_send_id, src_tag).

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const id = (req.query && req.query.o) ? String(req.query.o).trim() : '';
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'order id required' });
  }

  const { data, error } = await sb
    .from('wholesale_orders')
    .select('status, items, subtotal_cents, discount_cents, total_cents, pickup_location, pickup_address, pickup_date, pickup_time, promo_code, created_at, paid_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'lookup failed' });
  if (!data)  return res.status(404).json({ error: 'order not found' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ order: data });
};
