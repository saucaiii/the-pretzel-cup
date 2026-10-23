// /api/plan-state — server storage for the 90-Day Plan page.
//
// Data model: one Redis hash per group. The groups match the four state
// objects the plan page keeps:
//   done   → task completion flags       (boolean-ish, stored as "true")
//   pushed → urgent-store push flags     (boolean-ish, stored as "true")
//   tstat  → target-row status dropdowns (string: "Not pitched", "Signed", …)
//   ostat  → everything else (supplier / bar statuses, approval checkboxes,
//            drop-count checkboxes, dead-stop reason dropdowns)
//
// Why four hashes and not one JSON blob: concurrent edits to different
// keys never race. HSET / HDEL operate on a single field atomically, so
// two operators editing different items both land cleanly.
//
// Auth: shared-secret header x-ops-password == OPS_PASSWORD (env var).
// Same password the client gate on /ops already uses in page source;
// mirroring it on the server locks down the write endpoint from random
// traffic without requiring any real user system.
//
// Values are JSON-encoded strings so the round-trip preserves true/false
// vs "Signed" (string). On GET we JSON.parse each field.

const { Redis } = require('@upstash/redis');

const GROUPS = ['done', 'pushed', 'tstat', 'ostat'];
const KEY = g => `ppf:plan:${g}`;

// File-backed dev fallback — ONLY used for local dev (`vercel dev`
// without Upstash env vars). `vercel dev` reloads modules per request,
// so in-memory state doesn't survive; a JSON file does. Production
// refuses to use this fallback (see redis() below).
const path = require('path');
const fs = require('fs');
const DEV_FILE = path.join(require('os').tmpdir(), 'pretzel-cup-plan-state.json');
function _readDev() {
  try { return JSON.parse(fs.readFileSync(DEV_FILE, 'utf8')); }
  catch { return { 'ppf:plan:done': {}, 'ppf:plan:pushed': {}, 'ppf:plan:tstat': {}, 'ppf:plan:ostat': {} }; }
}
function _writeDev(state) {
  try { fs.writeFileSync(DEV_FILE, JSON.stringify(state)); } catch (e) { console.warn('[plan-state] dev write failed:', e.message); }
}
const _memClient = {
  async hgetall(k) { const s = _readDev(); return s[k] ? { ...s[k] } : {}; },
  async hset(k, obj) { const s = _readDev(); s[k] = { ...(s[k] || {}), ...obj }; _writeDev(s); return 1; },
  async hdel(k, field) { const s = _readDev(); if (s[k]) delete s[k][field]; _writeDev(s); return 1; },
  async del(k) { const s = _readDev(); s[k] = {}; _writeDev(s); return 1; },
};

let _redis = null;
function redis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.VERCEL_ENV === 'production') {
      throw new Error('Upstash env vars missing in production');
    }
    console.warn('[plan-state] Upstash env vars missing — using in-memory dev fallback (ephemeral).');
    _redis = _memClient;
    return _redis;
  }
  _redis = new Redis({ url, token });
  return _redis;
}

// Gate is now the shared session cookie (P1). Operator role required.
// Supports a legacy x-ops-password header for one more deploy window so
// anyone with the old plan page loaded in a tab still works until they
// reload. Remove once we're sure no stale clients remain.
const { readSession } = require('./_lib/auth');

function unauthorized(res, msg) {
  res.status(401).json({ error: msg || 'unauthorized' });
}

async function checkGate(req) {
  const sess = await readSession(req).catch(() => null);
  if (sess && sess.role === 'operator') return true;
  const expected = process.env.OPS_PASSWORD;
  if (expected) {
    const got = req.headers['x-ops-password'];
    if (typeof got === 'string' && got === expected) return true;
  }
  return false;
}

// Pull the raw hash from Redis and JSON-parse each field. Upstash returns
// values typed by the SDK: strings came back as strings, so parse defensively.
async function readGroup(g) {
  const raw = await redis().hgetall(KEY(g));
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (v == null) continue;
    try {
      out[k] = typeof v === 'string' ? JSON.parse(v) : v;
    } catch {
      out[k] = v;
    }
  }
  return out;
}

async function readAll() {
  const parts = await Promise.all(GROUPS.map(readGroup));
  const out = {};
  GROUPS.forEach((g, i) => { out[g] = parts[i]; });
  return out;
}

module.exports = async function handler(req, res) {
  // Harden against caching — this is user-specific mutable state.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!(await checkGate(req))) return unauthorized(res);

  try {
    if (req.method === 'GET') {
      const state = await readAll();
      return res.status(200).json(state);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'object' && req.body !== null
        ? req.body
        : (function () {
            try { return JSON.parse(req.body || '{}'); } catch { return {}; }
          })();

      // Full reset — used by the "Reset progress" button.
      if (body.action === 'reset') {
        await Promise.all(GROUPS.map(g => redis().del(KEY(g))));
        return res.status(200).json({ ok: true, reset: true });
      }

      const { group, key, value } = body;
      if (!GROUPS.includes(group)) return res.status(400).json({ error: 'bad group' });
      if (typeof key !== 'string' || !key) return res.status(400).json({ error: 'bad key' });

      if (value === null || value === undefined) {
        await redis().hdel(KEY(group), key);
      } else {
        await redis().hset(KEY(group), { [key]: JSON.stringify(value) });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    // Log for the Vercel function logs; don't leak internals to the client.
    console.error('plan-state error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
