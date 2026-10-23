// Store Portal — single serverless function for every /api/store?resource=…
// endpoint used by the 7-Eleven store managers. One function to stay under
// the Vercel Hobby 12-fn cap (see docs/store-portal.md).
//
// Auth: a store session is the same ppf_session cookie the staff pages
// use, with role='store' and sub=<stops.id>. The `store` role is a
// JWT-only role; it is NOT in the user_role Postgres enum — store
// managers have no row in `people`.
//
// Routing:
//   GET  ?resource=stops           — public, picker data for signin
//   POST ?resource=signin          — public, verify stop_id + pin
//   POST ?resource=stripe-webhook  — public (Stripe signature), reconcile events
//   GET  ?resource=me              — store, who am I
//   POST ?resource=signout         — store, clear cookie
//   POST ?resource=change-pin      — store, rotate own PIN
//   GET  ?resource=dashboard       — store, main payload
//   GET  ?resource=history         — store, paginated history
//   POST ?resource=issue           — store, file an issue
//   POST ?resource=change-request  — store, request a drop change
//   GET  ?resource=invoice&month=  — store, invoice JSON for one month
//   POST ?resource=payment-setup   — store, create SetupIntent for Plaid Link
//   GET  ?resource=payment-method  — store, connected bank status
//   GET  ?resource=invoices        — store, settlement invoice list
//
// Body parsing: Vercel's built-in bodyParser is DISABLED for this function
// (see `module.exports.config` at the bottom) so the Stripe webhook branch
// can verify the raw signed body. Non-webhook POST handlers get a parsed
// body transparently via `readBody(req)` — the dispatcher reads the raw
// bytes once, stores them on req.rawBody, and JSON-parses into req.body
// unless the route is the webhook.
const {
  supabase, signSession, readSession,
  setSessionCookie, clearSessionCookie,
} = require('./_lib/auth');
const {
  stripeApi, verifyStripeSignature,
  singlePriceCents, doublePriceCents,
} = require('./_lib/stripe');

const PRICE_SINGLE = 215; // cents per single, matches driver pricing
const PRICE_DOUBLE = 385;
// Chris's cell — fallback when OPERATOR_PHONE env var is unset so the
// Call/Text buttons always work on day 1. Can be overridden per-env.
const DEFAULT_OPERATOR_PHONE = '+16466681882';

const ISSUE_KINDS  = ['short_count','long_count','missed','damage','other'];
const CHANGE_KINDS = ['double','skip','custom'];

