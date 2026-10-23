// GET /api/driver/today?route=…&date=YYYY-MM-DD
//   Returns the route sheet for the given date (default: yesterday,
//   matching the Google Form's "day before today" semantics — drivers
//   log yesterday's sales the next morning).
//
// Each stop ships: name, town, basket, note, drop size, sold_cents (if
// already logged). The driver types one dollar amount per stop; we do
// no conversion math. The sheet sync (P6) pushes sold_cents straight
// through as a dollar value.
const { supabase, requireRole } = require('../_lib/auth');

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'method not allowed'}); }
  const sess = await requireRole(req, res, ['driver','operator']);
  if (!sess) return;

  const askedRoute = typeof (req.query && req.query.route) === 'string' ? req.query.route : null;
  const askedDate  = typeof (req.query && req.query.date)  === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date : null;

  try {
    const sb = supabase();
    const toIso = d => {
      const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${day}`;
    };
    // Target date: ?date=YYYY-MM-DD overrides, else yesterday (matching the form).
    const target = new Date();
    if (!askedDate) target.setDate(target.getDate() - 1);
    const targetIso = askedDate || toIso(target);
    const targetDow = (askedDate ? new Date(askedDate + 'T12:00:00') : target).getDay();
    const isWeekend = targetDow === 0 || targetDow === 6;

    const [routesR, shiftsR] = await Promise.all([
      sb.from('routes').select('*').order('display_order'),
      sb.from('shifts').select('person_id,route_key,days,people(id,name)').contains('days', [targetDow]).not('route_key', 'is', null),
    ]);
    if (routesR.error) throw routesR.error;
    if (shiftsR.error) throw shiftsR.error;

    let selected = askedRoute ? routesR.data.find(r => r.key === askedRoute) : null;
    if (!selected && sess.role === 'driver') {
      // If date is today or tomorrow, prefer the driver's own route on that
      // day. If date is in the past (common case), fall back to the first
      // route — they may be looking back at anyone's data.
      const mine = shiftsR.data.find(s => s.person_id === sess.sub);
      if (mine) selected = routesR.data.find(r => r.key === mine.route_key);
    }
    if (!selected) selected = routesR.data[0];
    if (!selected) return res.status(500).json({ error: 'no routes configured' });

    const routeShifts = shiftsR.data.filter(s => s.route_key === selected.key);
    const scheduled  = routeShifts.map(s => s.people?.name).filter(Boolean);

    const [stopsR, returnsR] = await Promise.all([
      sb.from('stops').select('*').eq('route_key', selected.key).eq('active', true).order('stop_order'),
      sb.from('returns').select('*').eq('route_key', selected.key).eq('for_date', targetIso),
    ]);
    if (stopsR.error)   throw stopsR.error;
    if (returnsR.error) throw returnsR.error;

    const retByStop = Object.create(null);
    (returnsR.data || []).forEach(r => { retByStop[r.stop_id] = r; });

    const singlesFor = s => isWeekend && s.singles_drop_wknd != null ? s.singles_drop_wknd : s.singles_drop;
    const doublesFor = s => isWeekend && s.doubles_drop_wknd != null ? s.doubles_drop_wknd : s.doubles_drop;

    const stops = stopsR.data.map(s => {
      const r = retByStop[s.id];
      return {
        id: s.id,
        order: s.stop_order,
        name: s.name,
        town: s.town,
        address: s.address || null,
        basket: s.basket,
        note: s.note,
        shorts: !!s.shorts,
        drop_label: `${singlesFor(s)} / ${doublesFor(s)}`,
        singles_drop: singlesFor(s),
        doubles_drop: doublesFor(s),
        sold_singles: r && r.sold_singles != null ? r.sold_singles : null,
        sold_doubles: r && r.sold_doubles != null ? r.sold_doubles : null,
        sold_cents:   r && r.sold_cents   != null ? r.sold_cents   : null,
        logged_at:    r ? r.submitted_at : null,
      };
    });

    // Running total for anything already saved for this date/route.
    let total_cents = 0, logged = 0;
    stops.forEach(s => { if (s.sold_cents != null) { total_cents += s.sold_cents; logged++; } });

    // History: last 14 days of this driver's submissions, grouped by (date, route).
    // Carried on the today payload so we don't need a separate serverless function
    // (hobby plan caps us at 12). Operators see everything; drivers only their own.
    const since = new Date();
    since.setDate(since.getDate() - 14);
    const sinceIso = toIso(since);
    const histQuery = sb.from('returns')
      .select('for_date,route_key,sold_cents,submitted_at,submitted_by,people:submitted_by(name)')
      .gte('for_date', sinceIso)
      .order('for_date', { ascending: false });
    if (sess.role === 'driver') histQuery.eq('submitted_by', sess.sub);
    const { data: histRows, error: he } = await histQuery;
    if (he) throw he;

    const groups = Object.create(null);
    (histRows || []).forEach(r => {
      const key = `${r.for_date}|${r.route_key}|${r.submitted_by}`;
      let g = groups[key];
      if (!g) {
        g = groups[key] = {
          for_date: r.for_date,
          route_key: r.route_key,
          submitter: (r.people && r.people.name) || null,
          total_cents: 0,
          stop_count: 0,
          last_submitted_at: r.submitted_at,
        };
      }
      g.total_cents += r.sold_cents || 0;
      g.stop_count += 1;
      if (!g.last_submitted_at || new Date(r.submitted_at) > new Date(g.last_submitted_at)) {
        g.last_submitted_at = r.submitted_at;
      }
    });
    const routeLabelByKey = Object.create(null);
    routesR.data.forEach(r => { routeLabelByKey[r.key] = r.label; });
    const my_history = Object.values(groups)
      .map(g => Object.assign(g, { route_label: routeLabelByKey[g.route_key] || g.route_key }))
      .sort((a, b) => (a.for_date < b.for_date ? 1 : a.for_date > b.for_date ? -1 : a.route_key.localeCompare(b.route_key)));

    return res.status(200).json({
      for_date: targetIso,
      weekday: DOW[targetDow],
      is_weekend: isWeekend,
      route: { key: selected.key, label: selected.label },
      routes: routesR.data.map(r => ({ key: r.key, label: r.label })),
      scheduled,
      stops,
      totals: {
        logged_stops: logged,
        total_stops: stops.length,
        total_cents,
      },
      my_history,
    });
  } catch (err) {
    console.error('driver/today error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
