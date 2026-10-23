// Shared Stripe helper for /api/store.js and /api/schedule.js.
//
// We don't take a dependency on the `stripe` npm package. Node has fetch,
// and Stripe's REST API is small enough that keeping it inline avoids a
// cold-start hit and keeps the serverless bundle slim.
//
// Env vars:
//   STRIPE_SECRET_KEY       — sk_live_… or sk_test_… (restricted recommended)
//   STRIPE_WEBHOOK_SECRET   — whsec_… for signature verification
//   STRIPE_SINGLE_PRICE_CENTS / STRIPE_DOUBLE_PRICE_CENTS — line-item unit prices
//
// Exports:
//   stripeApi(method, path, {body, idempotencyKey, query, apiVersion})
//   verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds)
//   singlePriceCents() / doublePriceCents()

const crypto = require('crypto');

const DEFAULT_API_VERSION = '2024-06-20';
const BASE = 'https://api.stripe.com/v1';

// Build x-www-form-urlencoded body the way Stripe's SDK does for nested
// objects — `metadata[foo]=bar`, `payment_method_options[us_bank_account][verification_method]=instant`.
function encodeForm(obj, prefix = '') {
  const parts = [];
  if (obj == null) return '';
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      parts.push(encodeForm(v, `${prefix}[${i}]`));
    });
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object') parts.push(encodeForm(v, key));
      else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  } else {
    parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`);
  }
  return parts.filter(Boolean).join('&');
}

async function stripeApi(method, path, opts = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  const headers = {
    Authorization: `Bearer ${key}`,
    'Stripe-Version': opts.apiVersion || DEFAULT_API_VERSION,
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let url = `${BASE}${path}`;
  let body;
  if (method === 'GET' || method === 'DELETE') {
    if (opts.query) {
      const q = encodeForm(opts.query);
      if (q) url += (url.includes('?') ? '&' : '?') + q;
    }
  } else {
    body = encodeForm(opts.body || {});
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const r = await fetch(url, { method, headers, body });
  const text = await r.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error.code)) || `stripe ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.stripe = j.error || j;
    throw err;
  }
  return j;
}

// Verify a Stripe-Signature header against the raw request body.
// Returns the parsed event JSON on success, throws on failure.
function verifyStripeSignature(rawBody, header, secret, toleranceSeconds = 300) {
  if (!header || !secret) throw new Error('missing signature or secret');
  const items = Object.fromEntries(
    header.split(',').map(p => p.trim().split('=')).map(([k, v]) => [k, v]),
  );
  const timestamp = parseInt(items.t, 10);
  const sig = items.v1;
  if (!timestamp || !sig) throw new Error('malformed Stripe-Signature header');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new Error(`stripe signature timestamp outside tolerance (${now - timestamp}s)`);
  }
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const payload = `${timestamp}.${bodyStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  // Length-safe compare.
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('stripe signature mismatch');
  }
  try { return JSON.parse(bodyStr); } catch { throw new Error('body is not valid JSON'); }
}

function singlePriceCents() {
  const n = parseInt(process.env.STRIPE_SINGLE_PRICE_CENTS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 215;
}
function doublePriceCents() {
  const n = parseInt(process.env.STRIPE_DOUBLE_PRICE_CENTS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 385;
}

module.exports = {
  stripeApi,
  verifyStripeSignature,
  singlePriceCents,
  doublePriceCents,
  encodeForm,
};
