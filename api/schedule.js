// GET  /api/schedule?week=0|1       — grid for this week (0) or next week (1).
//                                     Returns days[], people[], shifts[],
//                                     and approved time-off rows that
//                                     override "on" to "off" or "covered-by".
// GET  /api/schedule?resource=stops  — operator-only: all stops with drop
//                                     sizes, grouped by route. Used by
//                                     the /ops drop-size editor.
// PATCH /api/schedule?resource=stops&id=…
//                                   — operator-only: update singles/doubles
//                                     drop sizes (and weekend variants) +
//                                     active flag + basket + note on one stop.
//
// Payment-flow branches (docs/payment-flow.md):
//   PATCH ?resource=stop-payment-settings&id=…  — operator: flip payment_mode,
//                                      billing_cadence, auto-creates Stripe
//                                      Customer the first time.
//   GET   ?resource=pending-invoices  — operator: draft + failed invoices
//                                      with variance flags.
//   POST  ?resource=approve-invoice   — operator: create Stripe invoice +
//                                      items, finalize (auto-pulls on ACH).
//   POST  ?resource=void-invoice      — operator: void a draft/failed invoice.
//   POST  ?resource=mark-paid         — operator: record a manual (off-Stripe)
//                                      payment against a failed invoice.
//   POST  ?resource=retry-invoice     — operator: retry a failed pull.
//   GET   ?resource=generate-drafts   — Vercel Cron (bearer CRON_SECRET):
//                                      generates draft invoices from `returns`.
//   GET   ?resource=reconciliation&month=YYYY-MM
//                                   — operator: monthly reconciliation CSV.
//
// Stops management is folded in here (not its own endpoint) because the
// Vercel Hobby plan caps us at 12 serverless functions.
const { supabase, requireRole } = require('./_lib/auth');
const auto = require('./_lib/updates');
const {
  stripeApi, singlePriceCents, doublePriceCents,
} = require('./_lib/stripe');

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

