// /api/driver/submit — route submit (existing) + box-photo endpoints (new).
//
// Dispatch by ?action= :
//   route (default, POST)   — existing JSON submit; on photo days this also
//                              enforces that every active stop has a photo and
//                              posts the Drive folder link to Telegram once.
//   photo (POST)            — one box photo for one stop; JSON with base64
//                              `file` (client resizes to ~1200px JPEG first).
//                              Uploads to Drive, upserts route_photo_submissions.
//   photo-status (GET)      — current photos_count / stops_total / folder_link
//                              for (routeKey, forDate), so the UI can gate submit.
//
// Folded into a single serverless function to stay under Vercel Hobby's
// 12-function cap. The existing route-submit behavior is byte-for-byte
// identical outside the new photo-day gate + Telegram tail.

const { supabase, requireRole } = require('../_lib/auth');

// ─── pricing ───────────────────────────────────────────────────────
const PRICE_SINGLE_CENTS = 215;
const PRICE_DOUBLE_CENTS = 385;
const priceSingleFor = s => (s && s.price_single_cents != null) ? s.price_single_cents : PRICE_SINGLE_CENTS;
const priceDoubleFor = s => (s && s.price_double_cents != null) ? s.price_double_cents : PRICE_DOUBLE_CENTS;

// ─── bi-weekly photo days ──────────────────────────────────────────
// Anchor: Friday 2026-12-05. A day counts when it is ≥ anchor and the
// day-delta is a multiple of 14. Pure function; the driver HTML copies
// the same constants so the popup can show without a round-trip.
const PHOTO_ANCHOR_ISO = '2026-12-05';
const PHOTO_PERIOD_DAYS = 14;
function daysBetweenIso(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
function isPhotoDay(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = daysBetweenIso(PHOTO_ANCHOR_ISO, iso);
  return d >= 0 && d % PHOTO_PERIOD_DAYS === 0;
}

const WEEKDAY = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const toIso = d => {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
};
const parseBody = req => (typeof req.body === 'object' && req.body !== null)
  ? req.body
  : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

// ─── best-effort sheet writers ─────────────────────────────────────
async function pushToSheet(args) {
  try {
    const mod = require('../_lib/sheet');
    return await mod.appendRouteRow(args);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return { skipped: true, reason: 'sheet writer not configured yet' };
    throw e;
  }
}
async function appendBoxPhotoSheetRow(args) {
  try {
    const mod = require('../_lib/sheet');
    if (typeof mod.appendBoxPhotoRow !== 'function') return { skipped: true };
    return await mod.appendBoxPhotoRow(args);
  } catch (e) {
    console.error('box-photo sheet:', e && (e.message || e));
    return { error: (e && e.message) || String(e) };
  }
}

// ─── dispatcher ────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query && typeof req.query.action === 'string') ? req.query.action : '';

  if (req.method === 'GET') {
    if (action === 'photo-status') return handlePhotoStatus(req, res);
    res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' });
  }

  if (action === 'photo') return handlePhotoUpload(req, res);
  return handleRouteSubmit(req, res);
};

// Expose pure helpers for tests + the HTML (bundled by hand).
module.exports.__helpers = { isPhotoDay, PHOTO_ANCHOR_ISO, PHOTO_PERIOD_DAYS };

// Raise JSON body size cap so a ~400 KB base64 photo payload fits. The
// Vercel Node runtime honors this when present; ignored elsewhere.
module.exports.config = { api: { bodyParser: { sizeLimit: '5mb' } } };

