// POST /api/driver/submit — batch submit a route sheet.
//
// Body: { forDate: 'YYYY-MM-DD' | null, routeKey: 'FSQ'|'LYN'|'FBW', entries: [{ stopId, soldSingles, soldDoubles }, ...] }
//
// Server computes sold_cents using fixed pricing ($2.15 single / $3.85 double),
// upserts one `returns` row per stop (unique on (for_date, stop_id)), then —
// when the Google service account is configured — appends one row per sheet tab
// (two for LYN). The sheet push is best-effort: if it fails the data is still
// saved and the response carries sheet_error.
const { supabase, requireRole } = require('../_lib/auth');

const PRICE_SINGLE_CENTS = 215;
const PRICE_DOUBLE_CENTS = 385;
// Per-stop overrides live on stops.price_single_cents / stops.price_double_cents
// (nullable). Null falls back to the globals above.
const priceSingleFor = s => (s && s.price_single_cents != null) ? s.price_single_cents : PRICE_SINGLE_CENTS;
const priceDoubleFor = s => (s && s.price_double_cents != null) ? s.price_double_cents : PRICE_DOUBLE_CENTS;

// Optional sheet writer — present once P6 is wired. The module is loaded
// lazily so a missing file doesn't take submits down.
async function pushToSheet(args) {
  try {
    const mod = require('../_lib/sheet');
    return await mod.appendRouteRow(args);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return { skipped: true, reason: 'sheet writer not configured yet' };
    throw e;
  }
}

const toIso = d => {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({error:'method not allowed'}); }
  const sess = await requireRole(req, res, ['driver','operator']);
  if (!sess) return;

  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const routeKey = typeof body.routeKey === 'string' ? body.routeKey : '';
  const forDate  = typeof body.forDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.forDate) ? body.forDate : null;
  const entries  = Array.isArray(body.entries) ? body.entries : [];

  if (!routeKey) return res.status(400).json({ error: 'routeKey required' });
  if (!entries.length) return res.status(400).json({ error: 'no entries' });

  // Default forDate to yesterday — matches the Google Form convention.
  let targetDate = forDate;
  if (!targetDate) {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    targetDate = toIso(y);
  }

  // Normalize + sanity-check every entry before touching the DB. sold_cents is
  // computed below, after we fetch each stop's price override.
  const inputs = [];
  for (const e of entries) {
    if (!e || typeof e.stopId !== 'string') return res.status(400).json({ error: 'bad entry: stopId required' });
    const s = Math.max(0, Math.round(Number(e.soldSingles) || 0));
    const d = Math.max(0, Math.round(Number(e.soldDoubles) || 0));
    inputs.push({ stopId: e.stopId, soldSingles: s, soldDoubles: d });
  }

  try {
    const sb = supabase();

    // Guard: only accept stop_ids that belong to this route and are active.
    // Also hard-cap sold counts at the drop size for the target weekday.
    const stopIds = inputs.map(r => r.stopId);
    const { data: stops, error: se } = await sb
      .from('stops')
      .select('id,route_key,active,name,town,stop_order,singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd,price_single_cents,price_double_cents')
      .in('id', stopIds);
    if (se) throw se;
    const stopById = Object.create(null);
    stops.forEach(s => { stopById[s.id] = s; });

    // Day-of-week for the submission date decides which drop size applies.
    const dow = new Date(targetDate + 'T12:00:00').getDay();
    const isWeekend = dow === 0 || dow === 6;
    const singlesFor = s => isWeekend && s.singles_drop_wknd != null ? s.singles_drop_wknd : s.singles_drop;
    const doublesFor = s => isWeekend && s.doubles_drop_wknd != null ? s.doubles_drop_wknd : s.doubles_drop;

    const rows = [];
    for (const r of inputs) {
      const s = stopById[r.stopId];
      if (!s)                     return res.status(404).json({ error: `stop not found: ${r.stopId}` });
      if (s.route_key !== routeKey) return res.status(400).json({ error: `stop ${s.name} not in route ${routeKey}` });
      if (!s.active)              return res.status(409).json({ error: `stop ${s.name} is inactive` });
      const maxS = singlesFor(s), maxD = doublesFor(s);
      if (r.soldSingles > maxS) return res.status(400).json({ error: `${s.name}: ${r.soldSingles} singles sold exceeds drop of ${maxS}` });
      if (r.soldDoubles > maxD) return res.status(400).json({ error: `${s.name}: ${r.soldDoubles} doubles sold exceeds drop of ${maxD}` });
      rows.push({
        for_date:     targetDate,
        route_key:    routeKey,
        stop_id:      r.stopId,
        sold_singles: r.soldSingles,
        sold_doubles: r.soldDoubles,
        sold_cents:   r.soldSingles * priceSingleFor(s) + r.soldDoubles * priceDoubleFor(s),
        submitted_by: sess.sub,
        submitted_at: new Date().toISOString(),
      });
    }

    const { error: ue } = await sb.from('returns').upsert(rows, { onConflict: 'for_date,stop_id' });
    if (ue) { console.error('submit upsert:', ue); return res.status(500).json({ error: 'server error' }); }

    // Totals for the response (back-end is source of truth).
    const totals = rows.reduce((a, r) => ({
      singles: a.singles + r.sold_singles,
      doubles: a.doubles + r.sold_doubles,
      cents:   a.cents   + r.sold_cents,
    }), { singles: 0, doubles: 0, cents: 0 });

    // For the sheet row, send the driver's FULL state for this date+route
    // (not just the current batch). That way re-submits upsert the existing
    // sheet row cleanly — stops touched in a prior submit still show up.
    const { data: myAll, error: me } = await sb.from('returns')
      .select('stop_id, sold_singles, sold_doubles, sold_cents')
      .eq('for_date', targetDate)
      .eq('route_key', routeKey)
      .eq('submitted_by', sess.sub);
    if (me) throw me;
    // Need stop names for every row (sheet writer keys off stop.name).
    const allStopIds = Array.from(new Set(myAll.map(r => r.stop_id)));
    let stopByIdAll = stopById;
    const missing = allStopIds.filter(id => !stopByIdAll[id]);
    if (missing.length) {
      const { data: more } = await sb.from('stops').select('id,name').in('id', missing);
      stopByIdAll = Object.assign({}, stopByIdAll);
      (more || []).forEach(s => { stopByIdAll[s.id] = s; });
    }

    // Best-effort sheet push. On failure, data is already saved.
    let sheet_pushed = false, sheet_error = null, sheet_tabs = null;
    try {
      const sheet = await pushToSheet({
        supabase: sb, routeKey, forDate: targetDate,
        rows: myAll, stopById: stopByIdAll,
        driverName: sess.name,
      });
      if (sheet && sheet.ok) { sheet_pushed = true; sheet_tabs = sheet.tabs; }
      else if (sheet && sheet.skipped) sheet_error = sheet.reason;
      else if (sheet && sheet.error)   sheet_error = sheet.error;
    } catch (e) {
      sheet_error = (e && (e.message || String(e))) || 'sheet push failed';
      console.error('sheet push:', e);
    }

    return res.status(200).json({
      ok: true,
      for_date: targetDate,
      route_key: routeKey,
      stops: rows.length,
      totals,
      sheet_pushed,
      sheet_error,
      sheet_tabs,
    });
  } catch (err) {
    console.error('driver/submit error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