// ─── small helpers ────────────────────────────────────────────────
function readBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// Read the whole request body as a Buffer. The dispatcher calls this
// once before anything else and stashes the result on req.rawBody so the
// webhook branch can signature-verify the exact bytes Stripe sent.
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function badReq(res, msg) { return res.status(400).json({ error: msg }); }
function requireStore(sess, res) {
  if (!sess) { res.status(401).json({ error: 'not signed in' }); return false; }
  if (sess.role !== 'store') { res.status(403).json({ error: 'wrong role' }); return false; }
  return true;
}
function toIso(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
// Prefer explicit display_name, else "<name> — <town>".
function displayFor(s) {
  if (s.store_display_name) return s.store_display_name;
  return `${s.name} — ${s.town}`;
}
// URL-friendly fallback slug when the operator hasn't set a store_code yet.
function fallbackSlugFor(s) {
  const route = String(s.route_key || '').toUpperCase();
  const order = String(s.stop_order ?? '').padStart(2, '0');
  return `${route}${order}`;
}
// Normalize a code or slug for matching: uppercase, strip non-alphanumeric.
// Must match the store_code_norm GENERATED column exactly.
function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ─── public: list stops for the signin picker ────────────────────
async function handleStopsGet(req, res) {
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('stops')
      .select('id,name,town,route_key,stop_order,store_display_name,store_code,store_code_norm,store_pin_hash')
      .eq('active', true)
      .not('store_pin_hash', 'is', null)
      .order('route_key')
      .order('stop_order');
    if (error) throw error;
    const stops = (data || []).map(s => ({
      id: s.id,
      route_key: s.route_key,
      // Prefer the operator-set code; fall back to FSQ01-style auto slug.
      slug: s.store_code_norm || fallbackSlugFor(s),
      code: s.store_code || null,
      display_name: displayFor(s),
    }));
    return res.status(200).json({ stops });
  } catch (err) {
    console.error('store stops GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── public: signin ───────────────────────────────────────────────
// Accepts either { stop_id, pin } or { slug, pin } (slug like "FSQ01").
async function handleSignin(req, res) {
  const body = readBody(req);
  let stopId = typeof body.stop_id === 'string' ? body.stop_id.trim() : '';
  const slug = typeof body.slug === 'string' ? body.slug.trim().toUpperCase() : '';
  const pin  = typeof body.pin  === 'string' ? body.pin.trim()  : '';
  if ((!stopId && !slug) || !/^\d{4,8}$/.test(pin)) return badReq(res, 'stop_id or slug + 4-8 digit pin required');
  try {
    const sb = supabase();
    if (!stopId && slug) {
      const normalized = normCode(slug);
      if (!normalized) return badReq(res, 'invalid code');
      // 1) Try store_code match (normalized).
      const { data: byCode, error: ce } = await sb.rpc('find_stop_by_code', { p_code: normalized });
      if (ce) throw ce;
      if (byCode) stopId = byCode;
      // 2) Fallback: FSQ01-style auto slug (route_key + stop_order).
      if (!stopId) {
        const m = normalized.match(/^([A-Z]{3})(\d{1,3})$/);
        if (m) {
          const { data: hit, error: le } = await sb
            .from('stops')
            .select('id')
            .eq('route_key', m[1])
            .eq('stop_order', parseInt(m[2], 10))
            .eq('active', true)
            .maybeSingle();
          if (le) throw le;
          if (hit) stopId = hit.id;
        }
      }
      if (!stopId) return res.status(401).json({ error: 'wrong store or PIN' });
    }
    const { data, error } = await sb.rpc('verify_stop_pin', { p_stop_id: stopId, p_pin: pin });
    if (error) {
      console.error('verify_stop_pin:', error);
      return res.status(500).json({ error: 'server error' });
    }
    const row = Array.isArray(data) && data[0];
    if (!row) return res.status(401).json({ error: 'wrong store or PIN' });
    const token = await signSession({
      sub: row.id,
      name: row.store_display_name || `${row.name} — ${row.town}`,
      role: 'store',
    });
    setSessionCookie(res, token);
    return res.status(200).json({
      ok: true,
      stop: { id: row.id, name: row.name, town: row.town, route_key: row.route_key },
      mustChangePin: pin === '0000',
    });
  } catch (err) {
    console.error('store signin:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: me ────────────────────────────────────────────────────
async function handleMe(req, res, sess) {
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('stops')
      .select('id,name,town,address,route_key,store_display_name,singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd,basket,note')
      .eq('id', sess.sub)
      .single();
    if (error) {
      // The cookie points at a stop that no longer exists / was deactivated.
      clearSessionCookie(res);
      return res.status(401).json({ error: 'not signed in' });
    }
    return res.status(200).json({
      stop_id: data.id,
      name: data.name,
      town: data.town,
      address: data.address || null,
      route_key: data.route_key,
      display_name: displayFor(data),
      singles_drop: data.singles_drop,
      doubles_drop: data.doubles_drop,
      singles_drop_wknd: data.singles_drop_wknd,
      doubles_drop_wknd: data.doubles_drop_wknd,
      basket: data.basket,
      note: data.note,
    });
  } catch (err) {
    console.error('store me:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: signout ───────────────────────────────────────────────
function handleSignout(req, res) {
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}

// ─── store: change-pin ────────────────────────────────────────────
async function handleChangePin(req, res, sess) {
  const body = readBody(req);
  const current = typeof body.current === 'string' ? body.current.trim() : '';
  const next    = typeof body.next    === 'string' ? body.next.trim()    : '';
  if (!/^\d{4,8}$/.test(current) || !/^\d{4,8}$/.test(next)) {
    return badReq(res, 'current and new 4-8 digit pins required');
  }
  if (current === next) return badReq(res, 'new PIN must differ from current');
  try {
    const sb = supabase();
    // Verify current PIN using the same RPC — avoids pulling the hash out.
    const { data: ok, error: ve } = await sb.rpc('verify_stop_pin', { p_stop_id: sess.sub, p_pin: current });
    if (ve) throw ve;
    if (!Array.isArray(ok) || !ok[0]) return res.status(401).json({ error: 'wrong current PIN' });
    // Hash via the hash_pin helper installed in p6.
    const { data: hashed, error: he } = await sb.rpc('hash_pin', { p_pin: next });
    if (he) throw he;
    const newHash = Array.isArray(hashed) ? hashed[0] : hashed;
    // Flip pin_rotated true so /ops/invite can tell "awaiting first login"
    // (still on 0000) from "active" (manager picked their own PIN).
    const { error: ue } = await sb.from('stops').update({
      store_pin_hash: newHash,
      pin_rotated: true,
    }).eq('id', sess.sub);
    if (ue) throw ue;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('store change-pin:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: dashboard ─────────────────────────────────────────────
async function handleDashboard(req, res, sess) {
  try {
    const sb = supabase();
    const today = new Date();
    const todayIso = toIso(today);

    // Recent window = last 14 days.
    const since14 = new Date(today); since14.setDate(since14.getDate() - 14);
    const since14Iso = toIso(since14);

    // Week-to-date (Mon-anchored).
    const dow = today.getDay(); // 0 Sun … 6 Sat
    const daysSinceMon = (dow + 6) % 7;
    const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - daysSinceMon);
    const weekStartIso = toIso(weekStart);

    // Month-to-date.
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthStartIso = toIso(monthStart);
    // Quarter-to-date (3-month block anchored to Jan/Apr/Jul/Oct).
    const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
    const quarterStart = new Date(today.getFullYear(), qStartMonth, 1);
    const quarterStartIso = toIso(quarterStart);
    // Year-to-date.
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const yearStartIso = toIso(yearStart);

    // Pull all rows for the year once; slice in JS. Cheaper and cuts
    // the number of parallel requests (hobby fn cap on egress-ish).
    const [stopR, routeR, recentR, ytdR, issuesR, reqsR] = await Promise.all([
      sb.from('stops').select('id,name,town,address,route_key,store_display_name,singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd,basket,note').eq('id', sess.sub).single(),
      sb.from('routes').select('key,label'),
      sb.from('returns').select('for_date,sold_singles,sold_doubles,sold_cents,submitted_at,submitted_by,people:submitted_by(name)').eq('stop_id', sess.sub).gte('for_date', since14Iso).order('for_date', { ascending: false }),
      sb.from('returns').select('for_date,sold_singles,sold_doubles,sold_cents').eq('stop_id', sess.sub).gte('for_date', yearStartIso),
      sb.from('stop_issues').select('id,kind,note,status,for_date,created_at').eq('stop_id', sess.sub).neq('status', 'resolved').order('created_at', { ascending: false }),
      sb.from('stop_change_requests').select('id,kind,effective_date,singles_delta,doubles_delta,note,status,created_at').eq('stop_id', sess.sub).eq('status', 'pending').order('effective_date', { ascending: true }),
    ]);
    for (const r of [stopR, routeR, recentR, ytdR, issuesR, reqsR]) {
      if (r.error) throw r.error;
    }

    const stop = stopR.data;
    const routeLabel = (routeR.data || []).find(r => r.key === stop.route_key)?.label || stop.route_key;

    const sum = (rows, from, to) => {
      let gross = 0, singles = 0, doubles = 0, deliveries = 0;
      for (const r of rows) {
        if (from && r.for_date < from) continue;
        if (to   && r.for_date > to)   continue;
        if (r.sold_cents != null)   gross   += r.sold_cents;
        if (r.sold_singles != null) singles += r.sold_singles;
        if (r.sold_doubles != null) doubles += r.sold_doubles;
        deliveries += 1;
      }
      return { gross_cents: gross, singles_sold: singles, doubles_sold: doubles, deliveries };
    };

    const totals = {
      this_week:    sum(ytdR.data, weekStartIso,    todayIso),
      this_month:   sum(ytdR.data, monthStartIso,   todayIso),
      this_quarter: sum(ytdR.data, quarterStartIso, todayIso),
      ytd:          sum(ytdR.data, yearStartIso,    todayIso),
    };

    // Drop size varies by weekday (weekend may have an override on the
    // stop). We don't store the drop on each return row, so compute it
    // from the stop + for_date here.
    const dropFor = iso => {
      const d = new Date(iso + 'T12:00:00');
      const dow = d.getDay(); const wknd = dow === 0 || dow === 6;
      return {
        singles: (wknd && stop.singles_drop_wknd != null) ? stop.singles_drop_wknd : stop.singles_drop,
        doubles: (wknd && stop.doubles_drop_wknd != null) ? stop.doubles_drop_wknd : stop.doubles_drop,
      };
    };
    const recent = (recentR.data || []).map(r => {
      const dr = dropFor(r.for_date);
      return {
        for_date: r.for_date,
        singles_drop: dr.singles,
        doubles_drop: dr.doubles,
        sold_singles: r.sold_singles,
        sold_doubles: r.sold_doubles,
        sold_cents: r.sold_cents,
        submitted_at: r.submitted_at,
        submitted_by_name: r.people?.name || null,
      };
    });

    return res.status(200).json({
      stop: {
        id: stop.id,
        name: stop.name,
        town: stop.town,
        address: stop.address || null,
        display_name: displayFor(stop),
        basket: stop.basket,
        note: stop.note,
        singles_drop: stop.singles_drop,
        doubles_drop: stop.doubles_drop,
        singles_drop_wknd: stop.singles_drop_wknd,
        doubles_drop_wknd: stop.doubles_drop_wknd,
        route_key: stop.route_key,
        route_label: routeLabel,
      },
      totals,
      recent,
      issues: issuesR.data || [],
      change_requests: reqsR.data || [],
      operator_phone: process.env.OPERATOR_PHONE || DEFAULT_OPERATOR_PHONE,
      pricing: { single_cents: PRICE_SINGLE, double_cents: PRICE_DOUBLE },
    });
  } catch (err) {
    console.error('store dashboard:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: history ───────────────────────────────────────────────
async function handleHistory(req, res, sess) {
  const q = req.query || {};
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date();
  const defaultFrom = new Date(today); defaultFrom.setDate(defaultFrom.getDate() - 60);
  const from = typeof q.from === 'string' && re.test(q.from) ? q.from : toIso(defaultFrom);
  const to   = typeof q.to   === 'string' && re.test(q.to)   ? q.to   : toIso(today);
  try {
    const sb = supabase();
    const [stopR, retR] = await Promise.all([
      sb.from('stops').select('singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd').eq('id', sess.sub).single(),
      sb.from('returns').select('for_date,sold_singles,sold_doubles,sold_cents,submitted_at,submitted_by,people:submitted_by(name)').eq('stop_id', sess.sub).gte('for_date', from).lte('for_date', to).order('for_date', { ascending: false }),
    ]);
    if (stopR.error) throw stopR.error;
    if (retR.error)  throw retR.error;
    const stop = stopR.data;
    const dropFor = iso => {
      const d = new Date(iso + 'T12:00:00');
      const wknd = d.getDay() === 0 || d.getDay() === 6;
      return {
        singles: (wknd && stop.singles_drop_wknd != null) ? stop.singles_drop_wknd : stop.singles_drop,
        doubles: (wknd && stop.doubles_drop_wknd != null) ? stop.doubles_drop_wknd : stop.doubles_drop,
      };
    };
    const rows = (retR.data || []).map(r => {
      const dr = dropFor(r.for_date);
      return {
        for_date: r.for_date,
        singles_drop: dr.singles,
        doubles_drop: dr.doubles,
        sold_singles: r.sold_singles,
        sold_doubles: r.sold_doubles,
        sold_cents: r.sold_cents,
        submitted_at: r.submitted_at,
        submitted_by_name: r.people?.name || null,
      };
    });
    return res.status(200).json({ from, to, rows });
  } catch (err) {
    console.error('store history:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: file an issue ─────────────────────────────────────────
async function handleIssue(req, res, sess) {
  const body = readBody(req);
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const for_date = typeof body.for_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.for_date)
    ? body.for_date : null;
  if (!ISSUE_KINDS.includes(kind)) return badReq(res, 'invalid kind');
  if (note.length < 3 || note.length > 1000) return badReq(res, 'note must be 3-1000 chars');
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('stop_issues')
      .insert({ stop_id: sess.sub, kind, note, for_date })
      .select('id,kind,note,status,for_date,created_at')
      .single();
    if (error) throw error;
    // Best-effort Telegram ping. Never fail the request on tg errors.
    try {
      const { tgCall, esc } = require('./_lib/telegram');
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        const line =
          `*Store issue · ${esc(sess.name || '—')}*\n` +
          `${esc(kind.replace('_',' '))}${for_date ? ' on ' + esc(for_date) : ''}\n\n` +
          esc(note);
        await tgCall('sendMessage', {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: line,
          parse_mode: 'MarkdownV2',
        });
      }
    } catch (e) { console.error('tg notify (issue):', e.message || e); }
    return res.status(200).json({ issue: data });
  } catch (err) {
    console.error('store issue:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: request a drop change ─────────────────────────────────
async function handleChangeRequest(req, res, sess) {
  const body = readBody(req);
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const note = typeof body.note === 'string' ? body.note.trim() : null;
  const effective_date = typeof body.effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.effective_date)
    ? body.effective_date : null;
  const singles_delta = Number.isInteger(body.singles_delta) ? body.singles_delta : null;
  const doubles_delta = Number.isInteger(body.doubles_delta) ? body.doubles_delta : null;
  if (!CHANGE_KINDS.includes(kind))  return badReq(res, 'invalid kind');
  if (!effective_date)               return badReq(res, 'effective_date (YYYY-MM-DD) required');
  if (kind === 'custom' && singles_delta == null && doubles_delta == null) {
    return badReq(res, 'custom change needs singles_delta and/or doubles_delta');
  }
  if (effective_date < toIso(new Date())) return badReq(res, 'effective_date must be today or later');
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('stop_change_requests')
      .insert({ stop_id: sess.sub, kind, effective_date, singles_delta, doubles_delta, note })
      .select('id,kind,effective_date,singles_delta,doubles_delta,note,status,created_at')
      .single();
    if (error) throw error;
    try {
      const { tgCall, esc } = require('./_lib/telegram');
      if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        const parts = [`*Store request · ${esc(sess.name || '—')}*`];
        parts.push(
          kind === 'double' ? `Double drop on ${esc(effective_date)}`
          : kind === 'skip' ? `Skip drop on ${esc(effective_date)}`
          : `Custom drop on ${esc(effective_date)}  ·  Δsingles ${esc(String(singles_delta ?? 0))}  Δdoubles ${esc(String(doubles_delta ?? 0))}`,
        );
        if (note) parts.push('', esc(note));
        await tgCall('sendMessage', {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: parts.join('\n'),
          parse_mode: 'MarkdownV2',
        });
      }
    } catch (e) { console.error('tg notify (change-request):', e.message || e); }
    return res.status(200).json({ request: data });
  } catch (err) {
    console.error('store change-request:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: invoice JSON for one month ────────────────────────────
async function handleInvoice(req, res, sess) {
  const q = req.query || {};
  const month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : null;
  if (!month) return badReq(res, 'month=YYYY-MM required');
  const [yy, mm] = month.split('-').map(n => parseInt(n, 10));
  const start = new Date(yy, mm - 1, 1);
  const end   = new Date(yy, mm,     0);
  const startIso = toIso(start), endIso = toIso(end);
  try {
    const sb = supabase();
    const [stopR, rowsR] = await Promise.all([
      sb.from('stops').select('id,name,town,address,route_key,store_display_name,singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd').eq('id', sess.sub).single(),
      sb.from('returns').select('for_date,sold_singles,sold_doubles,sold_cents').eq('stop_id', sess.sub).gte('for_date', startIso).lte('for_date', endIso).order('for_date'),
    ]);
    if (stopR.error) throw stopR.error;
    if (rowsR.error) throw rowsR.error;
    const stop = stopR.data;
    const dropFor = iso => {
      const d = new Date(iso + 'T12:00:00');
      const wknd = d.getDay() === 0 || d.getDay() === 6;
      return {
        singles: (wknd && stop.singles_drop_wknd != null) ? stop.singles_drop_wknd : stop.singles_drop,
        doubles: (wknd && stop.doubles_drop_wknd != null) ? stop.doubles_drop_wknd : stop.doubles_drop,
      };
    };
    const rows = (rowsR.data || []).map(r => {
      const dr = dropFor(r.for_date);
      return {
        for_date: r.for_date,
        singles_drop: dr.singles,
        doubles_drop: dr.doubles,
        sold_singles: r.sold_singles,
        sold_doubles: r.sold_doubles,
        sold_cents: r.sold_cents,
      };
    });
    let gross = 0, singles = 0, doubles = 0;
    for (const r of rows) {
      if (r.sold_cents   != null) gross   += r.sold_cents;
      if (r.sold_singles != null) singles += r.sold_singles;
      if (r.sold_doubles != null) doubles += r.sold_doubles;
    }
    return res.status(200).json({
      month,
      stop: { id: stop.id, display_name: displayFor(stop), address: stop.address || null },
      rows,
      totals: { gross_cents: gross, singles_sold: singles, doubles_sold: doubles, deliveries: rows.length },
      pricing: { single_cents: PRICE_SINGLE, double_cents: PRICE_DOUBLE },
    });
  } catch (err) {
    console.error('store invoice:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: payment-setup (create SetupIntent for Plaid Link) ─────
// Backs the Connect Bank CTA on /store/billing. Returns a Stripe
// SetupIntent client_secret the frontend passes into
// stripe.collectBankAccountForSetup() with verification_method=instant,
// which opens Plaid Link inside Stripe.js. On success Stripe fires
// setup_intent.succeeded; the webhook branch records the PM id.
async function handlePaymentSetup(req, res, sess) {
  try {
    const sb = supabase();
    const { data: stop, error } = await sb
      .from('stops').select('id,payment_mode,billing_cadence,stripe_customer_id,store_display_name,name,town,manager_email')
      .eq('id', sess.sub).single();
    if (error || !stop) return res.status(404).json({ error: 'stop not found' });
    if (stop.payment_mode !== 'electronic') {
      return res.status(400).json({ error: 'stop is not opted in to electronic settlement — operator must enable first' });
    }
    let customerId = stop.stripe_customer_id;
    // Lazy-create the Stripe Customer. The operator flow usually creates
    // it when flipping payment_mode to electronic, but we re-create here
    // if it's somehow missing so the Connect Bank CTA never dead-ends.
    if (!customerId) {
      const cust = await stripeApi('POST', '/customers', {
        body: {
          name:  stop.store_display_name || `${stop.name} — ${stop.town}`,
          email: stop.manager_email || undefined,
          metadata: { stop_id: stop.id },
        },
        idempotencyKey: `customer-stop-${stop.id}`,
      });
      customerId = cust.id;
      await sb.from('stops').update({ stripe_customer_id: customerId }).eq('id', stop.id);
    }
    const si = await stripeApi('POST', '/setup_intents', {
      body: {
        customer: customerId,
        payment_method_types: ['us_bank_account'],
        payment_method_options: {
          us_bank_account: { verification_method: 'instant' },
        },
        metadata: { stop_id: stop.id },
      },
    });
    return res.status(200).json({ client_secret: si.client_secret, customer_id: customerId });
  } catch (err) {
    console.error('store payment-setup:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: err.message || 'server error' });
  }
}

// ─── store: payment-method (connected bank status) ────────────────
async function handlePaymentMethod(req, res, sess) {
  try {
    const sb = supabase();
    const { data: stop, error } = await sb
      .from('stops').select('id,payment_mode,billing_cadence,stripe_pm_id,stripe_customer_id,bank_last4,plaid_connected_at')
      .eq('id', sess.sub).single();
    if (error || !stop) return res.status(404).json({ error: 'stop not found' });
    const connected = !!stop.stripe_pm_id;
    return res.status(200).json({
      payment_mode: stop.payment_mode,
      billing_cadence: stop.billing_cadence,
      connected,
      bank_last4: stop.bank_last4 || null,
      connected_at: stop.plaid_connected_at || null,
      // Not secret — this is what Stripe.js uses to render Plaid Link in
      // the browser. Returning it here means /store/billing.html doesn't
      // need a build step or inline injection.
      stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    });
  } catch (err) {
    console.error('store payment-method:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store: invoices (manager settlement list) ────────────────────
async function handleStoreInvoicesGet(req, res, sess) {
  const q = req.query || {};
  const limit = Math.max(1, Math.min(60, parseInt(q.limit, 10) || 12));
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('invoices')
      .select('id,period_start,period_end,cadence,status,singles_count,doubles_count,singles_cents,doubles_cents,total_cents,created_at,approved_at,pulled_at,paid_at,failed_at,voided_at,failure_code,failure_message')
      .eq('stop_id', sess.sub)
      .not('status', 'eq', 'draft')
      .order('period_end', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.status(200).json({ invoices: data || [] });
  } catch (err) {
    console.error('store invoices:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── public: Stripe webhook ───────────────────────────────────────
// Verifies the Stripe-Signature header, dedupes on event.id, and applies
// status transitions. Returns 200 even on dedupe hits so Stripe stops
// retrying. Only logs/returns 400 for signature failures.
async function handleStripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET missing' });
  const sig = req.headers['stripe-signature'] || '';
  let event;
  try {
    event = verifyStripeSignature(req.rawBody, sig, secret);
  } catch (e) {
    console.error('stripe signature:', e.message || e);
    return res.status(400).json({ error: 'bad signature' });
  }
  try {
    const sb = supabase();
    // Dedupe by event.id. If we've seen it, acknowledge without re-running.
    const { error: ie } = await sb.from('stripe_events').insert({ id: event.id, type: event.type });
    if (ie && ie.code !== '23505') throw ie;
    if (ie && ie.code === '23505') return res.status(200).json({ received: true, duplicate: true });

    await handleStripeEvent(sb, event);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe webhook:', err && (err.stack || err.message || err));
    // Return 200 anyway so Stripe doesn't retry forever on a bug on our
    // side; the error is recorded in logs for the operator to triage.
    // Exception: for truly transient DB errors we return 500 so Stripe
    // retries with its own backoff.
    const transient = err.code === 'PGRST000' || err.message?.includes('timeout');
    return res.status(transient ? 500 : 200).json({ received: true, error: err.message || String(err) });
  }
}

async function handleStripeEvent(sb, event) {
  const type = event.type;
  const data = event.data?.object || {};
  if (type === 'setup_intent.succeeded') {
    const customerId = typeof data.customer === 'string' ? data.customer : data.customer?.id;
    const pmId       = typeof data.payment_method === 'string' ? data.payment_method : data.payment_method?.id;
    if (!customerId || !pmId) return;
    // Fetch the PM so we can store last4 for display.
    let last4 = null;
    try {
      const pm = await stripeApi('GET', `/payment_methods/${pmId}`);
      last4 = pm.us_bank_account?.last4 || null;
    } catch (e) { console.error('fetch PM for last4:', e.message || e); }
    await sb.from('stops').update({
      stripe_pm_id: pmId,
      plaid_connected_at: new Date().toISOString(),
      bank_last4: last4,
    }).eq('stripe_customer_id', customerId);
    return;
  }
  if (type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'invoice.finalization_failed') {
    const stripeInvId = data.id;
    const { data: inv } = await sb.from('invoices').select('id,status,total_cents,stop_id').eq('stripe_invoice_id', stripeInvId).maybeSingle();
    if (!inv) return;
    if (type === 'invoice.paid' && inv.status !== 'paid') {
      const now = new Date().toISOString();
      await sb.from('invoices').update({ status: 'paid', paid_at: now }).eq('id', inv.id);
      await sb.from('invoice_events').insert({ invoice_id: inv.id, from_status: inv.status, to_status: 'paid', actor: 'system:webhook', source: event.id });
      const piId = typeof data.payment_intent === 'string' ? data.payment_intent : data.payment_intent?.id;
      if (piId) {
        await sb.from('invoice_payments').upsert({
          invoice_id: inv.id,
          stripe_payment_intent_id: piId,
          status: 'succeeded',
          amount_cents: inv.total_cents,
          settled_at: now,
        }, { onConflict: 'stripe_payment_intent_id' });
      }
    }
    if (type === 'invoice.payment_failed' && inv.status !== 'failed') {
      const now = new Date().toISOString();
      // Try to tease an ACH return code / reason out of the event.
      const pi = data.payment_intent;
      let code = null, message = null;
      if (pi && typeof pi === 'object') {
        code = pi.last_payment_error?.code || pi.last_payment_error?.decline_code || null;
        message = pi.last_payment_error?.message || null;
      }
      await sb.from('invoices').update({
        status: 'failed', failed_at: now,
        failure_code: code, failure_message: message,
      }).eq('id', inv.id);
      await sb.from('invoice_events').insert({
        invoice_id: inv.id, from_status: inv.status, to_status: 'failed',
        actor: 'system:webhook', source: event.id,
        note: code ? `${code}: ${message || ''}` : (message || null),
      });
      const piId = typeof pi === 'string' ? pi : pi?.id;
      if (piId) {
        await sb.from('invoice_payments').upsert({
          invoice_id: inv.id,
          stripe_payment_intent_id: piId,
          status: 'failed',
          amount_cents: inv.total_cents,
          settled_at: now,
          error_code: code,
          error_message: message,
        }, { onConflict: 'stripe_payment_intent_id' });
      }
      // Fire-and-forget Telegram alert.
      try {
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
          const { tgCall, esc } = require('./_lib/telegram');
          const { data: s } = await sb.from('stops').select('store_display_name,name,town').eq('id', inv.stop_id).maybeSingle();
          const label = s?.store_display_name || `${s?.name || '?'} — ${s?.town || ''}`;
          const dollars = `$${(inv.total_cents / 100).toFixed(2)}`;
          await tgCall('sendMessage', {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `*ACH pull failed · ${esc(label)}*\n${esc(dollars)}${code ? '  ·  `' + esc(code) + '`' : ''}${message ? '\n\n' + esc(message) : ''}`,
            parse_mode: 'MarkdownV2',
          });
        }
      } catch (e) { console.error('tg notify (ach fail):', e.message || e); }
    }
    if (type === 'invoice.finalization_failed' && inv.status !== 'failed') {
      const now = new Date().toISOString();
      await sb.from('invoices').update({ status: 'failed', failed_at: now, failure_code: 'finalization_failed', failure_message: data.last_finalization_error?.message || null }).eq('id', inv.id);
      await sb.from('invoice_events').insert({ invoice_id: inv.id, from_status: inv.status, to_status: 'failed', actor: 'system:webhook', source: event.id, note: 'finalization_failed' });
    }
    return;
  }
  if (type === 'payment_intent.processing') {
    const invId = data.invoice;
    if (!invId) return;
    const { data: inv } = await sb.from('invoices').select('id,status,total_cents').eq('stripe_invoice_id', invId).maybeSingle();
    if (!inv) return;
    if (inv.status !== 'processing' && inv.status !== 'paid') {
      const now = new Date().toISOString();
      await sb.from('invoices').update({ status: 'processing', pulled_at: now, stripe_payment_intent: data.id }).eq('id', inv.id);
      await sb.from('invoice_events').insert({ invoice_id: inv.id, from_status: inv.status, to_status: 'processing', actor: 'system:webhook', source: event.id });
      await sb.from('invoice_payments').upsert({
        invoice_id: inv.id,
        stripe_payment_intent_id: data.id,
        status: 'processing',
        amount_cents: inv.total_cents,
      }, { onConflict: 'stripe_payment_intent_id' });
    }
    return;
  }
  // Unhandled event types are a no-op — not an error.
}

// ─── dispatcher ───────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const resource = typeof q.resource === 'string' ? q.resource : '';
  const method   = req.method;

  // Vercel's body parser is disabled (see config export below) so we can
  // verify the raw Stripe signature. Read the body once, then JSON-parse
  // onto req.body for every non-webhook POST so existing readBody() works.
  if (method && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    try {
      const raw = await readRawBody(req);
      req.rawBody = raw;
      if (resource !== 'stripe-webhook') {
        const text = raw.toString('utf8');
        if (text) {
          try { req.body = JSON.parse(text); } catch { req.body = {}; }
        } else {
          req.body = {};
        }
      }
    } catch (e) {
      console.error('read raw body:', e.message || e);
    }
  }

  // Public resources — no cookie needed.
  if (resource === 'stops'  && method === 'GET')          return handleStopsGet(req, res);
  if (resource === 'signin' && method === 'POST')         return handleSignin(req, res);
  if (resource === 'stripe-webhook' && method === 'POST') return handleStripeWebhook(req, res);

  // Everything else needs a store session.
  const sess = await readSession(req);
  if (!requireStore(sess, res)) return;

  if (resource === 'me'              && method === 'GET')  return handleMe(req, res, sess);
  if (resource === 'signout'         && method === 'POST') return handleSignout(req, res);
  if (resource === 'change-pin'      && method === 'POST') return handleChangePin(req, res, sess);
  if (resource === 'dashboard'       && method === 'GET')  return handleDashboard(req, res, sess);
  if (resource === 'history'         && method === 'GET')  return handleHistory(req, res, sess);
  if (resource === 'issue'           && method === 'POST') return handleIssue(req, res, sess);
  if (resource === 'change-request'  && method === 'POST') return handleChangeRequest(req, res, sess);
  if (resource === 'invoice'         && method === 'GET')  return handleInvoice(req, res, sess);
  if (resource === 'payment-setup'   && method === 'POST') return handlePaymentSetup(req, res, sess);
  if (resource === 'payment-method'  && method === 'GET')  return handlePaymentMethod(req, res, sess);
  if (resource === 'invoices'        && method === 'GET')  return handleStoreInvoicesGet(req, res, sess);

  res.setHeader('Allow', 'GET, POST');
  return res.status(404).json({ error: 'unknown resource or method' });
};

// Disable Vercel's automatic JSON body parser so stripe-webhook can
// signature-verify the raw bytes Stripe sent. Every other POST route
// still sees a parsed req.body because the dispatcher reads the raw
// buffer once and JSON-parses it for non-webhook routes.
module.exports.config = { api: { bodyParser: false } };
