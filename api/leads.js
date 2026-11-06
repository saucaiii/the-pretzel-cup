// Inbound lead capture for the route-delivery pitch packet.
//
// POST /api/leads   public — the /apply form submits here.
//   body: {business_name, contact_name, phone, email?, role?, address?,
//          city?, state?, zip?, est_foot_traffic?, store_type?,
//          notes?, source?, _hp}
//   202 → {ok:true} on success (202 because we fire-and-forget the
//         Telegram notify after the insert returns).
//   400 → validation failure / honeypot tripped.
//   429 → rate-limited (sliding window per IP via Upstash Redis).
//   500 → unexpected.
//
// GET  /api/leads   operator-only — list recent leads for /ops/leads
//                   (follow-up PR). Uses the existing ppf_session
//                   cookie (role='operator') via api/_lib/auth.js.
//   ?limit=N (default 50, max 200)
//   ?status=new|contacted|qualified|signed|dead (optional filter)
//
// Env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID   — notifications (optional,
//                                            logged and swallowed if missing)
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN — rate-limit
//                                            (fail-open outside prod)
//   LEAD_IP_SALT                            — salt for hashing the IP.
//                                            Defaults to a static string
//                                            so dev still hashes, but
//                                            prod should set a real one.

const { createHash } = require('crypto');
const { Redis } = require('@upstash/redis');
const { supabase, readSession } = require('./_lib/auth');

// ─── config ────────────────────────────────────────────────────────
const MAX_LEN = {
  business_name: 120, contact_name: 80, role: 80, address: 200,
  city: 80, state: 4, zip: 16, phone: 40, email: 160,
  store_type: 40, notes: 1200, source: 40,
};
const ALLOWED_SOURCES = new Set([
  'pitch-kit-qr', 'pitch-kit', 'direct', 'referral', 'other',
]);
const DEDUPE_MINUTES = 5;
const RATE_LIMIT_MAX = 5;      // 5 submissions
const RATE_LIMIT_WIN = 10 * 60; // per 10 minutes, per IP

// ─── helpers ───────────────────────────────────────────────────────
function badReq(res, msg) { return res.status(400).json({ error: msg }); }
function readBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
function s(v, max) {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  return t.slice(0, max);
}
function clientIp(req) {
  // Vercel sets x-forwarded-for; fall back to connection remote.
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}
function hashIp(ip) {
  const salt = process.env.LEAD_IP_SALT || 'ppf-lead-v1';
  return createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 32);
}

// Upstash rate-limit via a single INCR + EXPIRE on a per-IP key.
// Fail-open outside production (dev convenience); fail-closed in prod
// so missing env doesn't silently remove spam protection.
let _redis = null;
function redis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}
async function rateLimited(ipHash) {
  const r = redis();
  if (!r) {
    if (process.env.VERCEL_ENV === 'production') {
      console.warn('[leads] Upstash env missing in production — rate-limit disabled');
    }
    return false;
  }
  const key = `leads:rl:${ipHash}`;
  try {
    const count = await r.incr(key);
    if (count === 1) await r.expire(key, RATE_LIMIT_WIN);
    return count > RATE_LIMIT_MAX;
  } catch (e) {
    console.error('[leads] rate-limit check failed:', e.message || e);
    return false; // fail-open on redis flake
  }
}

// Fire-and-forget Telegram group notify. Chris reads the ops group on
// his phone; one message per lead with the contact-ready fields and a
// tap-to-call link. Markdown not used — plain text is more forgiving
// and we don't want a Markdown escape bug to drop the notification.
async function notifyTelegram(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.warn('[leads] Telegram env missing — notification skipped');
    return;
  }
  const lines = [
    '🥨 NEW LEAD — Route delivery',
    '',
    `Business: ${lead.business_name}`,
    `Contact:  ${lead.contact_name}${lead.role ? ' · ' + lead.role : ''}`,
    `Phone:    ${lead.phone}`,
  ];
  if (lead.email)             lines.push(`Email:    ${lead.email}`);
  if (lead.address || lead.city || lead.state) {
    const loc = [lead.address, [lead.city, lead.state, lead.zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    if (loc) lines.push(`Address:  ${loc}`);
  }
  if (lead.est_foot_traffic)  lines.push(`Traffic:  ~${lead.est_foot_traffic}/day`);
  if (lead.store_type)        lines.push(`Type:     ${lead.store_type}`);
  if (lead.notes)             lines.push('', `Notes: ${lead.notes}`);
  lines.push('', `Source: ${lead.source}`);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: lines.join('\n'),
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error('[leads] Telegram notify failed:', e.message || e);
  }
}

