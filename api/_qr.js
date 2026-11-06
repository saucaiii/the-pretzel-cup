// QR + offer control panel backend. Mounted inside api/leads.js as
// ?resource=offer and ?resource=qr (Vercel Hobby 12-function cap: the
// leading underscore keeps this file from becoming its own function).
//
//   GET  ?resource=offer                      public, cached briefly
//   GET  ?resource=qr&view=config|history|stats   operator
//   POST ?resource=qr  {action, ...}           operator
//        actions: publish_offer, set_target, reset_target, restore
//
// Storage:
//   Edge Config  "scan_target" (string), "offer" (object). Read with
//                @vercel/edge-config (EDGE_CONFIG env). Written through
//                the Vercel REST API with EDGE_CONFIG_WRITE_TOKEN and
//                EDGE_CONFIG_ID. Missing write env -> 503, never a crash.
//   Upstash      qr:history (list, newest first, last 20 versions)
//                qr:scans:<YYYY-MM-DD> (hash placement -> count, written
//                by middleware.js, America/New_York days)
//
// Brand rules enforced here (summary of the internal brand guide):
// hero layouts are solid green, black or gold-light only; tagline is
// white or black; no em dashes or emojis in copy; one tagline only.

const FALLBACK_TARGET = '/free-pretzels';
const OWN_HOSTS = new Set(['the-pretzel-cup.vercel.app']);
const TIME_ZONE = 'America/New_York';
const HISTORY_KEY = 'qr:history';
const HISTORY_MAX = 20;
const MAX_TARGET_LEN = 2000;
const WRITE_TIMEOUT_MS = 8000;

const LAYOUTS = ['green', 'black', 'gold-light'];
const TAGLINE_COLORS = ['white', 'black'];
// Tagline colour each layout must use (white on dark, black on light).
const LAYOUT_TAGLINE = { green: 'white', black: 'white', 'gold-light': 'black' };

const LIMITS = { headline: 80, details: 600, step: 140, steps: 5, fine_print: 800, stamp: 40, accent: 24, instagram_handle: 30 };
// Instagram usernames: letters, numbers, dot, underscore, up to 30.
const IG_HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;
const HEADLINE_LINT_LEN = 48;

// ─── pure helpers (unit-tested) ─────────────────────────────────────

// Same acceptance rules as parseTarget() in middleware.js (a parity
// test keeps them in step), plus: length cap and no self-loop to /scan.
function parseTarget(raw, requestUrl) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_TARGET_LEN) return null;
  let url = null;
  try {
    if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
      url = new URL(value, requestUrl);
    } else {
      const abs = new URL(value);
      if (abs.protocol === 'https:' || abs.protocol === 'http:') url = abs;
    }
  } catch {
    return null;
  }
  if (!url) return null;
  if (isOwnSite(url, requestUrl) && /^\/scan\/?$/.test(url.pathname)) return null;
  return url;
}

function isOwnSite(url, requestUrl) {
  return url.host === new URL(requestUrl).host || OWN_HOSTS.has(url.host);
}

function sanitizePlacement(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9_-]{1,32}$/.test(v) ? v : 'other';
}

