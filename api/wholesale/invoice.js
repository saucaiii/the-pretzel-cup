// POST /api/wholesale/invoice?o=<order_id>
//
// Operator-gated. Builds an invoice email for a wholesale order and
// either dry-runs it (returns the rendered HTML; nothing sent) or
// live-sends it via Gmail (same sendEmail helper the campaign nurture
// uses) and advances the order's status to 'invoiced'.
//
// Body: { dry_run: true | false }
//
// Mode resolution follows the campaign-sender pattern so operators
// learn one rule:
//   - dry_run !== false     → mode = 'dry_run'
//   - EMAIL_SEND_LIVE_ENABLED !== 'true' → mode = 'dry_run'
//     (response carries `live_disabled_reason` for the UI)
//   - otherwise              → mode = 'live'
//
// On a successful live send, the order's status moves to 'invoiced'
// IF and only if it is currently 'awaiting_payment' — if the operator
// has already advanced it (e.g. clicked "Just mark invoiced" earlier
// or marked paid), the send still counts but the status is left alone
// and the response reports `status_updated: false`.
//
// Response shape:
//   {
//     mode:            'dry_run' | 'live',
//     sent:            boolean,
//     subject:         string,
//     to:              string,         // destination email
//     status_updated:  boolean,        // true only when we flipped it
//     rendered_html?:  string,         // dry_run only
//     live_disabled_reason?: string,   // dry_run only, when flag missing
//     error?:          string,         // live path, when send failed
//   }

const { createClient } = require('@supabase/supabase-js');
const { readSession } = require('../_lib/auth');
const { renderInvoice } = require('../_lib/invoice-template');
const { sendEmail } = require('../_lib/gmail');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ─── Auth ───────────────────────────────────────────────────────
  const sess = await readSession(req);
  if (!sess)                    return res.status(401).json({ error: 'not signed in' });
  if (sess.role !== 'operator') return res.status(403).json({ error: 'wrong role' });

  // ─── Order id ──────────────────────────────────────────────────
  const id = (req.query && req.query.o) ? String(req.query.o).trim() : '';
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'order id required' });
  }

  // ─── Load order + customer ─────────────────────────────────────
  const { data: order, error: orderErr } = await sb
    .from('wholesale_orders')
    .select('id, customer_id, status, items, subtotal_cents, discount_cents, total_cents, pickup_location, pickup_date, pickup_time, promo_code')
    .eq('id', id)
    .maybeSingle();
  if (orderErr) return res.status(500).json({ error: 'order lookup failed' });
  if (!order)   return res.status(404).json({ error: 'order not found' });

  const { data: customer, error: custErr } = await sb
    .from('wholesale_customers')
    .select('id, email, first_name, organization')
    .eq('id', order.customer_id)
    .maybeSingle();
  if (custErr)   return res.status(500).json({ error: 'customer lookup failed' });
  if (!customer) return res.status(404).json({ error: 'customer not found' });
  if (!customer.email) return res.status(400).json({ error: 'customer has no email' });

  // ─── Render ────────────────────────────────────────────────────
  const { subject, html, text } = renderInvoice({ order, customer });

  // ─── Mode ──────────────────────────────────────────────────────
  const body = await readJsonBody(req);
  const dryRun = body.dry_run !== false;
  const liveEnabled = process.env.EMAIL_SEND_LIVE_ENABLED === 'true';
  const mode = (!dryRun && liveEnabled) ? 'live' : 'dry_run';

  const payload = {
    mode,
    sent: false,
    subject,
    to: customer.email,
    status_updated: false,
  };

  // ─── Dry-run → return rendered HTML, do nothing else ────────────
  if (mode === 'dry_run') {
    payload.rendered_html = html;
    if (!liveEnabled && !dryRun) {
      payload.live_disabled_reason = 'EMAIL_SEND_LIVE_ENABLED not set to "true"';
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  }

  // ─── Live send ─────────────────────────────────────────────────
  try {
    await sendEmail({
      to:      customer.email,
      subject,
      html,
      text,
    });
    payload.sent = true;
  } catch (sendErr) {
    const reason = String(sendErr && (sendErr.message || sendErr)).slice(0, 300);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ ...payload, error: reason });
  }

  // Only flip the status when the order is still awaiting payment.
  // Any other current status is left alone (the send still counted).
  if (order.status === 'awaiting_payment') {
    const { error: upErr } = await sb
      .from('wholesale_orders')
      .update({
        status:       'invoiced',
        invoiced_at:  new Date().toISOString(),
        invoiced_by:  sess.sub,
      })
      .eq('id', id)
      .eq('status', 'awaiting_payment');  // defend against a race
    if (!upErr) payload.status_updated = true;
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(payload);
};