async function handleStopsGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  try {
    const sb = supabase();
    const [stopsR, routesR] = await Promise.all([
      sb.from('stops').select('id,route_key,stop_order,name,town,address,singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd,basket,note,active,shorts,store_pin_hash,store_code,store_code_norm,store_display_name,manager_first_name,manager_last_name,manager_email,manager_phone,delivery_days,pin_rotated,payment_mode,billing_cadence,stripe_customer_id,stripe_pm_id,bank_last4,plaid_connected_at,payment_notes').order('route_key').order('stop_order'),
      sb.from('routes').select('key,label,display_order').order('display_order'),
    ]);
    if (stopsR.error)  throw stopsR.error;
    if (routesR.error) throw routesR.error;
    // Attach sheet tab metadata per route so the UI can show a tab picker
    // on Add Stop. Best-effort — if the Google client isn't configured
    // (missing env in local dev), we return an empty routeTabs map and
    // the UI just hides the picker.
    let routeTabs = {};
    try {
      const { routeTabsMeta } = require('./_lib/sheet');
      for (const r of routesR.data) {
        routeTabs[r.key] = await routeTabsMeta(r.key);
      }
    } catch (e) { /* keep going without the sheet-tab picker */ }
    return res.status(200).json({ stops: stopsR.data, routes: routesR.data, route_tabs: routeTabs });
  } catch (err) {
    console.error('schedule stops GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

const BAKERY_LOCATIONS = ['Franklin Square bakery', 'Lynbrook bakery'];
const ROUTE_LOCATIONS = { FSQ: 'Franklin Square route', LYN: 'Lynbrook route', FBW: 'Freeport/Baldwin route' };

function cleanDays(input) {
  if (!Array.isArray(input)) return null;
  const out = Array.from(new Set(input.map(n => parseInt(n, 10)).filter(n => n >= 0 && n <= 6))).sort((a, b) => a - b);
  return out.length ? out : null;
}

async function handleShiftsGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('shifts')
      .select('id,person_id,role,location,route_key,days,people:person_id(name,role)')
      .order('role')
      .order('location');
    if (error) throw error;
    return res.status(200).json({ shifts: data });
  } catch (err) {
    console.error('schedule shifts GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleShiftsPost(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const personId = typeof body.person_id === 'string' ? body.person_id : '';
  const role     = ['baker','driver','operator'].includes(body.role) ? body.role : null;
  const location = typeof body.location === 'string' ? body.location.trim() : '';
  const routeKey = typeof body.route_key === 'string' && body.route_key ? body.route_key : null;
  const days     = cleanDays(body.days);
  if (!personId) return res.status(400).json({ error: 'person_id required' });
  if (!role)     return res.status(400).json({ error: 'role must be baker|driver|operator' });
  if (!location) return res.status(400).json({ error: 'location required' });
  if (!days)     return res.status(400).json({ error: 'days required (array of 0..6)' });
  try {
    const sb = supabase();
    const { data, error } = await sb.from('shifts').insert({
      person_id: personId, role, location, route_key: routeKey, days,
    }).select('id,person_id,role,location,route_key,days,people:person_id(name,role)').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, shift: data });
  } catch (err) {
    console.error('schedule shifts POST:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleShiftsPatch(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const patch = {};
  if ('location'  in body) {
    const v = typeof body.location === 'string' ? body.location.trim() : '';
    if (!v) return res.status(400).json({ error: 'location required' });
    patch.location = v;
  }
  if ('route_key' in body) patch.route_key = (typeof body.route_key === 'string' && body.route_key) ? body.route_key : null;
  if ('days'      in body) {
    const d = cleanDays(body.days);
    if (!d) return res.status(400).json({ error: 'days required (array of 0..6)' });
    patch.days = d;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no patchable fields' });
  try {
    const sb = supabase();
    const { data: before, error: be } = await sb.from('shifts').select('*').eq('id', id).single();
    if (be || !before) return res.status(404).json({ error: 'shift not found' });
    const { data, error } = await sb.from('shifts').update(patch).eq('id', id)
      .select('id,person_id,role,location,route_key,days,people:person_id(name,role)').single();
    if (error) throw error;
    // Auto-publish: location, route_key, or days change.
    let auto_update = null;
    try {
      const u = await auto.autoShiftChanged({ before, after: data, postedBy: sess.sub });
      if (u) auto_update = { id: u.id, title: u.title };
    } catch (e) { console.error('auto autoShiftChanged:', e); }
    return res.status(200).json({ ok: true, shift: data, auto_update });
  } catch (err) {
    console.error('schedule shifts PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handlePeopleGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  try {
    const sb = supabase();
    const { data, error } = await sb.from('people').select('id,name,role,telegram_handle,telegram_user_id').order('role').order('name');
    if (error) throw error;
    return res.status(200).json({ people: data });
  } catch (err) {
    console.error('schedule people GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handlePeoplePatch(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const patch = {};
  if ('telegram_handle' in body) {
    // Normalize: strip leading @, trim, lowercase for storage (we match
    // case-insensitively anyway). Empty string clears the field.
    let h = typeof body.telegram_handle === 'string' ? body.telegram_handle.trim() : '';
    if (h.startsWith('@')) h = h.slice(1);
    patch.telegram_handle = h || null;
    // When the handle changes, clear the cached user_id so the next tap re-binds.
    patch.telegram_user_id = null;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no patchable fields' });
  try {
    const sb = supabase();
    const { data, error } = await sb.from('people').update(patch).eq('id', id)
      .select('id,name,role,telegram_handle,telegram_user_id').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, person: data });
  } catch (err) {
    console.error('schedule people PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleShiftsDelete(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const sb = supabase();
    const { error } = await sb.from('shifts').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('schedule shifts DELETE:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleStopsPost(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const routeKey = typeof body.route_key === 'string' ? body.route_key.trim() : '';
  const name     = typeof body.name === 'string' ? body.name.trim() : '';
  const town     = typeof body.town === 'string' ? body.town.trim() : '';
  const address  = typeof body.address === 'string' ? body.address.trim() : '';
  const singles  = Math.max(0, Math.round(Number(body.singles_drop) || 0));
  const doubles  = Math.max(0, Math.round(Number(body.doubles_drop) || 0));
  const singlesW = body.singles_drop_wknd == null || body.singles_drop_wknd === '' ? null : Math.max(0, Math.round(Number(body.singles_drop_wknd)));
  const doublesW = body.doubles_drop_wknd == null || body.doubles_drop_wknd === '' ? null : Math.max(0, Math.round(Number(body.doubles_drop_wknd)));
  const basket   = typeof body.basket === 'string' ? body.basket.trim().slice(0, 200) : '';
  const note     = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!routeKey) return res.status(400).json({ error: 'route_key required' });
  if (!name)     return res.status(400).json({ error: 'name required' });
  if (!town)     return res.status(400).json({ error: 'town required' });
  try {
    const sb = supabase();
    // Verify the route exists.
    const { data: route, error: re } = await sb.from('routes').select('key').eq('key', routeKey).single();
    if (re || !route) return res.status(400).json({ error: `unknown route_key: ${routeKey}` });
    // Next stop_order on this route = max + 1 (so new stops append visually).
    const { data: last, error: le } = await sb.from('stops').select('stop_order').eq('route_key', routeKey).order('stop_order', { ascending: false }).limit(1);
    if (le) throw le;
    const stopOrder = ((last && last[0] && last[0].stop_order) || 0) + 1;
    const insert = {
      route_key: routeKey, stop_order: stopOrder, name, town,
      address: address || null,
      singles_drop: singles, doubles_drop: doubles,
      singles_drop_wknd: singlesW, doubles_drop_wknd: doublesW,
      basket: basket || null, note: note || null,
      active: body.active === false ? false : true,
      shorts: body.shorts === true,
    };
    const { data, error } = await sb.from('stops').insert(insert).select().single();
    if (error) throw error;

    // Auto-publish: new stop added. Best-effort — the stop insert
    // succeeds either way; the operator sees the update post in the
    // response alongside the sheet-insert result.
    let auto_update = null, auto_update_error = null;
    try {
      const u = await auto.autoNewStop({ stop: data, postedBy: sess.sub });
      auto_update = { id: u.id, title: u.title };
    } catch (e) {
      auto_update_error = (e && (e.message || String(e))) || 'auto-publish failed';
      console.error('auto autoNewStop:', e);
    }

    // Optional sheet-column insert. The operator opts in by passing the
    // target tab's gid. We only accept gids that belong to the stop's
    // own route — guards against accidentally shoving a column into an
    // unrelated tab.
    let sheet_insert = null, sheet_insert_error = null;
    const requestedGid = Number(body.sheet_insert_gid);
    if (requestedGid) {
      try {
        const { ROUTE_TABS, insertSheetColumn } = require('./_lib/sheet');
        const allowed = (ROUTE_TABS[routeKey] || []).some(t => t.gid === requestedGid);
        if (!allowed) throw new Error(`gid ${requestedGid} does not belong to route ${routeKey}`);
        // Header text matches the sheet's existing convention: "<address> (<name>)"
        // Falls back to just "(name)" if no address was provided.
        const header = address ? `${address} (${name})` : `(${name})`;
        sheet_insert = await insertSheetColumn({ gid: requestedGid, header });
      } catch (e) {
        sheet_insert_error = (e && (e.message || String(e))) || 'sheet insert failed';
        console.error('stops POST sheet insert:', e);
      }
    }
    return res.status(200).json({ ok: true, stop: data, sheet_insert, sheet_insert_error, auto_update, auto_update_error });
  } catch (err) {
    console.error('schedule stops POST:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleStopsPatch(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  // Only accept whitelisted keys so a malformed body can't corrupt fields we
  // don't own here. `route_key` IS patchable (reassigns the stop to another
  // delivery route); the handler recomputes stop_order on the target so the
  // (route_key, stop_order) unique index doesn't collide.
  const patch = {};
  const intOrNull = v => (v === null || v === '' || v === undefined) ? null
    : (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : undefined);
  const intReq = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : undefined);

  if ('singles_drop'       in body) { const n = intReq(body.singles_drop);       if (n === undefined) return res.status(400).json({ error: 'singles_drop must be a non-negative integer' }); patch.singles_drop = n; }
  if ('doubles_drop'       in body) { const n = intReq(body.doubles_drop);       if (n === undefined) return res.status(400).json({ error: 'doubles_drop must be a non-negative integer' }); patch.doubles_drop = n; }
  if ('singles_drop_wknd'  in body) { const n = intOrNull(body.singles_drop_wknd); if (n === undefined) return res.status(400).json({ error: 'singles_drop_wknd must be int or null' });     patch.singles_drop_wknd = n; }
  if ('doubles_drop_wknd'  in body) { const n = intOrNull(body.doubles_drop_wknd); if (n === undefined) return res.status(400).json({ error: 'doubles_drop_wknd must be int or null' });     patch.doubles_drop_wknd = n; }
  if ('basket'             in body) patch.basket = typeof body.basket === 'string' ? body.basket.trim().slice(0, 200) || null : null;
  if ('note'               in body) patch.note   = typeof body.note   === 'string' ? body.note.trim().slice(0, 500) || null : null;
  if ('active'             in body) patch.active = !!body.active;
  if ('shorts'             in body) patch.shorts = !!body.shorts;
  if ('route_key'          in body) {
    const rk = typeof body.route_key === 'string' ? body.route_key.trim() : '';
    if (!rk) return res.status(400).json({ error: 'route_key, if provided, must be a non-empty string' });
    patch.route_key = rk;
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no patchable fields in body' });

  try {
    const sb = supabase();
    // Snapshot the row before the update so we can diff for auto-publish.
    const { data: before, error: be } = await sb.from('stops').select('*').eq('id', id).single();
    if (be || !before) return res.status(404).json({ error: 'stop not found' });

    // Route move: validate the target route exists and recompute stop_order
    // so the new row sits at the end of the target route (unique on
    // (route_key, stop_order)).
    if ('route_key' in patch && patch.route_key !== before.route_key) {
      const { data: route, error: re } = await sb
        .from('routes').select('key').eq('key', patch.route_key).single();
      if (re || !route) return res.status(400).json({ error: `unknown route_key: ${patch.route_key}` });
      const { data: last, error: le } = await sb
        .from('stops').select('stop_order')
        .eq('route_key', patch.route_key).order('stop_order', { ascending: false }).limit(1);
      if (le) throw le;
      patch.stop_order = ((last && last[0] && last[0].stop_order) || 0) + 1;
    }

    const { data, error } = await sb.from('stops').update(patch).eq('id', id).select().single();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'another stop already holds that (route, stop_order)' });
      }
      throw error;
    }

    // Auto-publish: drop size changes (any), active flips, shorts flips,
    // and route moves.
    const autos = [];
    const dropChanged =
      ('singles_drop' in patch       && patch.singles_drop       !== before.singles_drop) ||
      ('doubles_drop' in patch       && patch.doubles_drop       !== before.doubles_drop) ||
      ('singles_drop_wknd' in patch  && patch.singles_drop_wknd  !== before.singles_drop_wknd) ||
      ('doubles_drop_wknd' in patch  && patch.doubles_drop_wknd  !== before.doubles_drop_wknd);
    if (dropChanged) {
      try {
        const u = await auto.autoDropChanged({ stop: data, before, after: data, postedBy: sess.sub });
        if (u) autos.push({ id: u.id, title: u.title, kind: 'drop' });
      } catch (e) { console.error('auto autoDropChanged:', e); }
    }
    if ('active' in patch && patch.active !== before.active) {
      try {
        const u = await auto.autoStopActiveChanged({ stop: data, nowActive: patch.active, postedBy: sess.sub });
        if (u) autos.push({ id: u.id, title: u.title, kind: 'active' });
      } catch (e) { console.error('auto autoStopActiveChanged:', e); }
    }
    if ('shorts' in patch && patch.shorts !== before.shorts) {
      try {
        const u = await auto.autoShortsChanged({ stop: data, nowShorts: patch.shorts, postedBy: sess.sub });
        if (u) autos.push({ id: u.id, title: u.title, kind: 'shorts' });
      } catch (e) { console.error('auto autoShortsChanged:', e); }
    }
    if ('route_key' in patch && patch.route_key !== before.route_key) {
      try {
        const u = await auto.postUpdate({
          title: `Stop moved: ${data.name} — ${before.route_key} → ${data.route_key}`,
          body: `${data.name} (${data.town}) is now on the ${data.route_key} route. Deliveries continue on the new route starting next pickup.`,
          audience: [],
          requiresAck: true,
          postedBy: sess.sub,
        });
        if (u) autos.push({ id: u.id, title: u.title, kind: 'route-move' });
      } catch (e) { console.error('auto route-move:', e); }
    }
    return res.status(200).json({ ok: true, stop: data, auto_updates: autos });
  } catch (err) {
    console.error('schedule stops PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store issues (operator-side) ─────────────────────────────────
async function handleStoreIssuesGet(req, res, sess) {
  try {
    const sb = supabase();
    const status = typeof (req.query && req.query.status) === 'string' ? req.query.status : 'open';
    let q = sb.from('stop_issues')
      .select('id,stop_id,kind,note,status,for_date,created_at,resolved_by,resolved_at,stops:stop_id(name,town,route_key,store_display_name)')
      .order('created_at', { ascending: false });
    if (status === 'open')     q = q.neq('status', 'resolved');
    else if (status === 'all') { /* no filter */ }
    else                       q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data || []).map(r => ({
      id: r.id, stop_id: r.stop_id, kind: r.kind, note: r.note, status: r.status,
      for_date: r.for_date, created_at: r.created_at,
      resolved_at: r.resolved_at, resolved_by: r.resolved_by,
      stop_label: r.stops?.store_display_name || `${r.stops?.name || '?'} — ${r.stops?.town || ''}`,
      route_key: r.stops?.route_key || null,
    }));
    return res.status(200).json({ issues: rows });
  } catch (err) {
    console.error('store-issues GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}
async function handleStoreIssuesPatch(req, res, sess) {
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const status = typeof body.status === 'string' ? body.status : '';
  if (!['open','acknowledged','resolved'].includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const sb = supabase();
    const patch = { status };
    if (status === 'resolved') { patch.resolved_by = sess.sub; patch.resolved_at = new Date().toISOString(); }
    else                        { patch.resolved_by = null;    patch.resolved_at = null; }
    const { data, error } = await sb.from('stop_issues').update(patch).eq('id', id).select('id,status').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, issue: data });
  } catch (err) {
    console.error('store-issues PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store change requests (operator-side) ────────────────────────
async function handleStoreRequestsGet(req, res, sess) {
  try {
    const sb = supabase();
    const status = typeof (req.query && req.query.status) === 'string' ? req.query.status : 'pending';
    let q = sb.from('stop_change_requests')
      .select('id,stop_id,kind,effective_date,singles_delta,doubles_delta,note,status,created_at,decided_by,decided_at,stops:stop_id(name,town,route_key,store_display_name)')
      .order('effective_date', { ascending: true });
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data || []).map(r => ({
      id: r.id, stop_id: r.stop_id, kind: r.kind, effective_date: r.effective_date,
      singles_delta: r.singles_delta, doubles_delta: r.doubles_delta,
      note: r.note, status: r.status, created_at: r.created_at,
      decided_at: r.decided_at, decided_by: r.decided_by,
      stop_label: r.stops?.store_display_name || `${r.stops?.name || '?'} — ${r.stops?.town || ''}`,
      route_key: r.stops?.route_key || null,
    }));
    return res.status(200).json({ requests: rows });
  } catch (err) {
    console.error('store-requests GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}
async function handleStoreRequestsPatch(req, res, sess) {
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const status = typeof body.status === 'string' ? body.status : '';
  if (!['pending','approved','denied','applied'].includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const sb = supabase();
    const patch = { status };
    if (status === 'pending') { patch.decided_by = null; patch.decided_at = null; }
    else                       { patch.decided_by = sess.sub; patch.decided_at = new Date().toISOString(); }
    const { data, error } = await sb.from('stop_change_requests').update(patch).eq('id', id).select('id,status').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, request: data });
  } catch (err) {
    console.error('store-requests PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── store PIN + code management (operator-side) ──────────────────
async function handleStorePinsPatch(req, res, sess) {
  // PATCH /api/schedule?resource=store-pins&id=<stop_id>
  //   { pin: '1234' }           → set PIN
  //   { pin: null }             → clear PIN (locks the stop out)
  //   { code: '711 SRRVC' }     → set store_code
  //   { code: null }            → clear store_code
  //   (both fields can be sent together)
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const hasPin  = Object.prototype.hasOwnProperty.call(body, 'pin');
  const hasCode = Object.prototype.hasOwnProperty.call(body, 'code');
  if (!hasPin && !hasCode) return res.status(400).json({ error: 'pin or code required' });

  const patch = {};
  try {
    const sb = supabase();
    if (hasPin) {
      const clearPin = body.pin === null || body.pin === '';
      const pin = typeof body.pin === 'string' ? body.pin.trim() : null;
      if (!clearPin && (!pin || !/^\d{4,8}$/.test(pin))) return res.status(400).json({ error: '4-8 digit pin required' });
      if (clearPin) patch.store_pin_hash = null;
      else {
        const { data: hashed, error: he } = await sb.rpc('hash_pin', { p_pin: pin });
        if (he) throw he;
        patch.store_pin_hash = Array.isArray(hashed) ? hashed[0] : hashed;
      }
    }
    if (hasCode) {
      const clearCode = body.code === null || body.code === '';
      const code = typeof body.code === 'string' ? body.code.trim() : null;
      if (clearCode) patch.store_code = null;
      else {
        if (!code || code.length > 32) return res.status(400).json({ error: 'code must be 1-32 chars' });
        patch.store_code = code;
      }
    }
    const { error: ue } = await sb.from('stops').update(patch).eq('id', id);
    if (ue) {
      // 23505 = unique_violation on store_code_norm
      if (ue.code === '23505') return res.status(409).json({ error: 'another store already has that code' });
      throw ue;
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('store-pins PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── onboard-create ──────────────────────────────────────────────
// POST /api/schedule?resource=onboard-create
// Operator-only. One-shot store creation for the /ops/onboard wizard.
// Creates the stops row with all identity + portal + manager fields set,
// hashes the portal PIN via rpc('hash_pin'), and auto-publishes a new-stop
// update to the team (same as the regular stops POST). Returns the new stop.
async function handleOnboardCreate(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const routeKey = typeof body.route_key === 'string' ? body.route_key.trim() : '';
  const name     = typeof body.name === 'string' ? body.name.trim() : '';
  const town     = typeof body.town === 'string' ? body.town.trim() : '';
  const address  = typeof body.address === 'string' ? body.address.trim() : '';
  const displayName = typeof body.store_display_name === 'string' ? body.store_display_name.trim() : '';
  const storeCode   = typeof body.store_code === 'string' ? body.store_code.trim() : '';
  const singles  = Math.max(0, Math.round(Number(body.singles_drop) || 0));
  const doubles  = Math.max(0, Math.round(Number(body.doubles_drop) || 0));
  const pin      = typeof body.portal_pin === 'string' ? body.portal_pin.trim() : '';
  const managerFirst = typeof body.manager_first_name === 'string' ? body.manager_first_name.trim() : '';
  const managerLast  = typeof body.manager_last_name === 'string' ? body.manager_last_name.trim() : '';
  const managerEmail = typeof body.manager_email === 'string' ? body.manager_email.trim() : '';
  const managerPhone = typeof body.manager_phone === 'string' ? body.manager_phone.trim() : '';
  const DAY_SET = new Set(['mon','tue','wed','thu','fri','sat','sun']);
  const deliveryDays = Array.isArray(body.delivery_days)
    ? body.delivery_days.map(d => String(d || '').toLowerCase()).filter(d => DAY_SET.has(d))
    : [];

  if (!routeKey)     return res.status(400).json({ error: 'route_key required' });
  if (!name)         return res.status(400).json({ error: 'name required' });
  if (!town)         return res.status(400).json({ error: 'town required' });
  if (!managerEmail) return res.status(400).json({ error: 'manager_email required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) {
    return res.status(400).json({ error: 'manager_email looks invalid' });
  }
  if (singles + doubles < 1) return res.status(400).json({ error: 'standing order must total at least 1 unit (singles + doubles)' });
  // Portal access is opt-in: a blank pin means the stop is created without
  // sign-in credentials and can be invited later via /ops/invite. When a pin
  // is sent it must be the standard 4 digits.
  if (pin && !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'portal_pin must be exactly 4 digits when provided' });

  try {
    const sb = supabase();
    // Verify the route exists.
    const { data: route, error: re } = await sb.from('routes').select('key').eq('key', routeKey).single();
    if (re || !route) return res.status(400).json({ error: `unknown route_key: ${routeKey}` });

    // Next stop_order on this route = max + 1.
    const { data: last, error: le } = await sb
      .from('stops').select('stop_order')
      .eq('route_key', routeKey).order('stop_order', { ascending: false }).limit(1);
    if (le) throw le;
    const stopOrder = ((last && last[0] && last[0].stop_order) || 0) + 1;

    // Hash the PIN only when the operator opted in. No pin → null store_pin_hash
    // → portal sign-in is off for this stop until /ops/invite backfills it.
    let hashed = null;
    if (pin) {
      const { data: h, error: he } = await sb.rpc('hash_pin', { p_pin: pin });
      if (he) throw he;
      hashed = h;
    }

    const insert = {
      route_key: routeKey,
      stop_order: stopOrder,
      name,
      town,
      address: address || null,
      singles_drop: singles,
      doubles_drop: doubles,
      active: true,
      shorts: false,
      store_pin_hash: hashed,
      store_display_name: displayName || `${name} — ${town}`,
      store_code: storeCode || null,
      manager_first_name: managerFirst || null,
      manager_last_name:  managerLast  || null,
      manager_email:      managerEmail,
      manager_phone:      managerPhone || null,
      delivery_days:      deliveryDays,
    };

    const { data, error } = await sb.from('stops').insert(insert).select().single();
    if (error) {
      // 23505 = unique_violation. The only unique indexes on stops that this
      // insert can hit are (route_key, stop_order) and store_code_norm.
      if (error.code === '23505') {
        const msg = /store_code/.test(error.message || '')
          ? 'another store already has that code'
          : 'that stop_order already exists on the route';
        return res.status(409).json({ error: msg });
      }
      throw error;
    }

    // Best-effort auto-publish — same as /ops/stops Add Stop. Failure here
    // does NOT fail the onboarding; the operator still sees the new store.
    let auto_update = null, auto_update_error = null;
    try {
      const u = await auto.autoNewStop({ stop: data, postedBy: sess.sub });
      auto_update = { id: u.id, title: u.title };
    } catch (e) {
      auto_update_error = (e && (e.message || String(e))) || 'auto-publish failed';
      console.error('onboard-create auto-publish:', e);
    }

    // Optional Google Sheet column insert. Same pattern the deprecated stops
    // POST used: only accept a gid that belongs to the stop's own route tab
    // map, so a bad input can't shove a column into an unrelated tab. Failure
    // here does NOT fail the onboarding — the stop is in Supabase either way.
    let sheet_insert = null, sheet_insert_error = null;
    const requestedGid = Number(body.sheet_insert_gid);
    if (requestedGid) {
      try {
        const { ROUTE_TABS, insertSheetColumn } = require('./_lib/sheet');
        const allowed = (ROUTE_TABS[routeKey] || []).some(t => t.gid === requestedGid);
        if (!allowed) throw new Error(`gid ${requestedGid} does not belong to route ${routeKey}`);
        const header = address ? `${address} (${name})` : `(${name})`;
        sheet_insert = await insertSheetColumn({ gid: requestedGid, header });
      } catch (e) {
        sheet_insert_error = (e && (e.message || String(e))) || 'sheet insert failed';
        console.error('onboard-create sheet insert:', e);
      }
    }

    return res.status(200).json({
      ok: true, stop: data,
      auto_update, auto_update_error,
      sheet_insert, sheet_insert_error,
    });
  } catch (err) {
    console.error('onboard-create POST:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── portal-invite ──────────────────────────────────────────────
// POST /api/schedule?resource=portal-invite
// Operator-only. Grants portal access to an EXISTING stop: sets the
// manager contact fields + bcrypts the portal PIN. Used by /ops/invite
// to backfill portal access on stores already on the route (as opposed
// to /ops/onboard which creates brand-new stops).
//
// Unlike onboard-create this does NOT auto-publish an update — nothing
// changed about the route; we're just enabling a login.
async function handlePortalInvite(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const stopId = typeof body.stop_id === 'string' ? body.stop_id.trim() : '';
  // Starter PIN is always '0000'. Matches the driver/baker pattern: the
  // store manager rotates to their own PIN on first sign-in via /api/store
  // ?resource=change-pin (store.js already returns mustChangePin for '0000').
  const pin    = '0000';
  const first  = typeof body.manager_first_name === 'string' ? body.manager_first_name.trim() : '';
  const last   = typeof body.manager_last_name === 'string' ? body.manager_last_name.trim() : '';
  const email  = typeof body.manager_email === 'string' ? body.manager_email.trim() : '';
  const phone  = typeof body.manager_phone === 'string' ? body.manager_phone.trim() : '';
  const force  = body.force === true;

  if (!stopId) return res.status(400).json({ error: 'stop_id required' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'manager_email looks invalid' });
  }

  try {
    const sb = supabase();

    // Guard: refuse to overwrite a PIN already set unless force=true. Prevents
    // accidental re-generation that would lock out a store manager already
    // using the portal.
    const { data: existing, error: ee } = await sb
      .from('stops').select('id, name, store_pin_hash, active')
      .eq('id', stopId).single();
    if (ee || !existing) return res.status(404).json({ error: 'stop not found' });
    if (!existing.active) return res.status(400).json({ error: 'stop is not active' });
    if (existing.store_pin_hash && !force) {
      return res.status(409).json({ error: 'stop already has portal access — pass force=true to overwrite' });
    }

    // Hash the PIN via the Postgres helper (bcrypt, pgcrypto).
    const { data: hashed, error: he } = await sb.rpc('hash_pin', { p_pin: pin });
    if (he) throw he;

    const patch = {
      store_pin_hash:     hashed,
      pin_rotated:        false,
      manager_first_name: first || null,
      manager_last_name:  last  || null,
      manager_email:      email || null,
      manager_phone:      phone || null,
    };
    const { data, error } = await sb.from('stops').update(patch).eq('id', stopId).select().single();
    if (error) throw error;

    return res.status(200).json({ ok: true, stop: data });
  } catch (err) {
    console.error('portal-invite POST:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── routes ──────────────────────────────────────────────────────
// GET  /api/schedule?resource=routes  — list routes with primary_driver
// PATCH /api/schedule?resource=routes&key=<FSQ|LYN|FBW>  { primary_driver_id }
// Operator-only. The primary driver per route auto-fills the driver card
// in the per-store print bundle.
async function handleRoutesGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  try {
    const sb = supabase();
    const { data, error } = await sb
      .from('routes').select('key,label,display_order,primary_driver_id')
      .order('display_order');
    if (error) throw error;
    // Hydrate driver name alongside.
    const ids = (data || []).map(r => r.primary_driver_id).filter(Boolean);
    let peopleById = {};
    if (ids.length) {
      const { data: pp, error: pe } = await sb.from('people').select('id,name').in('id', ids);
      if (pe) throw pe;
      peopleById = Object.fromEntries((pp || []).map(p => [p.id, p]));
    }
    const routes = (data || []).map(r => ({
      key: r.key, label: r.label, display_order: r.display_order,
      primary_driver_id: r.primary_driver_id,
      primary_driver_name: r.primary_driver_id ? (peopleById[r.primary_driver_id] || {}).name || null : null,
    }));
    return res.status(200).json({ routes });
  } catch (err) {
    console.error('routes GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleRoutesPatch(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const key = typeof (req.query && req.query.key) === 'string' ? req.query.key.trim().toUpperCase() : '';
  if (!key) return res.status(400).json({ error: 'route key required' });
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const driverId = body.primary_driver_id;
  const patch = {};
  // null explicitly clears; a uuid-looking string sets; undefined is ignored.
  if (driverId === null || driverId === '') patch.primary_driver_id = null;
  else if (typeof driverId === 'string') patch.primary_driver_id = driverId;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
  try {
    const sb = supabase();
    const { data, error } = await sb.from('routes').update(patch).eq('key', key).select().single();
    if (error) throw error;
    return res.status(200).json({ ok: true, route: data });
  } catch (err) {
    console.error('routes PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── driver-stats ────────────────────────────────────────────────
// GET /api/schedule?resource=driver-stats&id=<people.id>
// Operator-only. Reads lifetime stats from the `returns` table.
// Used by the per-store print bundle to personalize the driver card.
async function handleDriverStatsGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const sb = supabase();
    // Pull every returns row this person has submitted. For your volume
    // (dozens of stops × hundreds of days) this is tiny — no need to
    // pre-aggregate server-side yet.
    const { data, error } = await sb
      .from('returns').select('for_date,sold_singles,sold_doubles,singles_back,doubles_back')
      .eq('submitted_by', id);
    if (error) throw error;
    const rows = data || [];
    let pretzels = 0, firstDate = null;
    const days = new Set();
    for (const r of rows) {
      pretzels += (r.sold_singles || 0) + (r.sold_doubles || 0);
      if (r.for_date && (!firstDate || r.for_date < firstDate)) firstDate = r.for_date;
      if (r.for_date) days.add(r.for_date);
    }
    let tenure_days = 0, tenure_years = 0;
    if (firstDate) {
      const ms = Date.now() - new Date(firstDate + 'T00:00:00Z').getTime();
      tenure_days = Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
      tenure_years = +(tenure_days / 365).toFixed(1);
    }
    return res.status(200).json({
      stats: {
        pretzels_delivered: pretzels,
        delivery_days: days.size,
        first_delivery: firstDate,
        tenure_days,
        tenure_years,
      }
    });
  } catch (err) {
    console.error('driver-stats GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── payment flow helpers ─────────────────────────────────────────
const VARIANCE_WEEKS = 8;

function toIso(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function startOfWeekMon(d) {
  const r = new Date(d); r.setHours(0,0,0,0);
  const offset = (r.getDay() + 6) % 7;
  r.setDate(r.getDate() - offset);
  return r;
}

// Compute an invoice total from a stop's `returns` rows in a date range.
// Reads sold_singles/sold_doubles (actuals, not drop size). Returns null
// when there's nothing to bill (0 units); callers should skip.
async function aggregateReturns(sb, stopId, periodStart, periodEnd) {
  const { data, error } = await sb.from('returns')
    .select('for_date,sold_singles,sold_doubles')
    .eq('stop_id', stopId)
    .gte('for_date', toIso(periodStart))
    .lte('for_date', toIso(periodEnd));
  if (error) throw error;
  let singles = 0, doubles = 0;
  for (const r of data || []) {
    if (r.sold_singles != null) singles += r.sold_singles;
    if (r.sold_doubles != null) doubles += r.sold_doubles;
  }
  if (singles + doubles === 0) return null;
  const singleP = singlePriceCents();
  const doubleP = doublePriceCents();
  return {
    singles_count: singles,
    doubles_count: doubles,
    singles_cents: singles * singleP,
    doubles_cents: doubles * doubleP,
    total_cents:   singles * singleP + doubles * doubleP,
  };
}

async function trailingWeeklyAverageCents(sb, stopId, beforeDate) {
  const windowStart = new Date(beforeDate);
  windowStart.setDate(windowStart.getDate() - 7 * VARIANCE_WEEKS);
  const { data, error } = await sb.from('invoices')
    .select('total_cents,cadence,period_end')
    .eq('stop_id', stopId)
    .in('status', ['paid','approved','processing'])
    .gte('period_end', toIso(windowStart))
    .lte('period_end', toIso(beforeDate));
  if (error) return null;
  if (!data || !data.length) return null;
  let sum = 0, n = 0;
  for (const inv of data) {
    const weekly = inv.cadence === 'monthly' ? inv.total_cents / 4.33 : inv.total_cents;
    sum += weekly; n += 1;
  }
  return n ? sum / n : null;
}

function variancePctForDraft(totalCents, avgWeeklyCents, cadence) {
  if (avgWeeklyCents == null || avgWeeklyCents <= 0) return null;
  const normalized = cadence === 'monthly' ? totalCents / 4.33 : totalCents;
  return (normalized - avgWeeklyCents) / avgWeeklyCents;
}

function varianceThresholdPct() {
  const n = parseFloat(process.env.VARIANCE_FLAG_PCT || '');
  return Number.isFinite(n) && n > 0 ? n / 100 : 0.25;
}

async function logInvoiceEvent(sb, invoiceId, fromStatus, toStatus, actor, source, note) {
  try {
    await sb.from('invoice_events').insert({
      invoice_id: invoiceId,
      from_status: fromStatus,
      to_status: toStatus,
      actor, source: source || null, note: note || null,
    });
  } catch (e) { console.error('invoice_events insert:', e.message || e); }
}

// ─── PATCH stop-payment-settings ──────────────────────────────────
async function handleStopPaymentSettingsPatch(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const patch = {};
  if ('payment_mode' in body) {
    if (!['cash','electronic'].includes(body.payment_mode)) return res.status(400).json({ error: 'payment_mode must be cash|electronic' });
    patch.payment_mode = body.payment_mode;
  }
  if ('billing_cadence' in body) {
    if (body.billing_cadence !== null && !['weekly','monthly'].includes(body.billing_cadence)) {
      return res.status(400).json({ error: 'billing_cadence must be weekly|monthly|null' });
    }
    patch.billing_cadence = body.billing_cadence;
  }
  if ('payment_notes' in body) {
    patch.payment_notes = typeof body.payment_notes === 'string' ? body.payment_notes.trim().slice(0, 1000) || null : null;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no patchable fields' });
  try {
    const sb = supabase();
    const { data: before, error: be } = await sb.from('stops').select('id,name,town,store_display_name,manager_email,stripe_customer_id,payment_mode,billing_cadence').eq('id', id).single();
    if (be || !before) return res.status(404).json({ error: 'stop not found' });
    const nextMode    = 'payment_mode'    in patch ? patch.payment_mode    : before.payment_mode;
    const nextCadence = 'billing_cadence' in patch ? patch.billing_cadence : before.billing_cadence;
    if (nextMode === 'electronic' && !nextCadence) {
      return res.status(400).json({ error: 'billing_cadence required when payment_mode=electronic' });
    }
    if (nextMode === 'electronic' && !before.stripe_customer_id) {
      try {
        const cust = await stripeApi('POST', '/customers', {
          body: {
            name:  before.store_display_name || `${before.name} — ${before.town}`,
            email: before.manager_email || undefined,
            metadata: { stop_id: before.id },
          },
          idempotencyKey: `customer-stop-${before.id}`,
        });
        patch.stripe_customer_id = cust.id;
      } catch (e) {
        console.error('stripe customer create:', e.stripe || e.message || e);
        return res.status(502).json({ error: 'stripe customer create failed', detail: e.message });
      }
    }
    const { data, error } = await sb.from('stops').update(patch).eq('id', id).select('id,payment_mode,billing_cadence,stripe_customer_id,stripe_pm_id,bank_last4,plaid_connected_at,payment_notes').single();
    if (error) throw error;
    return res.status(200).json({ ok: true, stop: data });
  } catch (err) {
    console.error('stop-payment-settings PATCH:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── GET pending-invoices ─────────────────────────────────────────
async function handlePendingInvoicesGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  try {
    const sb = supabase();
    const { data: invs, error } = await sb
      .from('invoices')
      .select('id,stop_id,period_start,period_end,cadence,singles_count,doubles_count,singles_cents,doubles_cents,total_cents,status,stripe_invoice_id,stripe_payment_intent,created_at,approved_at,pulled_at,failed_at,failure_code,failure_message,stops:stop_id(name,town,route_key,store_display_name,billing_cadence,stripe_customer_id,stripe_pm_id,bank_last4)')
      .in('status', ['draft','approved','processing','failed'])
      .order('created_at', { ascending: false });
    if (error) throw error;

    const threshold = varianceThresholdPct();
    const uniqueStops = Array.from(new Set((invs || []).filter(r => r.status === 'draft').map(r => r.stop_id)));
    const avgByStop = {};
    await Promise.all(uniqueStops.map(async (stopId) => {
      const draft = (invs || []).find(r => r.stop_id === stopId && r.status === 'draft');
      if (!draft) return;
      avgByStop[stopId] = await trailingWeeklyAverageCents(sb, stopId, new Date(draft.period_end + 'T12:00:00'));
    }));

    const rows = (invs || []).map(r => {
      const label = r.stops?.store_display_name || `${r.stops?.name || '?'} — ${r.stops?.town || ''}`;
      const connected = !!r.stops?.stripe_pm_id;
      let varianceFlag = null;
      if (r.status === 'draft' && avgByStop[r.stop_id] != null) {
        const pct = variancePctForDraft(r.total_cents, avgByStop[r.stop_id], r.cadence);
        if (pct != null && Math.abs(pct) > threshold) {
          varianceFlag = {
            pct: Math.round(pct * 100),
            avg_cents: Math.round(avgByStop[r.stop_id]),
            threshold_pct: Math.round(threshold * 100),
          };
        }
      }
      return {
        id: r.id, stop_id: r.stop_id, stop_label: label,
        route_key: r.stops?.route_key || null,
        bank_last4: r.stops?.bank_last4 || null,
        has_payment_method: connected,
        period_start: r.period_start, period_end: r.period_end,
        cadence: r.cadence,
        singles_count: r.singles_count, doubles_count: r.doubles_count,
        singles_cents: r.singles_cents, doubles_cents: r.doubles_cents,
        total_cents: r.total_cents,
        status: r.status,
        stripe_invoice_id: r.stripe_invoice_id,
        stripe_payment_intent: r.stripe_payment_intent,
        created_at: r.created_at,
        approved_at: r.approved_at, pulled_at: r.pulled_at, failed_at: r.failed_at,
        failure_code: r.failure_code, failure_message: r.failure_message,
        variance_flag: varianceFlag,
      };
    });

    const kpi = {
      drafts:      rows.filter(r => r.status === 'draft').length,
      approved:    rows.filter(r => r.status === 'approved').length,
      processing:  rows.filter(r => r.status === 'processing').length,
      failed:      rows.filter(r => r.status === 'failed').length,
      drafts_cents:    rows.filter(r => r.status === 'draft').reduce((s, r) => s + r.total_cents, 0),
      in_flight_cents: rows.filter(r => r.status === 'processing' || r.status === 'approved').reduce((s, r) => s + r.total_cents, 0),
      failed_cents:    rows.filter(r => r.status === 'failed').reduce((s, r) => s + r.total_cents, 0),
    };
    return res.status(200).json({ rows, kpi, variance_threshold_pct: Math.round(threshold * 100) });
  } catch (err) {
    console.error('pending-invoices GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── POST approve-invoice ─────────────────────────────────────────
async function handleApproveInvoice(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const single = typeof body.invoice_id === 'string' ? body.invoice_id : null;
  const batch  = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string') : null;
  const ids = batch && batch.length ? batch : (single ? [single] : []);
  if (!ids.length) return res.status(400).json({ error: 'invoice_id or ids[] required' });
  if (ids.length > 100) return res.status(400).json({ error: 'batch too large (max 100)' });

  const results = [];
  const sb = supabase();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try { results.push(await approveOne(sb, id, sess.sub)); }
    catch (e) { results.push({ id, ok: false, error: e.message || String(e) }); }
    // Rate-limit: ≤10/sec (spec §Rate limiting).
    if (i < ids.length - 1) await new Promise(r => setTimeout(r, 100));
  }
  const ok = results.filter(r => r.ok).length;
  return res.status(200).json({ ok: ok === results.length, approved: ok, failed: results.length - ok, results });
}

async function approveOne(sb, invoiceId, operatorId) {
  const { data: inv, error } = await sb.from('invoices')
    .select('*,stops:stop_id(id,stripe_customer_id,stripe_pm_id,store_display_name,name,town)')
    .eq('id', invoiceId).single();
  if (error || !inv) throw new Error('invoice not found');
  if (inv.status === 'approved' || inv.status === 'processing' || inv.status === 'paid') {
    return { id: invoiceId, ok: true, skipped: `already ${inv.status}` };
  }
  if (inv.status === 'void') return { id: invoiceId, ok: false, error: 'cannot approve a voided invoice' };
  const stop = inv.stops;
  if (!stop || !stop.stripe_customer_id || !stop.stripe_pm_id) {
    const now = new Date().toISOString();
    await sb.from('invoices').update({
      status: 'failed', failed_at: now,
      failure_code: 'no_payment_method',
      failure_message: 'Stop has no connected bank — ask manager to use Connect Bank.',
    }).eq('id', invoiceId);
    await logInvoiceEvent(sb, invoiceId, inv.status, 'failed', `operator:${operatorId || 'system'}`, null, 'no_payment_method');
    return { id: invoiceId, ok: false, error: 'no payment method' };
  }

  const idemBase = `invoice-${inv.id}`;
  const sInv = await stripeApi('POST', '/invoices', {
    body: {
      customer: stop.stripe_customer_id,
      default_payment_method: stop.stripe_pm_id,
      collection_method: 'charge_automatically',
      auto_advance: true,
      metadata: {
        local_invoice_id: inv.id,
        stop_id: stop.id,
        period_start: inv.period_start,
        period_end: inv.period_end,
      },
      description: `Pretzel Cup — ${inv.cadence} period ${inv.period_start} to ${inv.period_end}`,
    },
    idempotencyKey: `${idemBase}-create`,
  });
  if (inv.singles_count > 0) {
    await stripeApi('POST', '/invoiceitems', {
      body: {
        customer: stop.stripe_customer_id, invoice: sInv.id,
        quantity: inv.singles_count, unit_amount: singlePriceCents(),
        currency: 'usd', description: `Soft pretzel (single) × ${inv.singles_count}`,
      },
      idempotencyKey: `${idemBase}-item-singles`,
    });
  }
  if (inv.doubles_count > 0) {
    await stripeApi('POST', '/invoiceitems', {
      body: {
        customer: stop.stripe_customer_id, invoice: sInv.id,
        quantity: inv.doubles_count, unit_amount: doublePriceCents(),
        currency: 'usd', description: `Soft pretzel (double) × ${inv.doubles_count}`,
      },
      idempotencyKey: `${idemBase}-item-doubles`,
    });
  }
  const finalized = await stripeApi('POST', `/invoices/${sInv.id}/finalize`, {
    body: { auto_advance: true },
    idempotencyKey: `${idemBase}-finalize`,
  });

  const now = new Date().toISOString();
  const { data: updated, error: ue } = await sb.from('invoices').update({
    status: 'approved',
    approved_at: now, approved_by: operatorId,
    stripe_invoice_id: finalized.id,
  }).eq('id', inv.id).select('id,status').single();
  if (ue) throw ue;
  await logInvoiceEvent(sb, inv.id, inv.status, 'approved', `operator:${operatorId || 'system'}`, finalized.id);
  return { id: inv.id, ok: true, status: updated.status, stripe_invoice_id: finalized.id };
}

// ─── POST void-invoice ────────────────────────────────────────────
async function handleVoidInvoice(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const id = typeof body.invoice_id === 'string' ? body.invoice_id : '';
  if (!id) return res.status(400).json({ error: 'invoice_id required' });
  try {
    const sb = supabase();
    const { data: inv, error } = await sb.from('invoices').select('id,status,stripe_invoice_id').eq('id', id).single();
    if (error || !inv) return res.status(404).json({ error: 'invoice not found' });
    if (inv.status === 'paid') return res.status(400).json({ error: 'already paid — issue a refund in Stripe instead' });
    if (inv.stripe_invoice_id) {
      try {
        await stripeApi('POST', `/invoices/${inv.stripe_invoice_id}/void`, {
          idempotencyKey: `invoice-${inv.id}-void`,
        });
      } catch (e) { console.error('stripe void:', e.stripe || e.message || e); }
    }
    const now = new Date().toISOString();
    await sb.from('invoices').update({ status: 'void', voided_at: now }).eq('id', inv.id);
    await logInvoiceEvent(sb, inv.id, inv.status, 'void', `operator:${sess.sub}`, inv.stripe_invoice_id || null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('void-invoice:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── POST retry-invoice ───────────────────────────────────────────
async function handleRetryInvoice(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const id = typeof body.invoice_id === 'string' ? body.invoice_id : '';
  if (!id) return res.status(400).json({ error: 'invoice_id required' });
  try {
    const sb = supabase();
    const { data: inv, error } = await sb.from('invoices').select('id,status,stripe_invoice_id,failure_code').eq('id', id).single();
    if (error || !inv) return res.status(404).json({ error: 'invoice not found' });
    if (inv.status !== 'failed') return res.status(400).json({ error: 'only failed invoices can be retried' });
    if (!inv.stripe_invoice_id)  return res.status(400).json({ error: 'invoice has no Stripe id — approve first' });
    const unretriable = ['account_closed','no_account','R02','R03','debit_not_authorized','R07','R10','R29'];
    if (inv.failure_code && unretriable.includes(inv.failure_code)) {
      return res.status(400).json({ error: `failure code ${inv.failure_code} is not retriable — manager must reconnect bank` });
    }
    await stripeApi('POST', `/invoices/${inv.stripe_invoice_id}/pay`, {
      body: {},
      idempotencyKey: `invoice-${inv.id}-retry-${Date.now()}`,
    });
    const now = new Date().toISOString();
    await sb.from('invoices').update({ status: 'processing', pulled_at: now, failure_code: null, failure_message: null }).eq('id', inv.id);
    await logInvoiceEvent(sb, inv.id, inv.status, 'processing', `operator:${sess.sub}`, inv.stripe_invoice_id, 'retry');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('retry-invoice:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: err.message || 'server error' });
  }
}

// ─── POST mark-paid (manual, off-Stripe payment) ──────────────────
async function handleMarkPaid(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const body = (typeof req.body === 'object' && req.body) || (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const id = typeof body.invoice_id === 'string' ? body.invoice_id : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
  if (!id) return res.status(400).json({ error: 'invoice_id required' });
  try {
    const sb = supabase();
    const { data: inv, error } = await sb.from('invoices').select('id,status').eq('id', id).single();
    if (error || !inv) return res.status(404).json({ error: 'invoice not found' });
    if (inv.status === 'paid') return res.status(400).json({ error: 'already paid' });
    const now = new Date().toISOString();
    await sb.from('invoices').update({ status: 'paid', paid_at: now }).eq('id', inv.id);
    await logInvoiceEvent(sb, inv.id, inv.status, 'paid', `operator:${sess.sub}`, null, note || 'manual mark-paid');
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('mark-paid:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── GET generate-drafts (Vercel Cron, bearer CRON_SECRET) ────────
async function handleGenerateDrafts(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET missing' });
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (provided !== cronSecret) return res.status(401).json({ error: 'unauthorized' });

  try {
    const sb = supabase();
    const today = new Date();
    const results = { weekly: [], monthly: [], auto_approve: null };

    // Weekly: previous Mon…Sun relative to today.
    const lastSun = startOfWeekMon(today); lastSun.setDate(lastSun.getDate() - 1);
    const lastMon = startOfWeekMon(lastSun);
    results.weekly = await generateForCadence(sb, 'weekly', lastMon, lastSun);

    // Monthly: on the 1st, run the previous month.
    if (today.getDate() === 1) {
      const firstThis = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastPrev  = new Date(firstThis.getFullYear(), firstThis.getMonth(), 0);
      const firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1);
      results.monthly = await generateForCadence(sb, 'monthly', firstPrev, lastPrev);
    }

    // Auto-approve pass if armed (defaults off — spec §Flow 4).
    if (process.env.AUTO_APPROVE_ENABLED === '1') {
      const dow = today.getDay();
      if (dow === 3)                 results.auto_approve = await autoApprovePass(sb, 'weekly');
      if (today.getDate() === 5)     results.auto_approve = await autoApprovePass(sb, 'monthly');
    }

    return res.status(200).json({ ok: true, ...results });
  } catch (err) {
    console.error('generate-drafts:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: err.message || 'server error' });
  }
}

async function generateForCadence(sb, cadence, periodStart, periodEnd) {
  const { data: stops, error } = await sb.from('stops')
    .select('id,name,town,store_display_name,route_key')
    .eq('active', true)
    .eq('payment_mode', 'electronic')
    .eq('billing_cadence', cadence);
  if (error) throw error;
  const out = [];
  const ps = toIso(periodStart), pe = toIso(periodEnd);
  for (const stop of stops || []) {
    const agg = await aggregateReturns(sb, stop.id, periodStart, periodEnd);
    if (!agg) { out.push({ stop_id: stop.id, skipped: 'zero_units' }); continue; }
    // Idempotent: only refresh totals if the row is still a draft. If it's
    // been approved / paid / voided we leave it alone — the cron can run
    // daily without clobbering operator decisions.
    const { data: existing } = await sb.from('invoices')
      .select('id,status')
      .eq('stop_id', stop.id).eq('period_start', ps).eq('period_end', pe)
      .maybeSingle();
    if (existing && existing.status !== 'draft') {
      out.push({ stop_id: stop.id, skipped: `already_${existing.status}` });
      continue;
    }
    const row = {
      stop_id: stop.id, period_start: ps, period_end: pe, cadence,
      singles_count: agg.singles_count, doubles_count: agg.doubles_count,
      singles_cents: agg.singles_cents, doubles_cents: agg.doubles_cents,
      total_cents:   agg.total_cents,
      status: 'draft',
    };
    if (existing) {
      const { error: ue } = await sb.from('invoices').update(row).eq('id', existing.id);
      if (ue) { out.push({ stop_id: stop.id, error: ue.message }); continue; }
      out.push({ stop_id: stop.id, invoice_id: existing.id, total_cents: agg.total_cents, refreshed: true });
    } else {
      const { data, error: ue } = await sb.from('invoices').insert(row).select('id').single();
      if (ue) { out.push({ stop_id: stop.id, error: ue.message }); continue; }
      out.push({ stop_id: stop.id, invoice_id: data.id, total_cents: agg.total_cents, created: true });
      await logInvoiceEvent(sb, data.id, null, 'draft', 'system:cron', `generate-${cadence}-${pe}`);
    }
  }
  return out;
}

async function autoApprovePass(sb, cadence) {
  const { data: drafts } = await sb.from('invoices')
    .select('id,stop_id,total_cents,cadence,period_end,stops:stop_id(stripe_customer_id,stripe_pm_id)')
    .eq('status', 'draft').eq('cadence', cadence);
  const results = [];
  if (!drafts || !drafts.length) return results;
  const threshold = varianceThresholdPct();
  for (const d of drafts) {
    if (!d.stops?.stripe_customer_id || !d.stops?.stripe_pm_id) { results.push({ id: d.id, skipped: 'no_pm' }); continue; }
    const avg = await trailingWeeklyAverageCents(sb, d.stop_id, new Date(d.period_end + 'T12:00:00'));
    if (avg != null) {
      const pct = variancePctForDraft(d.total_cents, avg, d.cadence);
      if (pct != null && Math.abs(pct) > threshold) { results.push({ id: d.id, skipped: 'variance' }); continue; }
    }
    try { results.push(await approveOne(sb, d.id, null)); }
    catch (e) { results.push({ id: d.id, ok: false, error: e.message || String(e) }); }
    await new Promise(r => setTimeout(r, 100));
  }
  return results;
}

// ─── GET reconciliation (CSV) ─────────────────────────────────────
async function handleReconciliation(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  const q = req.query || {};
  const month = typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : null;
  if (!month) return res.status(400).json({ error: 'month=YYYY-MM required' });
  const [yy, mm] = month.split('-').map(n => parseInt(n, 10));
  const start = toIso(new Date(yy, mm - 1, 1));
  const end   = toIso(new Date(yy, mm,     0));
  try {
    const sb = supabase();
    const { data, error } = await sb.from('invoices')
      .select('id,period_start,period_end,total_cents,status,paid_at,stripe_invoice_id,stripe_payment_intent,stops:stop_id(store_display_name,name,town)')
      .gte('period_end', start).lte('period_end', end)
      .order('period_end');
    if (error) throw error;
    const header = ['invoice_id','stop_name','period_start','period_end','total_cents','status','paid_at','stripe_invoice_id','stripe_payment_intent'];
    const csvEsc = v => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = (data || []).map(r => [
      r.id,
      r.stops?.store_display_name || `${r.stops?.name || ''} — ${r.stops?.town || ''}`,
      r.period_start, r.period_end, r.total_cents, r.status,
      r.paid_at || '', r.stripe_invoice_id || '', r.stripe_payment_intent || '',
    ].map(csvEsc).join(','));
    const csv = [header.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reconciliation-${month}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('reconciliation:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── REVENUE ─────────────────────────────────────────────────────────
// Gross retail revenue: what drivers rang up at per-stop pricing.
// Falls back to the global $2.15 / $3.85 if a stop has no per-stop override.
async function handleRevenueGet(req, res, sess) {
  if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
  try {
    const sb = supabase();
    const windowKey = typeof req.query.window === 'string' ? req.query.window : 'week';
    const customFrom = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
    const customTo   = typeof req.query.to   === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : null;

    // All date math in America/New_York so a 9pm submission counts for today
    // even when the Vercel node is on UTC.
    const nyNow = () => {
      const s = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
      const d = new Date(s);
      return d;
    };
    const iso = d => {
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${day}`;
    };
    const now = nyNow();
    const todayIso = iso(now);

    let fromIso, toIso = todayIso, label;
    if (windowKey === 'custom' && customFrom && customTo) {
      fromIso = customFrom; toIso = customTo; label = `${customFrom} to ${customTo}`;
    } else if (windowKey === '30d') {
      const d = new Date(now); d.setDate(d.getDate() - 29);
      fromIso = iso(d); label = 'Last 30 days';
    } else if (windowKey === 'quarter') {
      const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
      fromIso = iso(new Date(now.getFullYear(), qStartMonth, 1));
      label = 'Quarter-to-date';
    } else if (windowKey === 'ytd') {
      fromIso = iso(new Date(now.getFullYear(), 0, 1));
      label = 'Year-to-date';
    } else { // week — Monday through today
      const d = new Date(now); const dow = d.getDay();
      const back = dow === 0 ? 6 : dow - 1; // Monday = 0 back
      d.setDate(d.getDate() - back);
      fromIso = iso(d); label = 'This week';
    }

    // Always compute a 30-day daily series for the sparkline, regardless of
    // the selected window.
    const sparkFrom = (() => { const d = new Date(now); d.setDate(d.getDate() - 29); return iso(d); })();
    const minFrom = fromIso < sparkFrom ? fromIso : sparkFrom;

    const [returnsR, stopsR, peopleR] = await Promise.all([
      sb.from('returns').select('for_date,route_key,stop_id,sold_singles,sold_doubles,sold_cents,submitted_by,submitted_at').gte('for_date', minFrom).lte('for_date', toIso),
      sb.from('stops').select('id,name,route_key,shorts,price_single_cents,price_double_cents').order('route_key').order('stop_order'),
      sb.from('people').select('id,name,role'),
    ]);
    if (returnsR.error) throw returnsR.error;
    if (stopsR.error) throw stopsR.error;
    if (peopleR.error) throw peopleR.error;

    const stopById = Object.create(null);
    stopsR.data.forEach(s => { stopById[s.id] = s; });
    const nameBySub = Object.create(null);
    peopleR.data.forEach(p => { nameBySub[p.id] = p.name; });

    // Filter to the selected window (we fetched a superset to also feed the
    // 30-day sparkline).
    const inWindow = returnsR.data.filter(r => r.for_date >= fromIso && r.for_date <= toIso);

    const summary = { total_cents: 0, total_units: 0, total_singles: 0, total_doubles: 0, total_shorts_units: 0, submissions: 0, days_covered: 0 };
    const daySet = new Set();
    const byRoute = Object.create(null);
    const byDriver = Object.create(null);
    const byStop = Object.create(null);

    for (const r of inWindow) {
      const s = r.sold_singles || 0, d = r.sold_doubles || 0, c = r.sold_cents || 0;
      summary.total_cents   += c;
      summary.total_singles += s;
      summary.total_doubles += d;
      summary.total_units   += s + d;
      summary.submissions++;
      daySet.add(r.for_date);
      const stop = stopById[r.stop_id];
      if (stop && stop.shorts) summary.total_shorts_units += s + d;

      // Per-route
      const rk = r.route_key || (stop && stop.route_key) || '?';
      if (!byRoute[rk]) byRoute[rk] = { route_key: rk, singles: 0, doubles: 0, units: 0, shorts_units: 0, revenue_cents: 0, submissions: 0, stop_ids: new Set() };
      byRoute[rk].singles += s; byRoute[rk].doubles += d; byRoute[rk].units += s + d;
      byRoute[rk].revenue_cents += c; byRoute[rk].submissions++;
      if (stop && stop.shorts) byRoute[rk].shorts_units += s + d;
      byRoute[rk].stop_ids.add(r.stop_id);

      // Per-driver (operator submissions have a sub too)
      const sub = r.submitted_by || 'unknown';
      if (!byDriver[sub]) byDriver[sub] = { sub, name: nameBySub[sub] || 'Unknown', submissions: 0, singles: 0, doubles: 0, units: 0, revenue_cents: 0 };
      byDriver[sub].submissions++; byDriver[sub].singles += s; byDriver[sub].doubles += d;
      byDriver[sub].units += s + d; byDriver[sub].revenue_cents += c;

      // Per-stop
      const sid = r.stop_id;
      if (!byStop[sid]) byStop[sid] = { stop_id: sid, name: (stop && stop.name) || '?', route_key: rk, singles: 0, doubles: 0, units: 0, revenue_cents: 0, shorts: !!(stop && stop.shorts) };
      byStop[sid].singles += s; byStop[sid].doubles += d; byStop[sid].units += s + d; byStop[sid].revenue_cents += c;
    }
    summary.days_covered = daySet.size;

    // 30-day daily series (always, regardless of selected window).
    const dailyMap = Object.create(null);
    for (const r of returnsR.data) {
      if (r.for_date < sparkFrom) continue;
      if (!dailyMap[r.for_date]) dailyMap[r.for_date] = { for_date: r.for_date, revenue_cents: 0, units: 0 };
      dailyMap[r.for_date].revenue_cents += r.sold_cents || 0;
      dailyMap[r.for_date].units += (r.sold_singles || 0) + (r.sold_doubles || 0);
    }
    const daily = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const k = iso(d);
      daily.push(dailyMap[k] || { for_date: k, revenue_cents: 0, units: 0 });
    }

    // Finalize collections
    const byRouteArr = Object.values(byRoute).map(r => ({
      route_key: r.route_key, singles: r.singles, doubles: r.doubles, units: r.units,
      shorts_units: r.shorts_units, revenue_cents: r.revenue_cents, submissions: r.submissions,
      stops_submitted: r.stop_ids.size,
    })).sort((a, b) => b.revenue_cents - a.revenue_cents);

    const byDriverArr = Object.values(byDriver).sort((a, b) => b.revenue_cents - a.revenue_cents);
    const byStopArr   = Object.values(byStop).sort((a, b) => b.revenue_cents - a.revenue_cents);

    return res.status(200).json({
      window: { key: windowKey, label, from: fromIso, to: toIso },
      summary,
      by_route: byRouteArr,
      by_driver: byDriverArr,
      by_stop: byStopArr,
      daily, // last 30 days for sparkline
    });
  } catch (err) {
    console.error('revenue GET:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const resource = typeof (req.query && req.query.resource) === 'string' ? req.query.resource : '';

  // generate-drafts is cron-authed (bearer CRON_SECRET), NOT cookie-authed.
  if (resource === 'generate-drafts') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method not allowed' });
    }
    return handleGenerateDrafts(req, res);
  }

  if (resource === 'stop-payment-settings') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'PATCH') return handleStopPaymentSettingsPatch(req, res, sess);
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'pending-invoices') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET') return handlePendingInvoicesGet(req, res, sess);
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'approve-invoice') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'POST') return handleApproveInvoice(req, res, sess);
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'void-invoice') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'POST') return handleVoidInvoice(req, res, sess);
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'retry-invoice') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'POST') return handleRetryInvoice(req, res, sess);
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'mark-paid') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'POST') return handleMarkPaid(req, res, sess);
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'reconciliation') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET') return handleReconciliation(req, res, sess);
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'routes') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET')   return handleRoutesGet(req, res, sess);
    if (req.method === 'PATCH') return handleRoutesPatch(req, res, sess);
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'driver-stats') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET') return handleDriverStatsGet(req, res, sess);
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'portal-invite') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'POST') return handlePortalInvite(req, res, sess);
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'onboard-create') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'POST') return handleOnboardCreate(req, res, sess);
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'revenue') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET') return handleRevenueGet(req, res, sess);
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'stops') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET')   return handleStopsGet(req, res, sess);
    if (req.method === 'POST')  return handleStopsPost(req, res, sess);
    if (req.method === 'PATCH') return handleStopsPatch(req, res, sess);
    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'shifts') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET')    return handleShiftsGet(req, res, sess);
    if (req.method === 'POST')   return handleShiftsPost(req, res, sess);
    if (req.method === 'PATCH')  return handleShiftsPatch(req, res, sess);
    if (req.method === 'DELETE') return handleShiftsDelete(req, res, sess);
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'people') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET')   return handlePeopleGet(req, res, sess);
    if (req.method === 'PATCH') return handlePeoplePatch(req, res, sess);
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'store-issues') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET')   return handleStoreIssuesGet(req, res, sess);
    if (req.method === 'PATCH') return handleStoreIssuesPatch(req, res, sess);
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'store-requests') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'GET')   return handleStoreRequestsGet(req, res, sess);
    if (req.method === 'PATCH') return handleStoreRequestsPatch(req, res, sess);
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (resource === 'store-pins') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    if (req.method === 'PATCH') return handleStorePinsPatch(req, res, sess);
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'method not allowed' });
  }


  if (req.method !== 'GET') { res.setHeader('Allow','GET, PATCH'); return res.status(405).json({error:'method not allowed'}); }
  const sess = await requireRole(req, res, ['baker','driver','operator']);
  if (!sess) return;

  const weekOffset = Math.max(0, Math.min(1, parseInt((req.query && req.query.week) || '0', 10)));

  try {
    const sb = supabase();

    // Monday of the target week in local time. Postgres dates we compare
    // against are naive (YYYY-MM-DD), so matching naive local Mondays
    // keeps a Pacific-time Mike and a UTC server from seeing drift.
    const now = new Date();
    const monday = new Date(now);
    monday.setHours(0, 0, 0, 0);
    const dayOffset = (monday.getDay() + 6) % 7; // 0 if Mon, 6 if Sun
    monday.setDate(monday.getDate() - dayOffset + weekOffset * 7);

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday); d.setDate(d.getDate() + i);
      return d;
    });
    const iso = d => {
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${day}`;
    };
    const isoDays = days.map(iso);

    const [peopleR, shiftsR, offR] = await Promise.all([
      sb.from('people').select('id,name,role').order('role').order('name'),
      sb.from('shifts').select('id,person_id,role,location,route_key,days'),
      sb.from('time_off_requests').select('id,person_id,requested_date,status,cover_person_id,people:person_id(name),cover:cover_person_id(name)')
        .in('requested_date', isoDays)
        .in('status', ['pending','approved']),
    ]);
    if (peopleR.error) throw peopleR.error;
    if (shiftsR.error) throw shiftsR.error;
    if (offR.error)    throw offR.error;

    return res.status(200).json({
      weekOffset,
      days: days.map(d => ({ date: iso(d), dow: d.getDay(), weekday: DOW[d.getDay()] })),
      people: peopleR.data,
      shifts: shiftsR.data,
      timeOff: offR.data,
    });
  } catch (err) {
    console.error('schedule error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
