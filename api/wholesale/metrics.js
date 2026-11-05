// GET /api/wholesale/metrics?campaign=<slug>
//
// Operator-gated. Three sections:
//   1. revenue  — this_week / this_month / campaign_to_date totals,
//                 breakdown by promo code and by product sku.
//   2. funnel   — per campaign email: counts of sent / opened /
//                 clicked / ordered + revenue tied back via
//                 email_send_id on paid orders.
//   3. meta     — number of eligible customers, campaign slug/name.
//
// If ?campaign= is omitted, defaults to the only campaign slug we
// have today ('winter-2026-27'). Future campaigns can be queried by
// slug.

const { createClient } = require('@supabase/supabase-js');
const { requireRole } = require('../_lib/auth');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const DEFAULT_SLUG = 'winter-2026-27';

function startOfWeekUtc(d) {
  const x = new Date(d.getTime());
  x.setUTCHours(0, 0, 0, 0);
  // Monday start (ISO).
  const day = x.getUTCDay();          // 0=Sun … 6=Sat
  const diff = (day + 6) % 7;         // days since Monday
  x.setUTCDate(x.getUTCDate() - diff);
  return x;
}
function startOfMonthUtc(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!(await requireRole(req, res, ['operator']))) return;

  const slug = String((req.query && req.query.campaign) || DEFAULT_SLUG).trim();

  // ── 1. Resolve campaign + emails ────────────────────────────────
  const { data: camp } = await sb
    .from('wholesale_campaigns')
    .select('id, slug, name, starts_on, ends_on')
    .eq('slug', slug)
    .maybeSingle();
  if (!camp) return res.status(404).json({ error: 'campaign not found' });

  const { data: emails } = await sb
    .from('wholesale_campaign_emails')
    .select('id, position, send_date, promo_code, subject, cta_src')
    .eq('campaign_id', camp.id)
    .order('position');

  const emailIds = (emails || []).map(e => e.id);

  // ── 2. Email send stats per campaign email ──────────────────────
  const { data: sends } = emailIds.length
    ? await sb
        .from('wholesale_email_sends')
        .select('campaign_email_id, sent_at, opened_at, first_clicked_at, click_count')
        .in('campaign_email_id', emailIds)
    : { data: [] };

  const sendsByEmail = new Map();
  for (const row of sends || []) {
    let b = sendsByEmail.get(row.campaign_email_id);
    if (!b) {
      b = { total: 0, sent: 0, opened: 0, clicked: 0 };
      sendsByEmail.set(row.campaign_email_id, b);
    }
    b.total++;
    if (row.sent_at)         b.sent++;
    if (row.opened_at)       b.opened++;
    if (row.first_clicked_at) b.clicked++;
  }

  // ── 3. Paid orders (for revenue + funnel attribution) ───────────
  const { data: paidOrders } = await sb
    .from('wholesale_orders')
    .select('created_at, paid_at, promo_code, items, total_cents, email_send_id')
    .eq('status', 'paid');

  // Attribution: paid orders joined to send rows (we fetched sends
  // above). Build send_id → campaign_email_id lookup from the sends
  // we already have.
  const { data: sendsIdOnly } = emailIds.length
    ? await sb
        .from('wholesale_email_sends')
        .select('id, campaign_email_id')
        .in('campaign_email_id', emailIds)
    : { data: [] };
  const sendToEmail = new Map();
  for (const row of sendsIdOnly || []) sendToEmail.set(row.id, row.campaign_email_id);

  const orderedByEmail = new Map();   // email_id → { orders, revenue_cents }
  const now = new Date();
  const wk  = startOfWeekUtc(now).toISOString();
  const mo  = startOfMonthUtc(now).toISOString();
  const campStart = camp.starts_on ? `${camp.starts_on}T00:00:00Z` : null;

  const revenue = {
    this_week_cents: 0,
    this_month_cents: 0,
    campaign_to_date_cents: 0,
    by_promo: {},     // code → { orders, revenue_cents }
    by_product: {},   // sku → { qty, revenue_cents }
  };

  for (const o of paidOrders || []) {
    const paid = o.paid_at || o.created_at;
    if (paid >= wk)                  revenue.this_week_cents  += o.total_cents;
    if (paid >= mo)                  revenue.this_month_cents += o.total_cents;
    if (campStart && paid >= campStart) revenue.campaign_to_date_cents += o.total_cents;

    const promo = o.promo_code || '(none)';
    if (!revenue.by_promo[promo]) revenue.by_promo[promo] = { orders: 0, revenue_cents: 0 };
    revenue.by_promo[promo].orders++;
    revenue.by_promo[promo].revenue_cents += o.total_cents;

    for (const it of (o.items || [])) {
      if (!it || !it.sku) continue;
      if (!revenue.by_product[it.sku]) revenue.by_product[it.sku] = { qty: 0, revenue_cents: 0 };
      revenue.by_product[it.sku].qty += (it.qty || 0);
      revenue.by_product[it.sku].revenue_cents += (it.line_total_cents || 0);
    }

    if (o.email_send_id && sendToEmail.has(o.email_send_id)) {
      const eid = sendToEmail.get(o.email_send_id);
      let b = orderedByEmail.get(eid);
      if (!b) { b = { orders: 0, revenue_cents: 0 }; orderedByEmail.set(eid, b); }
      b.orders++;
      b.revenue_cents += o.total_cents;
    }
  }

  // ── 4. Build funnel per email ───────────────────────────────────
  const funnel = (emails || []).map(e => {
    const s = sendsByEmail.get(e.id) || { total: 0, sent: 0, opened: 0, clicked: 0 };
    const o = orderedByEmail.get(e.id) || { orders: 0, revenue_cents: 0 };
    const pct = (num, den) => den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
    return {
      campaign_email_id: e.id,
      position: e.position,
      subject: e.subject,
      send_date: e.send_date,
      promo_code: e.promo_code,
      cta_src: e.cta_src,
      total: s.total,          // includes dry_run rows (sent_at=null)
      sent: s.sent,
      opened: s.opened,
      clicked: s.clicked,
      ordered: o.orders,
      revenue_cents: o.revenue_cents,
      open_rate_pct:  pct(s.opened, s.sent),
      click_rate_pct: pct(s.clicked, s.sent),
      order_rate_pct: pct(o.orders, s.sent),
    };
  });

  // Eligible customer count (how many customers exist for broadcasts).
  const { count: customerCount } = await sb
    .from('wholesale_customers')
    .select('*', { count: 'exact', head: true });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    meta: {
      campaign: { slug: camp.slug, name: camp.name, starts_on: camp.starts_on, ends_on: camp.ends_on },
      customer_count: customerCount || 0,
      generated_at: new Date().toISOString(),
    },
    revenue,
    funnel,
  });
};
