// POST /api/wholesale/submit
//
// Public endpoint: receives a wholesale order from /wholesale and
// returns a Stripe Checkout URL. Flow:
//
//   1. Validate body (email, first_name, organization, pickup_location,
//      items[]).
//   2. Lookup-or-create wholesale_customers by email (citext → case-
//      insensitive). Update stale pre-fill fields in place.
//   3. Pull active products from DB. Compute authoritative line items
//      (including bonus lines) via _lib/promo.applyBonus.
//   4. Resolve email_send_id from src_tag → campaign_email.cta_src →
//      wholesale_email_sends row for this customer. Null if none.
//   5. Insert wholesale_orders row with status='awaiting_payment' and
//      a placeholder stripe_session_id (we overwrite in step 6; the
//      column has UNIQUE so we pick a random cs_wip_<uuid> here).
//   6. Create Stripe Checkout session (one line item per non-zero line
//      + one $0 line item per bonus line). metadata.order_id = our
//      order id so the webhook can resolve back.
//   7. Patch the order row with the real stripe_session_id and return
//      { checkout_url } to the client.
//
// Status transitions after this: 'awaiting_payment' → 'paid' (by
// stripe-webhook) or → 'cancelled' (by webhook on session.expired).

const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
const { stripeApi } = require('../_lib/stripe');
const { applyBonus } = require('../_lib/promo');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const email         = pickString(body.email, 320);
  const first_name    = pickString(body.first_name, 80);
  const organization  = pickString(body.organization, 200);
  const pickup_location = pickString(body.pickup_location, 80);
  const phone         = pickString(body.phone, 40);
  const pickup_address = pickString(body.pickup_address, 200);
  const pickup_date   = pickString(body.pickup_date, 20);
  const pickup_time   = pickString(body.pickup_time, 40);
  const promo_code    = pickString(body.promo_code, 40);
  const notes         = pickString(body.notes, 500);
  const src_tag       = pickString(body.src_tag, 80);

  if (!email || !EMAIL_RE.test(email))           return res.status(400).json({ error: 'valid email required' });
  if (!first_name)                                return res.status(400).json({ error: 'first name required' });
  if (!organization)                              return res.status(400).json({ error: 'organization required' });
  if (!pickup_location)                           return res.status(400).json({ error: 'pickup location required' });
  if (!Array.isArray(body.items) || !body.items.length) {
    return res.status(400).json({ error: 'at least one item required' });
  }

  // ─── 2. Customer upsert ─────────────────────────────────────────
  const custPatch = { email, first_name, organization };
  if (phone)           custPatch.phone = phone;
  if (pickup_location) custPatch.pickup_location = pickup_location;
  if (pickup_address)  custPatch.pickup_address = pickup_address;

  const { data: cust, error: custErr } = await sb
    .from('wholesale_customers')
    .upsert([custPatch], { onConflict: 'email', ignoreDuplicates: false })
    .select('id')
    .single();
  if (custErr) {
    return res.status(500).json({ error: 'customer lookup failed' });
  }
  const customer_id = cust.id;

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
  if (total_cents < 50)   return res.status(400).json({ error: 'order total must be at least $0.50 (Stripe minimum)' });

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

  // ─── 5. Insert draft order with placeholder session id ──────────
  const placeholderSession = `cs_wip_${randomUUID()}`;
  const { data: order, error: ordErr } = await sb
    .from('wholesale_orders')
    .insert([{
      customer_id,
      email_send_id,
      src_tag,
      promo_code,
      pickup_location,
      pickup_date,
      pickup_time,
      items,
      subtotal_cents,
      discount_cents,
      total_cents,
      stripe_session_id: placeholderSession,
      status: 'awaiting_payment',
      notes,
    }])
    .select('id')
    .single();
  if (ordErr) {
    return res.status(500).json({ error: 'order insert failed' });
  }
  const order_id = order.id;

  // ─── 6. Create Stripe Checkout session ──────────────────────────
  const base = baseUrl();
  const lineItems = {};
  items.forEach((it, i) => {
    lineItems[`${i}`] = {
      quantity: it.qty,
      price_data: {
        currency: 'usd',
        unit_amount: it.unit_price_cents,
        product_data: {
          name: it.is_bonus ? `${it.name} — bonus (free)` : it.name,
        },
      },
    };
  });

  let session;
  try {
    session = await stripeApi('POST', '/checkout/sessions', {
      body: {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: lineItems,
        customer_email: email,
        metadata: {
          order_id,
          customer_id,
          promo_code: promo_code || '',
          src_tag:    src_tag    || '',
        },
        success_url: `${base}/wholesale/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${base}/wholesale/`,
      },
      idempotencyKey: `wholesale-${order_id}`,
    });
  } catch (ex) {
    // Roll the order back to cancelled so stale draft rows don't linger.
    await sb.from('wholesale_orders')
      .update({ status: 'cancelled', notes: `stripe create failed: ${ex.message || ex}` })
      .eq('id', order_id);
    return res.status(502).json({ error: 'payment setup failed' });
  }

  // ─── 7. Patch order with real session id ────────────────────────
  const { error: updErr } = await sb
    .from('wholesale_orders')
    .update({ stripe_session_id: session.id })
    .eq('id', order_id);
  if (updErr) {
    // Non-fatal — the order still exists under the placeholder, the
    // webhook finds it by metadata.order_id. Log server-side.
    console.error('[wholesale/submit] session id patch failed', updErr.message);
  }

  return res.status(200).json({ checkout_url: session.url });
};