function str(v, max) {
  if (v == null) return '';
  return String(v).replace(/\r\n?/g, '\n').trim().slice(0, max + 1);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(v) {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Returns {offer} or {errors: [..]}. Unknown keys are dropped.
function validateOffer(input) {
  const errors = [];
  const o = input && typeof input === 'object' ? input : {};
  const offer = {
    headline: str(o.headline, LIMITS.headline),
    details: str(o.details, LIMITS.details),
    steps: Array.isArray(o.steps) ? o.steps.map((s) => str(s, LIMITS.step)).filter(Boolean) : [],
    fine_print: str(o.fine_print, LIMITS.fine_print),
    stamp: str(o.stamp, LIMITS.stamp),
    accent: str(o.accent, LIMITS.accent),
    layout: LAYOUTS.includes(o.layout) ? o.layout : 'green',
    starts_at: o.starts_at ? String(o.starts_at) : '',
    ends_at: o.ends_at ? String(o.ends_at) : '',
    // Pack game (api/_packs.js). Off unless explicitly true.
    game: o.game === true,
    instagram_handle: str(o.instagram_handle, LIMITS.instagram_handle + 1).replace(/^@/, ''),
  };
  if (!offer.headline) errors.push('headline is required');
  if (offer.instagram_handle && !IG_HANDLE_RE.test(offer.instagram_handle)) {
    errors.push('instagram_handle must be 1 to 30 letters, numbers, dots or underscores');
  }
  for (const k of ['headline', 'details', 'fine_print', 'stamp', 'accent']) {
    if (offer[k].length > LIMITS[k]) errors.push(`${k} is longer than ${LIMITS[k]} characters`);
  }
  if (offer.steps.length > LIMITS.steps) errors.push(`at most ${LIMITS.steps} steps`);
  offer.steps.forEach((s, i) => {
    if (s.length > LIMITS.step) errors.push(`step ${i + 1} is longer than ${LIMITS.step} characters`);
  });
  if (o.layout != null && !LAYOUTS.includes(o.layout)) errors.push('layout must be green, black or gold-light');
  if (offer.accent && /\s/.test(offer.accent)) errors.push('accent must be a single word');
  if (offer.starts_at && !validDate(offer.starts_at)) errors.push('starts_at must be YYYY-MM-DD');
  if (offer.ends_at && !validDate(offer.ends_at)) errors.push('ends_at must be YYYY-MM-DD');
  if (offer.starts_at && offer.ends_at && validDate(offer.starts_at) && validDate(offer.ends_at)
      && offer.ends_at < offer.starts_at) errors.push('ends_at is before starts_at');
  offer.tagline_color = LAYOUT_TAGLINE[offer.layout];
  return errors.length ? { errors } : { offer };
}

// Advisory brand-voice lint. Returns [{field, rule, message}].
const EMOJI_RE = /\p{Extended_Pictographic}/u;
function lintCopy(offer) {
  const out = [];
  if (!offer || typeof offer !== 'object') return out;
  const fields = {
    headline: offer.headline, details: offer.details, fine_print: offer.fine_print,
    stamp: offer.stamp, accent: offer.accent,
  };
  (Array.isArray(offer.steps) ? offer.steps : []).forEach((s, i) => { fields[`step ${i + 1}`] = s; });
  for (const [field, raw] of Object.entries(fields)) {
    const text = typeof raw === 'string' ? raw : '';
    if (!text) continue;
    if (/[\u2014\u2013]/.test(text)) out.push({ field, rule: 'dash', message: 'Em or en dash. Use a period or comma.' });
    if (EMOJI_RE.test(text)) out.push({ field, rule: 'emoji', message: 'Emoji. Brand copy uses words only.' });
    if (/[!?]{2,}/.test(text)) out.push({ field, rule: 'stacked', message: 'Stacked ! or ?. One is plenty.' });
  }
  if (typeof offer.headline === 'string' && offer.headline.length > HEADLINE_LINT_LEN) {
    out.push({ field: 'headline', rule: 'long', message: `Headline over ${HEADLINE_LINT_LEN} characters. Keep it simple.` });
  }
  // The logo lockup already carries "Made to Crave®". A headline or stamp
  // that is itself a tagline reads as a second tagline next to it.
  for (const field of ['headline', 'stamp']) {
    const t = typeof offer[field] === 'string' ? offer[field].toLowerCase() : '';
    if (/made to crave/.test(t)) out.push({ field, rule: 'tagline', message: 'Tagline appears once, under the logo only.' });
  }
  if (offer.stamp && /crave/i.test(offer.stamp)) {
    out.push({ field: 'stamp', rule: 'tagline', message: 'Stamp sits by the lockup. Keep crave lines in the body copy.' });
  }
  if (offer.layout && !LAYOUTS.includes(offer.layout)) {
    out.push({ field: 'layout', rule: 'palette', message: 'Layout must be solid green, black or gold-light.' });
  }
  return out;
}

function todayIn(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function offerStatus(offer, now = new Date()) {
  if (!offer) return 'none';
  const today = todayIn(TIME_ZONE, now);
  if (offer.starts_at && today < offer.starts_at) return 'scheduled';
  if (offer.ends_at && today > offer.ends_at) return 'ended';
  return 'live';
}

function dayKeys(days, now = new Date()) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    keys.push(todayIn(TIME_ZONE, new Date(now.getTime() - i * 86400000)));
  }
  return [...new Set(keys)];
}

// ─── IO (injectable for tests) ──────────────────────────────────────

function defaultDeps() {
  return {
    readSession: (req) => require('./_lib/auth').readSession(req),
    edgeGet: async (key) => {
      if (!process.env.EDGE_CONFIG) return undefined;
      const { get } = require('@vercel/edge-config');
      return await get(key);
    },
    redis: (() => {
      let r;
      return () => {
        if (r !== undefined) return r;
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;
        if (!url || !token) { r = null; return r; }
        const { Redis } = require('@upstash/redis');
        r = new Redis({ url, token });
        return r;
      };
    })(),
    fetch: (...a) => fetch(...a),
    env: process.env,
    now: () => new Date(),
  };
}

class NotConfigured extends Error {}

async function writeEdgeConfig(deps, items) {
  const id = deps.env.EDGE_CONFIG_ID;
  const token = deps.env.EDGE_CONFIG_WRITE_TOKEN;
  if (!id || !token) throw new NotConfigured('Edge Config writes are not configured yet (EDGE_CONFIG_ID / EDGE_CONFIG_WRITE_TOKEN).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS);
  try {
    const teamQs = deps.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(deps.env.VERCEL_TEAM_ID)}` : '';
    const r = await deps.fetch(`https://api.vercel.com/v1/edge-config/${encodeURIComponent(id)}/items${teamQs}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Edge Config write failed (${r.status}) ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function pushHistory(deps, entry) {
  const r = deps.redis();
  if (!r) return;
  try {
    await r.lpush(HISTORY_KEY, JSON.stringify(entry));
    await r.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
  } catch (e) {
    console.error('[qr] history write failed:', e.message || e);
  }
}

async function readHistory(deps) {
  const r = deps.redis();
  if (!r) return [];
  const rows = await r.lrange(HISTORY_KEY, 0, HISTORY_MAX - 1);
  return (rows || []).map((x) => {
    if (x && typeof x === 'object') return x; // upstash auto-parses JSON
    try { return JSON.parse(x); } catch { return null; }
  }).filter(Boolean);
}

async function readStats(deps) {
  const r = deps.redis();
  const now = deps.now();
  const keys = dayKeys(30, now);
  const out = { today: {}, d7: {}, d30: {}, by_day: {}, configured: !!r };
  if (!r) return out;
  const hashes = await Promise.all(keys.map((d) => r.hgetall(`qr:scans:${d}`).catch(() => null)));
  keys.forEach((day, i) => {
    const h = hashes[i] || {};
    let total = 0;
    for (const [placement, n] of Object.entries(h)) {
      const c = Number(n) || 0;
      total += c;
      if (i === 0) out.today[placement] = (out.today[placement] || 0) + c;
      if (i < 7) out.d7[placement] = (out.d7[placement] || 0) + c;
      out.d30[placement] = (out.d30[placement] || 0) + c;
    }
    out.by_day[day] = total;
  });
  return out;
}

// ─── HTTP ───────────────────────────────────────────────────────────

function readBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function requestUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'the-pretzel-cup.vercel.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}${req.url || '/'}`;
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return o.host === host;
  } catch {
    return false;
  }
}