// ─── route submit ──────────────────────────────────────────────────
async function handleRouteSubmit(req, res) {
  const sess = await requireRole(req, res, ['driver','operator']);
  if (!sess) return;

  const body = parseBody(req);
  const routeKey = typeof body.routeKey === 'string' ? body.routeKey : '';
  const forDate  = typeof body.forDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.forDate) ? body.forDate : null;
  const entries  = Array.isArray(body.entries) ? body.entries : [];

  if (!routeKey) return res.status(400).json({ error: 'routeKey required' });
  if (!entries.length) return res.status(400).json({ error: 'no entries' });

  let targetDate = forDate;
  if (!targetDate) { const y = new Date(); y.setDate(y.getDate() - 1); targetDate = toIso(y); }

  const inputs = [];
  for (const e of entries) {
    if (!e || typeof e.stopId !== 'string') return res.status(400).json({ error: 'bad entry: stopId required' });
    const s = Math.max(0, Math.round(Number(e.soldSingles) || 0));
    const d = Math.max(0, Math.round(Number(e.soldDoubles) || 0));
    inputs.push({ stopId: e.stopId, soldSingles: s, soldDoubles: d });
  }

  try {
    const sb = supabase();

    const stopIds = inputs.map(r => r.stopId);
    const { data: stops, error: se } = await sb
      .from('stops')
      .select('id,route_key,active,name,town,stop_order,singles_drop,doubles_drop,singles_drop_wknd,doubles_drop_wknd,price_single_cents,price_double_cents')
      .in('id', stopIds);
    if (se) throw se;
    const stopById = Object.create(null);
    stops.forEach(s => { stopById[s.id] = s; });

    const dow = new Date(targetDate + 'T12:00:00').getDay();
    const isWeekend = dow === 0 || dow === 6;
    const singlesFor = s => isWeekend && s.singles_drop_wknd != null ? s.singles_drop_wknd : s.singles_drop;
    const doublesFor = s => isWeekend && s.doubles_drop_wknd != null ? s.doubles_drop_wknd : s.doubles_drop;

    const rows = [];
    for (const r of inputs) {
      const s = stopById[r.stopId];
      if (!s)                       return res.status(404).json({ error: `stop not found: ${r.stopId}` });
      if (s.route_key !== routeKey) return res.status(400).json({ error: `stop ${s.name} not in route ${routeKey}` });
      if (!s.active)                return res.status(409).json({ error: `stop ${s.name} is inactive` });
      const maxS = singlesFor(s), maxD = doublesFor(s);
      if (r.soldSingles > maxS) return res.status(400).json({ error: `${s.name}: ${r.soldSingles} singles sold exceeds drop of ${maxS}` });
      if (r.soldDoubles > maxD) return res.status(400).json({ error: `${s.name}: ${r.soldDoubles} doubles sold exceeds drop of ${maxD}` });
      const psAtSubmit = priceSingleFor(s);
      const pdAtSubmit = priceDoubleFor(s);
      rows.push({
        for_date:     targetDate,
        route_key:    routeKey,
        stop_id:      r.stopId,
        sold_singles: r.soldSingles,
        sold_doubles: r.soldDoubles,
        sold_cents:   r.soldSingles * psAtSubmit + r.soldDoubles * pdAtSubmit,
        price_single_cents_at_submit: psAtSubmit,
        price_double_cents_at_submit: pdAtSubmit,
        submitted_by: sess.sub,
        submitted_at: new Date().toISOString(),
      });
    }

    // ─── Photo-day gate (fail BEFORE touching returns) ───────────
    // Driver must have uploaded one photo per active stop on the route
    // via ?action=photo before this submit can land.
    let photoRowId = null, photoCount = 0, stopsTotal = 0;
    if (isPhotoDay(targetDate)) {
      const { data: activeStops, error: as } = await sb
        .from('stops').select('id').eq('route_key', routeKey).eq('active', true);
      if (as) throw as;
      stopsTotal = activeStops.length;
      const { data: photoRow } = await sb
        .from('route_photo_submissions')
        .select('id,photos_count,telegram_message_id,drive_folder_link,drive_folder_id')
        .eq('for_date', targetDate).eq('route_key', routeKey).eq('driver_id', sess.sub)
        .maybeSingle();
      photoCount = photoRow ? photoRow.photos_count : 0;
      photoRowId = photoRow ? photoRow.id : null;
      if (photoCount < stopsTotal) {
        return res.status(409).json({
          error: 'box photos required',
          hint: 'Bi-weekly Friday: photograph every box before submitting the route.',
          photos_count: photoCount,
          stops_total: stopsTotal,
          missing_count: stopsTotal - photoCount,
        });
      }
    }

    // ─── Upsert returns ─────────────────────────────────────────
    const { error: ue } = await sb.from('returns').upsert(rows, { onConflict: 'for_date,stop_id' });
    if (ue) { console.error('submit upsert:', ue); return res.status(500).json({ error: 'server error' }); }

    const totals = rows.reduce((a, r) => ({
      singles: a.singles + r.sold_singles,
      doubles: a.doubles + r.sold_doubles,
      cents:   a.cents   + r.sold_cents,
    }), { singles: 0, doubles: 0, cents: 0 });

    // Full state for the sales-sheet row (so re-submits write a clean row).
    const { data: myAll, error: me } = await sb.from('returns')
      .select('stop_id, sold_singles, sold_doubles, sold_cents')
      .eq('for_date', targetDate).eq('route_key', routeKey).eq('submitted_by', sess.sub);
    if (me) throw me;
    const allStopIds = Array.from(new Set(myAll.map(r => r.stop_id)));
    let stopByIdAll = stopById;
    const missing = allStopIds.filter(id => !stopByIdAll[id]);
    if (missing.length) {
      const { data: more } = await sb.from('stops').select('id,name').in('id', missing);
      stopByIdAll = Object.assign({}, stopByIdAll);
      (more || []).forEach(s => { stopByIdAll[s.id] = s; });
    }

    let sheet_pushed = false, sheet_error = null, sheet_tabs = null;
    try {
      const sheet = await pushToSheet({
        supabase: sb, routeKey, forDate: targetDate,
        rows: myAll, stopById: stopByIdAll, driverName: sess.name,
      });
      if (sheet && sheet.ok) { sheet_pushed = true; sheet_tabs = sheet.tabs; }
      else if (sheet && sheet.skipped) sheet_error = sheet.reason;
      else if (sheet && sheet.error)   sheet_error = sheet.error;
    } catch (e) {
      sheet_error = (e && (e.message || String(e))) || 'sheet push failed';
      console.error('sheet push:', e);
    }

    // ─── Telegram post for box photos (exactly once per row) ────
    let telegram_posted = false, telegram_error = null;
    if (isPhotoDay(targetDate) && photoRowId) {
      try {
        const { data: fresh } = await sb.from('route_photo_submissions')
          .select('telegram_message_id,drive_folder_link').eq('id', photoRowId).maybeSingle();
        if (fresh && !fresh.telegram_message_id) {
          const routeRow = await sb.from('routes').select('label').eq('key', routeKey).maybeSingle();
          const routeLabel = (routeRow.data && routeRow.data.label) || routeKey;
          const d = new Date(targetDate + 'T12:00:00');
          const weekday = WEEKDAY[d.getDay()];
          const text = `📸 Bi-weekly box photos · ${routeLabel} · ${sess.name}\n${weekday}, ${targetDate}\n${photoCount} box${photoCount === 1 ? '' : 'es'} documented.\n\n${fresh.drive_folder_link}`;
          const { tgCall } = require('../_lib/telegram');
          const chat_id = process.env.TELEGRAM_CHAT_ID;
          if (!chat_id) throw new Error('TELEGRAM_CHAT_ID not set');
          const tgRes = await tgCall('sendMessage', { chat_id, text });
          await sb.from('route_photo_submissions')
            .update({ telegram_message_id: tgRes.message_id, updated_at: new Date().toISOString() })
            .eq('id', photoRowId);
          telegram_posted = true;

          // Companion sheet row (best-effort).
          await appendBoxPhotoSheetRow({
            forDate: targetDate,
            weekday, routeKey, routeLabel,
            driverName: sess.name,
            photosCount: photoCount,
            folderLink: fresh.drive_folder_link,
            submittedAt: new Date().toISOString(),
          });
        } else {
          telegram_posted = true;  // already sent; treat as success
        }
      } catch (e) {
        telegram_error = (e && (e.message || String(e))) || 'telegram failed';
        console.error('tg box photos:', e);
      }
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
      photo_day: isPhotoDay(targetDate),
      photos_count: photoCount,
      stops_total: stopsTotal,
      telegram_posted,
      telegram_error,
    });
  } catch (err) {
    console.error('driver/submit error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── photo upload ──────────────────────────────────────────────────
async function handlePhotoUpload(req, res) {
  const sess = await requireRole(req, res, ['driver','operator']);
  if (!sess) return;

  const body = parseBody(req);
  const stopId   = typeof body.stopId === 'string' ? body.stopId : '';
  const routeKey = typeof body.routeKey === 'string' ? body.routeKey : '';
  const forDate  = typeof body.forDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.forDate) ? body.forDate : null;
  const fileB64  = typeof body.file === 'string' ? body.file : '';
  const mimeType = typeof body.mimeType === 'string' && /^image\//.test(body.mimeType) ? body.mimeType : 'image/jpeg';

  if (!routeKey || !forDate || !stopId || !fileB64) {
    return res.status(400).json({ error: 'routeKey, forDate, stopId, file required' });
  }
  if (!isPhotoDay(forDate)) {
    return res.status(400).json({ error: 'not a photo day', anchor: PHOTO_ANCHOR_ISO, period_days: PHOTO_PERIOD_DAYS });
  }

  const stripped = fileB64.replace(/^data:[^;]+;base64,/, '');
  let buffer;
  try { buffer = Buffer.from(stripped, 'base64'); }
  catch { return res.status(400).json({ error: 'bad base64 file' }); }
  const MAX_BYTES = 4 * 1024 * 1024;  // 4 MB cap; client should resize first.
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({ error: 'file too large', max_bytes: MAX_BYTES, got: buffer.length });
  }
  if (buffer.length < 1024) {
    return res.status(400).json({ error: 'file too small (likely empty)' });
  }

  try {
    const sb = supabase();
    const { data: stop, error: se } = await sb
      .from('stops').select('id,route_key,active,name,stop_order')
      .eq('id', stopId).maybeSingle();
    if (se) throw se;
    if (!stop) return res.status(404).json({ error: 'stop not found' });
    if (stop.route_key !== routeKey) return res.status(400).json({ error: 'stop not in route' });
    if (!stop.active) return res.status(409).json({ error: 'stop inactive' });

    const { ensureRouteDriverFolder, uploadPhoto, classifyDriveError, sanitize } = require('../_lib/drive');
    let folder, file;
    try {
      folder = await ensureRouteDriverFolder({ routeKey, forDate, driverName: sess.name });
      const nn = String(stop.stop_order || 0).padStart(2, '0');
      const filename = `${nn}-${sanitize(stop.name)}.jpg`;
      file = await uploadPhoto({ folderId: folder.id, filename, buffer, mimeType });
    } catch (e) {
      const c = classifyDriveError(e);
      console.error('drive error:', c);
      return res.status(502).json({ error: 'drive upload failed', kind: c.kind, hint: c.hint });
    }

    // Upsert the per-(date, route, driver) row; count bumps only on create.
    const { data: existing } = await sb.from('route_photo_submissions')
      .select('id,photos_count').eq('for_date', forDate)
      .eq('route_key', routeKey).eq('driver_id', sess.sub).maybeSingle();

    let photoRow;
    if (existing) {
      const nextCount = existing.photos_count + (file.created ? 1 : 0);
      const { data: upd, error: uee } = await sb.from('route_photo_submissions')
        .update({
          photos_count: nextCount,
          drive_folder_id: folder.id,
          drive_folder_link: folder.webViewLink,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id,photos_count,drive_folder_link').single();
      if (uee) throw uee;
      photoRow = upd;
    } else {
      const { data: ins, error: ie } = await sb.from('route_photo_submissions')
        .insert({
          for_date: forDate, route_key: routeKey, driver_id: sess.sub,
          drive_folder_id: folder.id, drive_folder_link: folder.webViewLink,
          photos_count: file.created ? 1 : 0,
        })
        .select('id,photos_count,drive_folder_link').single();
      if (ie) throw ie;
      photoRow = ins;
    }

    const { data: activeStops } = await sb.from('stops').select('id').eq('route_key', routeKey).eq('active', true);
    const stopsTotal = (activeStops || []).length;

    return res.status(200).json({
      ok: true,
      created: !!file.created,
      stop_id: stopId,
      photos_count: photoRow.photos_count,
      stops_total: stopsTotal,
      folder_link: photoRow.drive_folder_link,
      file_link: file.webViewLink,
    });
  } catch (err) {
    console.error('photo upload error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// ─── photo status ─────────────────────────────────────────────────
async function handlePhotoStatus(req, res) {
  const sess = await requireRole(req, res, ['driver','operator']);
  if (!sess) return;

  const routeKey = typeof (req.query && req.query.routeKey) === 'string' ? req.query.routeKey : '';
  const forDate  = typeof (req.query && req.query.forDate)  === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.forDate)
    ? req.query.forDate : null;
  if (!routeKey || !forDate) return res.status(400).json({ error: 'routeKey and forDate required' });

  try {
    const required = isPhotoDay(forDate);
    const sb = supabase();
    const { data: activeStops, error: as } = await sb.from('stops').select('id').eq('route_key', routeKey).eq('active', true);
    if (as) throw as;
    const stopsTotal = activeStops.length;
    const { data: row } = await sb.from('route_photo_submissions')
      .select('photos_count,drive_folder_link,telegram_message_id')
      .eq('for_date', forDate).eq('route_key', routeKey).eq('driver_id', sess.sub)
      .maybeSingle();
    const photosCount = row ? row.photos_count : 0;
    return res.status(200).json({
      ok: true,
      required,
      anchor: PHOTO_ANCHOR_ISO,
      period_days: PHOTO_PERIOD_DAYS,
      photos_count: photosCount,
      stops_total: stopsTotal,
      folder_link: row ? row.drive_folder_link : null,
      telegram_posted: !!(row && row.telegram_message_id),
    });
  } catch (err) {
    console.error('photo-status error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}
