// POST /api/wholesale/submit
//
// Public endpoint: receives a wholesale order from /wholesale and
// saves it for an operator to invoice manually. Payment collection is
// out of scope for this PR — the form is a capture + confirm flow;
// an operator reviews orders in /ops/wholesale/ and sends an invoice
// via whatever channel they currently use (email, mail, etc.).
//
// Flow:
//   1. Validate body (email, first_name, organization, pickup_location,
//      items[]).
//   2. Lookup-or-create wholesale_customers by email.
//   3. Pull active products from DB. Compute authoritative line items
//      (including bonus lines) via _lib/promo.applyBonus — the bonus
//      shows on the confirmation so customers know what to expect on
//      the invoice; the operator honours the same math.
//   4. Resolve email_send_id from src_tag → campaign_email.cta_src →
//      wholesale_email_sends row for this customer. Null if none.
//   5. Insert wholesale_orders row with status='awaiting_payment'.
//      stripe_session_id / stripe_payment_intent_id stay null — the
//      columns are retained for a potential future payment integration
//      but are not populated here.
//   6. Return { ok: true, order_id, success_url } so the client can
//      redirect to /wholesale/success?o=<order_id>.

const { createClient } = require('@supabase/supabase-js');
const { applyBonus } = require('../_lib/promo');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PICKUP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pickString(v, max = 500) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

function baseUrl() {
  if (process.env.WHOLESALE_BASE_URL) return process.env.WHOLESALE_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_URL)         return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const body = (typeof req.body === 'object' && req.body !== null)
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  // ─── 1. Validate ────────────────────────────────────────────────
  const email           = pickString(body.email, 320);
  const first_name      = pickString(body.first_name, 80);
  const organization    = pickString(body.organization, 200);
  const pickup_location = pickString(body.pickup_location, 80);
  const phone           = pickString(body.phone, 40);
  const pickup_address  = pickString(body.pickup_address, 200);
  const pickup_date     = pickString(body.pickup_date, 20);
  const pickup_time     = pickString(body.pickup_time, 40);
  const promo_code      = pickString(body.promo_code, 40);
  const notes           = pickString(body.notes, 500);
  const src_tag         = pickString(body.src_tag, 80);

  if (!email || !EMAIL_RE.test(email))           return res.status(400).json({ error: 'valid email required' });
  if (!first_name)                                return res.status(400).json({ error: 'first name required' });
  if (!organization)                              return res.status(400).json({ error: 'organization required' });
  if (!pickup_location)                           return res.status(400).json({ error: 'pickup location required' });
  // Pickup date is required on the client (<input type="date" required>)
  // but the HTML gate doesn't bind direct API callers; enforce it here.
  if (!pickup_date || !PICKUP_DATE_RE.test(pickup_date)) {
    return res.status(400).json({ error: 'valid pickup date required (YYYY-MM-DD)' });
  }
  if (!Array.isArray(body.items) || !body.items.length) {
    return res.status(400).json({ error: 'at least one item required' });
  }

  // ─── 2. Customer lookup-or-insert ───────────────────────────────
  // Insert-if-absent, never update: operator edits in /ops/wholesale/
  // (e.g. a corrected contact_name or a cleaned-up organization) must
  // survive any later resubmit by the customer. `ignoreDuplicates: true`
  // means a conflict on the unique `email` index returns zero rows
  // instead of updating. We SELECT the row in that branch, so a
  // concurrent new-email race still resolves cleanly (the loser sees
  // the winner's row).
  const custPatch = { email, first_name, organization };
  if (phone)           custPatch.phone = phone;
  if (pickup_location) custPatch.pickup_location = pickup_location;
  if (pickup_address)  custPatch.pickup_address = pickup_address;

  const { data: upserted, error: upErr } = await sb
    .from('wholesale_customers')
    .upsert([custPatch], { onConflict: 'email', ignoreDuplicates: true })
    .select('id');
  if (upErr) {
    return res.status(500).json({ error: 'customer upsert failed' });
  }

  let customer_id = upserted && upserted[0] && upserted[0].id;
  if (!customer_id) {
    // Existing customer — upsert swallowed the conflict and returned
    // nothing. Look the row up.
    const { data: existing, error: exErr } = await sb
      .from('wholesale_customers')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (exErr || !existing) {
      return res.status(500).json({ error: 'customer lookup failed' });
    }
    customer_id = existing.id;
  }

  // ─── 3. Compute authoritative items ─────────────────────────────
  const { data: products, error: pErr } = await sb
    .from('wholesale_products')
    .select('sku, name, unit_price_cents')
    .eq('active', true);
  if (pErr) return res.status(500).json({ error: 'product lookup failed' });

  const rawLines = body.items
    .map(l => ({ sku: pickString(l && l.sku, 40), qty: Number.parseInt(l && l.qty, 10) }))
    .filter(l => l.sku && Number.isFinite(l.qty) && l.qty > 0);
  if (!rawLines.length) return res.status(400).json({ error: 'items missing valid sku/qty' });

  const { items, subtotal_cents, discount_cents, total_cents } = applyBonus({ products, lines: rawLines });
  if (!items.length)      return res.status(400).json({ error: 'no valid items' });
  if (total_cents <= 0)   return res.status(400).json({ error: 'total must be positive' });

  // ─── 4. Resolve email_send_id from src_tag ──────────────────────
  let email_send_id = null;
  if (src_tag) {
    const { data: ce } = await sb
      .from('wholesale_campaign_emails')
      .select('id')
      .eq('cta_src', src_tag)
      .maybeSingle();
    if (ce && ce.id) {
      const { data: es } = await sb
        .from('wholesale_email_sends')
        .select('id')
        .eq('campaign_email_id', ce.id)
        .eq('customer_id', customer_id)
        .maybeSingle();
      if (es && es.id) email_send_id = es.id;
    }
  }

  // ─── 4b. Validate + normalize promo code ───────────────────────
  // The 100-for-25 bonus is quantity-driven (applyBonus above) — a
  // bogus code never gates the bonus. This step only decides whether
  // the code is REPORTABLE: normalize to uppercase, look it up
  // against the campaign-emails table, store the normalized value
  // when it matches, else drop it to null so the reports column
  // doesn't collect typos / stray strings.
  let normalized_promo_code = null;
  if (promo_code) {
    const candidate = promo_code.trim().toUpperCase();
    const { data: codeRow } = await sb
      .from('wholesale_campaign_emails')
      .select('id')
      .eq('promo_code', candidate)
      .maybeSingle();
    if (codeRow && codeRow.id) normalized_promo_code = candidate;
  }

  // ─── 5. Insert order awaiting invoice ───────────────────────────
  // stripe_session_id / stripe_payment_intent_id left null; the
  // columns are retained in the schema so a future payment-processor
  // integration can populate them without another migration.
  const { data: order, error: ordErr } = await sb
    .from('wholesale_orders')
    .insert([{
      customer_id,
      email_send_id,
      src_tag,
      promo_code: normalized_promo_code,
      pickup_location,
      pickup_date,
      pickup_time,
      items,
      subtotal_cents,
      discount_cents,
      total_cents,
      status: 'awaiting_payment',
      notes,
    }])
    .select('id')
    .single();
  if (ordErr) {
    return res.status(500).json({ error: 'order insert failed' });
  }

  const base = baseUrl();
  return res.status(200).json({
    ok: true,
    order_id: order.id,
    success_url: `${base}/wholesale/success?o=${order.id}`,
  });
};
