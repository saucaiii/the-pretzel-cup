// POST /api/wholesale/stripe-webhook
//
// Stripe → us webhook for wholesale Checkout sessions. Verifies the
// signature on the raw body, dedupes on event.id via the existing
// stripe_events table (shared with the store-portal webhook), and
// patches wholesale_orders on checkout.session.completed and
// checkout.session.expired.
//
// We identify the target order by:
//   1. metadata.order_id (set by submit.js when it creates the session)
//   2. fallback to session.id → stripe_session_id lookup
//
// Idempotent on event.id. Returns 200 on dedupe hits so Stripe stops
// retrying.

const { createClient } = require('@supabase/supabase-js');
const { verifyStripeSignature } = require('../_lib/stripe');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function findOrder(session) {
  const orderId = session && session.metadata && session.metadata.order_id;
  if (orderId && UUID_RE.test(String(orderId))) {
    const { data } = await sb
      .from('wholesale_orders')
      .select('id, status, total_cents')
      .eq('id', orderId)
      .maybeSingle();
    if (data) return data;
  }
  // Fallback by session id (works even if metadata.order_id was dropped).
  if (session && session.id) {
    const { data } = await sb
      .from('wholesale_orders')
      .select('id, status, total_cents')
      .eq('stripe_session_id', session.id)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function handleCompleted(session) {
  const order = await findOrder(session);
  if (!order) {
    console.error('[wholesale/webhook] completed: no matching order for session', session.id);
    return;
  }
  if (order.status === 'paid') return;  // idempotent
  const piId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : (session.payment_intent && session.payment_intent.id) || null;
  const paidTotal = Number.isFinite(session.amount_total) ? session.amount_total : order.total_cents;
  const { error } = await sb
    .from('wholesale_orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: piId,
      total_cents: paidTotal,
      // Ensure the session id is the real one even if the submit.js
      // post-create patch failed.
      stripe_session_id: session.id,
    })
    .eq('id', order.id);
  if (error) throw error;
}

async function handleExpired(session) {
  const order = await findOrder(session);
  if (!order) return;
  if (order.status === 'paid' || order.status === 'cancelled') return;
  const { error } = await sb
    .from('wholesale_orders')
    .update({ status: 'cancelled' })
    .eq('id', order.id);
  if (error) throw error;
}

async function handleEvent(event) {
  const session = event.data && event.data.object;
  if (!session) return;
  if (event.type === 'checkout.session.completed') return handleCompleted(session);
  if (event.type === 'checkout.session.expired')   return handleExpired(session);
  // Other event types: ignore. We don't subscribe to them in Stripe,
  // but if the dashboard operator wires extra types here they won't
  // break the handler.
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET missing' });

  // Vercel will have given us a stream since bodyParser is disabled.
  // On local dev `req.body` may already be a Buffer; handle both.
  let rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  if (!rawBody) rawBody = await readRawBody(req);

  const sig = req.headers['stripe-signature'] || '';
  let event;
  try {
    event = verifyStripeSignature(rawBody, sig, secret);
  } catch (e) {
    console.error('[wholesale/webhook] signature:', e.message || e);
    return res.status(400).json({ error: 'bad signature' });
  }

  try {
    // Dedupe via the shared stripe_events table. INSERT, swallow 23505
    // (unique violation) which means we've already processed this event.
    const { error: ie } = await sb.from('stripe_events').insert({ id: event.id, type: event.type });
    if (ie && ie.code === '23505') {
      return res.status(200).json({ received: true, duplicate: true });
    }
    if (ie) throw ie;

    await handleEvent(event);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[wholesale/webhook]', err && (err.stack || err.message || err));
    // Match the store-webhook convention: 200 for app-logic errors
    // (we've logged them, Stripe shouldn't retry forever), 500 for
    // likely-transient DB/network errors so Stripe retries.
    const transient = err.code === 'PGRST000' || /timeout|ETIMEDOUT|ECONN/i.test(err.message || '');
    return res.status(transient ? 500 : 200).json({ received: true, error: err.message || String(err) });
  }
};

// Vercel: disable the automatic JSON body parser so we can verify
// Stripe's signature on the exact bytes it sent.
module.exports.config = { api: { bodyParser: false } };
