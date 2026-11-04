// GET /api/wholesale/customer[?id=<uuid>]
//
// Public endpoint used by /wholesale to bootstrap the order form.
// Returns the active product list plus, if ?id= is supplied and
// resolves to a known customer, PUBLIC-SAFE pre-fill fields only.
//
// Public-safe = fields a customer whose email is already on file
// would be willing to see pre-filled when they click a tracked link
// from a nurture email. Specifically:
//   - first_name, organization, pickup_location, pickup_address
//
// Deliberately NOT returned, even for a matching id:
//   - email, phone, notes, tax_exempt, contact_name, created_at
//
// The id is treated as unguessable (uuid), so an attacker would need
// to enumerate uuids to grab these fields. Even so, the fields that
// come back are safe to show to the holder of a tracked link.

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

  const id = (req.query && req.query.id) ? String(req.query.id).trim() : '';

  // Products (always).
  const { data: products, error: pErr } = await sb
    .from('wholesale_products')
    .select('sku, name, unit_price_cents')
    .eq('active', true)
    .order('unit_price_cents', { ascending: true });
  if (pErr) {
    return res.status(500).json({ error: 'products lookup failed' });
  }

  let customer = null;
  if (id && UUID_RE.test(id)) {
    const { data } = await sb
      .from('wholesale_customers')
      .select('first_name, organization, pickup_location, pickup_address')
      .eq('id', id)
      .maybeSingle();
    if (data) customer = data;
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ customer, products: products || [] });
};