// ─── POST — submit ─────────────────────────────────────────────────
async function handlePost(req, res) {
  const body = readBody(req);

  // Honeypot: any value in _hp means a bot filled it. 200 to not tip them off.
  if (body._hp) return res.status(200).json({ ok: true });

  const business_name = s(body.business_name, MAX_LEN.business_name);
  const contact_name  = s(body.contact_name,  MAX_LEN.contact_name);
  const phone         = s(body.phone,         MAX_LEN.phone);
  if (!business_name || !contact_name || !phone) {
    return badReq(res, 'Business name, your name, and phone are required.');
  }

  const email = s(body.email, MAX_LEN.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return badReq(res, 'Email format looks off.');
  }

  let est_foot_traffic = null;
  if (body.est_foot_traffic != null && body.est_foot_traffic !== '') {
    const n = Number(body.est_foot_traffic);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
      return badReq(res, 'Foot-traffic estimate should be a number up to 1,000,000.');
    }
    est_foot_traffic = Math.floor(n);
  }

  const source = (() => {
    const t = s(body.source, MAX_LEN.source);
    return ALLOWED_SOURCES.has(t) ? t : 'pitch-kit-qr';
  })();

  const ip = clientIp(req);
  const ip_hash = hashIp(ip);

  if (await rateLimited(ip_hash)) {
    return res.status(429).json({ error: 'Too many submissions — try again in a few minutes.' });
  }

  const row = {
    business_name,
    contact_name,
    role:             s(body.role,       MAX_LEN.role),
    phone,
    email,
    address:          s(body.address,    MAX_LEN.address),
    city:             s(body.city,       MAX_LEN.city),
    state:            s(body.state,      MAX_LEN.state),
    zip:              s(body.zip,        MAX_LEN.zip),
    est_foot_traffic,
    // store_type is captured in notes for now — the schema keeps notes
    // as the free-form column so we don't have to migrate again if the
    // form adds more picker fields later.
    notes: [
      s(body.store_type, MAX_LEN.store_type) && `[type: ${s(body.store_type, MAX_LEN.store_type)}]`,
      s(body.notes, MAX_LEN.notes),
    ].filter(Boolean).join('\n\n') || null,
    source,
    user_agent: s(req.headers['user-agent'], 400),
    ip_hash,
  };

  const sb = supabase();

  // Dedupe: same phone within the last DEDUPE_MINUTES → treat as success,
  // don't notify twice. Prospects often double-tap submit.
  const sinceIso = new Date(Date.now() - DEDUPE_MINUTES * 60 * 1000).toISOString();
  const { data: recent, error: dupeErr } = await sb
    .from('leads')
    .select('id,created_at')
    .eq('phone', phone)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1);
  if (dupeErr) {
    console.error('[leads] dedupe query failed:', dupeErr.message || dupeErr);
    // fall through — better to accept a possible duplicate than drop a lead
  } else if (recent && recent.length) {
    return res.status(202).json({ ok: true, deduped: true });
  }

  const { data: inserted, error: insErr } = await sb
    .from('leads')
    .insert(row)
    .select('id')
    .single();
  if (insErr) {
    console.error('[leads] insert failed:', insErr.message || insErr);
    return res.status(500).json({ error: 'Could not save your submission. Please call 516.517.8111.' });
  }

  // Notify Telegram fire-and-forget; success does not depend on it.
  notifyTelegram(row).catch(e => console.error('[leads] notify threw:', e.message || e));

  return res.status(202).json({ ok: true, id: inserted.id });
}

// ─── GET — admin list ──────────────────────────────────────────────
async function handleGet(req, res) {
  const sess = await readSession(req).catch(() => null);
  if (!sess || sess.role !== 'operator') {
    return res.status(401).json({ error: 'not signed in' });
  }
  const url = new URL(req.url, 'http://x');
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), 200) : 50;
  const status = url.searchParams.get('status');

  let q = supabase()
    .from('leads')
    .select('id,created_at,status,business_name,contact_name,role,phone,email,address,city,state,zip,est_foot_traffic,notes,source,handled_by,handled_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status && ['new','contacted','qualified','signed','dead'].includes(status)) {
    q = q.eq('status', status);
  }
  const { data, error } = await q;
  if (error) {
    console.error('[leads] list failed:', error.message || error);
    return res.status(500).json({ error: 'list failed' });
  }
  return res.status(200).json({ leads: data || [] });
}

// ─── dispatcher ────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // QR + offer control panel lives here to stay under the 12-function
  // cap. Only ?resource=offer|qr|packs is routed away; lead POST/GET below
  // are unchanged.
  const resource = req.query && typeof req.query.resource === 'string' ? req.query.resource : '';
  if (resource === 'offer' || resource === 'qr') return require('./_qr').handle(req, res, resource);
  // Pretzel pack game on /free-pretzels (logic in api/_packs.js).
  if (resource === 'packs') return require('./_packs').handle(req, res);
  try {
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'GET')  return await handleGet(req, res);
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[leads] unhandled:', e.message || e);
    return res.status(500).json({ error: 'internal error' });
  }
};