// Validated live offer + status. Shared with api/_packs.js. Never throws.
async function readLiveOffer(deps) {
  let offer = null;
  try {
    const v = await deps.edgeGet('offer');
    if (v && typeof v === 'object') {
      const checked = validateOffer(v);
      offer = checked.offer || null;
    }
  } catch (e) {
    console.error('[qr] offer read failed:', e.message || e);
  }
  return { offer, status: offerStatus(offer, deps.now()) };
}

async function handleOffer(req, res, deps) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const { offer, status } = await readLiveOffer(deps);
  // Short cache at Vercel's CDN only. Browsers always revalidate, so a
  // newly published offer is never held stale in a visitor's browser.
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=30, stale-while-revalidate=120');
  return res.status(200).json({ offer, status });
}

async function handleQr(req, res, deps) {
  const sess = await deps.readSession(req).catch(() => null);
  if (!sess) return res.status(401).json({ error: 'not signed in' });
  if (sess.role !== 'operator') return res.status(403).json({ error: 'wrong role' });
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const view = new URL(req.url || '/', 'http://x').searchParams.get('view') || 'config';
    if (view === 'history') return res.status(200).json({ history: await readHistory(deps) });
    if (view === 'stats') return res.status(200).json(await readStats(deps));
    if (view === 'config') {
      const [target, offer] = await Promise.all([
        deps.edgeGet('scan_target').catch(() => undefined),
        deps.edgeGet('offer').catch(() => undefined),
      ]);
      return res.status(200).json({
        scan_target: typeof target === 'string' ? target : null,
        fallback: FALLBACK_TARGET,
        offer: offer && typeof offer === 'object' ? offer : null,
        offer_status: offerStatus(offer && typeof offer === 'object' ? offer : null, deps.now()),
        writable: !!(deps.env.EDGE_CONFIG_ID && deps.env.EDGE_CONFIG_WRITE_TOKEN),
        readable: !!deps.env.EDGE_CONFIG,
        layouts: LAYOUTS,
        tagline_colors: TAGLINE_COLORS,
        limits: LIMITS,
      });
    }
    return res.status(400).json({ error: 'unknown view' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  // CSRF: JSON body (forces a CORS preflight cross-site) + same-origin.
  const ctype = String(req.headers['content-type'] || '');
  if (!ctype.toLowerCase().startsWith('application/json')) return res.status(415).json({ error: 'json only' });
  if (!originOk(req)) return res.status(403).json({ error: 'bad origin' });

  const body = readBody(req);
  const base = { ts: deps.now().toISOString(), by_sub: String(sess.sub || ''), by_name: String(sess.name || '') };
  const rurl = requestUrl(req);

  try {
    if (body.action === 'set_target' || body.action === 'reset_target') {
      const value = body.action === 'reset_target' ? FALLBACK_TARGET : String(body.scan_target || '').trim();
      if (!parseTarget(value, rurl)) {
        return res.status(400).json({ error: 'Target must be a /path on this site or a full http(s) URL, and not /scan itself.' });
      }
      await writeEdgeConfig(deps, [{ operation: 'upsert', key: 'scan_target', value }]);
      await pushHistory(deps, { ...base, kind: 'scan_target', scan_target: value });
      return res.status(200).json({ ok: true, scan_target: value });
    }

    if (body.action === 'publish_offer') {
      const checked = validateOffer(body.offer);
      if (checked.errors) return res.status(400).json({ error: checked.errors.join('; '), errors: checked.errors });
      await writeEdgeConfig(deps, [{ operation: 'upsert', key: 'offer', value: checked.offer }]);
      await pushHistory(deps, { ...base, kind: 'offer', offer: checked.offer });
      return res.status(200).json({ ok: true, offer: checked.offer, lint: lintCopy(checked.offer) });
    }

    if (body.action === 'restore') {
      const history = await readHistory(deps);
      const entry = history.find((h) => h.ts === body.ts);
      if (!entry) return res.status(404).json({ error: 'version not found' });
      if (entry.kind === 'scan_target') {
        if (!parseTarget(entry.scan_target, rurl)) return res.status(400).json({ error: 'stored target is no longer valid' });
        await writeEdgeConfig(deps, [{ operation: 'upsert', key: 'scan_target', value: entry.scan_target }]);
        await pushHistory(deps, { ...base, kind: 'scan_target', scan_target: entry.scan_target, restored_from: entry.ts });
        return res.status(200).json({ ok: true, scan_target: entry.scan_target });
      }
      if (entry.kind === 'offer') {
        const checked = validateOffer(entry.offer);
        if (checked.errors) return res.status(400).json({ error: 'stored offer is no longer valid' });
        await writeEdgeConfig(deps, [{ operation: 'upsert', key: 'offer', value: checked.offer }]);
        await pushHistory(deps, { ...base, kind: 'offer', offer: checked.offer, restored_from: entry.ts });
        return res.status(200).json({ ok: true, offer: checked.offer });
      }
      return res.status(400).json({ error: 'unknown version kind' });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    if (e instanceof NotConfigured) return res.status(503).json({ error: e.message });
    console.error('[qr] write failed:', e.message || e);
    return res.status(502).json({ error: 'Could not save to Edge Config. Nothing changed. Try again.' });
  }
}

async function handle(req, res, resource, deps = defaultDeps()) {
  try {
    if (resource === 'offer') return await handleOffer(req, res, deps);
    if (resource === 'qr') return await handleQr(req, res, deps);
    return res.status(404).json({ error: 'unknown resource' });
  } catch (e) {
    console.error('[qr] unhandled:', e.message || e);
    return res.status(500).json({ error: 'internal error' });
  }
}

module.exports = {
  handle,
  readLiveOffer,
  defaultDeps,
  IG_HANDLE_RE,
  parseTarget,
  isOwnSite,
  sanitizePlacement,
  validateOffer,
  lintCopy,
  offerStatus,
  todayIn,
  dayKeys,
  LAYOUTS,
  LAYOUT_TAGLINE,
  LIMITS,
  FALLBACK_TARGET,
  TIME_ZONE,
};
