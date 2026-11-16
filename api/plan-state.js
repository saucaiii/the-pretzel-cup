// /api/plan-state — server storage for ops-page state.
//
// Two resources share this endpoint under the 12-function cap:
//   (default)   /api/plan-state         — 90-Day Plan Redis state (unchanged)
//   corkboard   /api/plan-state?resource=corkboard
//                                       — Notion-backed Builds board
//                                         for /ops/corkboard. GET lists
//                                         rows, POST creates, PATCH/DELETE
//                                         with ?id=… edit or archive.
//                                         ?action=ask proxies a chat
//                                         prompt to the mini bridge; 503
//                                         when the bridge is unset or
//                                         unreachable (graceful offline).
//
// Data model (default resource): one Redis hash per group. The groups
// match the four state objects the plan page keeps:
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
const notion = require('./_notion');

function unauthorized(res, msg) {
  res.status(401).json({ error: msg || 'unauthorized' });
}

async function checkGate(req) {
  const sess = await readSession(req).catch(() => null);
  if (sess && sess.role === 'operator') return sess;
  const expected = process.env.OPS_PASSWORD;
  if (expected) {
    const got = req.headers['x-ops-password'];
    if (typeof got === 'string' && got === expected) return { name: null, role: 'operator' };
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

// ─── corkboard resource ─────────────────────────────────────────

function corkboardEnv() {
  const token = process.env.NOTION_TOKEN;
  const db = process.env.NOTION_BUILDS_DB_ID;
  if (!token || !db) {
    const miss = [!token && 'NOTION_TOKEN', !db && 'NOTION_BUILDS_DB_ID'].filter(Boolean);
    const err = new Error(`corkboard not configured: missing ${miss.join(', ')}`);
    err.status = 503;
    throw err;
  }
  return { token, db };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

async function handleCorkboard(req, res, sess) {
  const method = req.method;
  const id = typeof req.query?.id === 'string' ? req.query.id : null;
  const action = typeof req.query?.action === 'string' ? req.query.action : null;
  const operatorName = (sess && typeof sess.name === 'string' && sess.name.trim()) ? sess.name.trim() : null;

  // Chat proxy to the mini bridge. 503 "offline" if unset/unreachable
  // so the UI can show the offline chip gracefully rather than a scary
  // 500.
  if (action === 'ask') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'method not allowed' });
    }
    const url = process.env.MINI_BRIDGE_URL;
    const bridgeToken = process.env.MINI_BRIDGE_TOKEN;
    if (!url || !bridgeToken) {
      return res.status(503).json({ error: 'claude bridge offline', offline: true });
    }
    const body = await readJsonBody(req);
    // Stamp the operator name so the bridge can attribute any card writes.
    // Server-stamped (not client-sent) so it can't be spoofed by a stale page.
    if (operatorName) body.addedBy = operatorName;
    try {
      const upstream = await fetch(`${url.replace(/\/$/, '')}/ask`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridgeToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // Bridge should answer in a few seconds; abort anything that
        // stalls so we never hold a serverless function hostage.
        signal: AbortSignal.timeout(25000),
      });
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
      return res.send(text);
    } catch (e) {
      return res.status(503).json({ error: 'claude bridge unreachable', offline: true, detail: String(e?.message || e).slice(0, 200) });
    }
  }

  const { token, db } = corkboardEnv();

  if (method === 'GET') {
    // Short CDN cache: Notion rate-limits at 3 req/s. 30s is enough for
    // operator latency without masking a just-made edit (the frontend
    // bypasses cache on save by sending Cache-Control: no-cache).
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    const builds = await notion.listBuilds({ db, token });
    return res.status(200).json({ builds });
  }

  if (method === 'POST') {
    const patch = await readJsonBody(req);
    if (!patch || typeof patch.name !== 'string' || !patch.name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    // Server-stamped so the client can't spoof it.
    if (operatorName) patch.addedBy = operatorName;
    const build = await notion.createBuild({ db, token, patch });
    return res.status(201).json({ build });
  }

  if (method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id required' });
    const patch = await readJsonBody(req);
    const build = await notion.updateBuild({ token, id, patch });
    return res.status(200).json({ build });
  }

  if (method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id required' });
    await notion.archiveBuild({ token, id });
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'method not allowed' });
}

module.exports = async function handler(req, res) {
  // Harden against caching — this is user-specific mutable state.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const sess = await checkGate(req);
  if (!sess) return unauthorized(res);

  const resource = typeof req.query?.resource === 'string' ? req.query.resource : null;
  if (resource === 'corkboard') {
    try {
      return await handleCorkboard(req, res, sess);
    } catch (err) {
      const status = err?.status || 500;
      if (status >= 500) console.error('corkboard error:', err && (err.stack || err.message || err));
      return res.status(status).json({ error: err?.message || 'server error' });
    }
  }

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
