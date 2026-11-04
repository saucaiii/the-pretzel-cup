// GET /api/wholesale/list?status=&promo=&from=&to=&limit=
//
// Operator-gated. Returns recent wholesale orders joined with
// customer org + first name. Default limit 100, cap 500. All filters
// optional; combined with AND.

const { createClient } = require('@supabase/supabase-js');
const { requireRole } = require('../_lib/auth');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const STATUS = new Set(['draft', 'awaiting_payment', 'invoiced', 'paid', 'cancelled', 'refunded']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!(await requireRole(req, res, ['operator']))) return;

  const q = req.query || {};
  let limit = Number.parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;

  // `pickup_address` lives on wholesale_customers, not wholesale_orders —
  // selecting it here as a top-level column 500'd PostgREST and left the
  // Orders table blank. P15 also added invoiced_* / cancelled_* / paid_by;
  // include them so the drawer can show "Invoiced by …" without a second
  // query.
  let query = sb.from('wholesale_orders').select(`
    id, created_at, paid_at, status, promo_code, src_tag,
    pickup_location, pickup_date, pickup_time,
    items, subtotal_cents, discount_cents, total_cents,
    stripe_session_id,
    invoiced_at, invoiced_by, cancelled_at, cancelled_by, paid_by,
    customer:wholesale_customers ( id, first_name, organization, email, pickup_address )
  `).order('created_at', { ascending: false }).limit(limit);

  if (q.status && STATUS.has(q.status))  query = query.eq('status', q.status);
  if (q.promo)                            query = query.eq('promo_code', String(q.promo).toUpperCase());
  if (q.from && ISO_DATE.test(q.from))    query = query.gte('created_at', `${q.from}T00:00:00Z`);
  if (q.to   && ISO_DATE.test(q.to))      query = query.lte('created_at', `${q.to}T23:59:59Z`);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'lookup failed' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ orders: data || [] });
};
