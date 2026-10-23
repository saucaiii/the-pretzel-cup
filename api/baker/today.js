// GET /api/baker/today — today's bake plan: total singles/doubles plus
// a per-route row (bakery → route → baker on → driver on → qty). This
// is wholesale only; retail counter counts are out of scope per the
// current spec. Weekend rows swap in singles_drop_wknd / doubles_drop_wknd
// where set (today only IVB uses that).
const { supabase, requireRole } = require('../_lib/auth');

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
// Which bakery bakes for which route — captured from Chris's answers in P0.
const BAKERY_FOR_ROUTE = { FSQ: 'Franklin Square bakery', LYN: 'Lynbrook bakery', FBW: 'Lynbrook bakery' };

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({error:'method not allowed'}); }
  const sess = await requireRole(req, res, ['baker','operator']);
  if (!sess) return;

  try {
    const sb = supabase();
    const today = new Date();
    const dow = today.getDay();
    const isWeekend = dow === 0 || dow === 6;

    const [routesR, stopsR, shiftsR] = await Promise.all([
      sb.from('routes').select('*').order('display_order'),
      sb.from('stops').select('*').eq('active', true),
      sb.from('shifts').select('*, people(name)').contains('days', [dow]),
    ]);
    if (routesR.error) throw routesR.error;
    if (stopsR.error)  throw stopsR.error;
    if (shiftsR.error) throw shiftsR.error;

    const singlesFor = s => isWeekend && s.singles_drop_wknd != null ? s.singles_drop_wknd : s.singles_drop;
    const doublesFor = s => isWeekend && s.doubles_drop_wknd != null ? s.doubles_drop_wknd : s.doubles_drop;

    const destinations = routesR.data.map(r => {
      const rstops = stopsR.data.filter(s => s.route_key === r.key);
      const singles = rstops.reduce((a, s) => a + singlesFor(s), 0);
      const doubles = rstops.reduce((a, s) => a + doublesFor(s), 0);
      // Split out the shorts batch for this route — same singles/doubles
      // units, just baked short. Baker needs to know how many to pull
      // short per bakery; drivers need to know which stops get them.
      const shortStops = rstops.filter(s => s.shorts);
      const shorts_singles = shortStops.reduce((a, s) => a + singlesFor(s), 0);
      const shorts_doubles = shortStops.reduce((a, s) => a + doublesFor(s), 0);
      const bakery  = BAKERY_FOR_ROUTE[r.key];
      const bakers  = shiftsR.data.filter(sh => sh.location === bakery).map(sh => sh.people?.name).filter(Boolean);
      const drivers = shiftsR.data.filter(sh => sh.route_key === r.key).map(sh => sh.people?.name).filter(Boolean);
      return {
        route_key: r.key,
        route_label: r.label,
        bakery,
        bakers,
        drivers,
        singles,
        doubles,
        shorts_singles,
        shorts_doubles,
        shorts_stops: shortStops.map(s => s.name),
        stop_count: rstops.length,
      };
    });

    const totals = destinations.reduce(
      (a, d) => ({
        singles: a.singles + d.singles,
        doubles: a.doubles + d.doubles,
        shorts_singles: a.shorts_singles + d.shorts_singles,
        shorts_doubles: a.shorts_doubles + d.shorts_doubles,
      }),
      { singles: 0, doubles: 0, shorts_singles: 0, shorts_doubles: 0 }
    );

    // Per-bakery shorts rollup — Lynbrook currently bakes every short.
    // If a future route gets shorts from Franklin Square, this picks it up
    // automatically from BAKERY_FOR_ROUTE without any further code change.
    const bakery_shorts = {};
    destinations.forEach(d => {
      if (!d.shorts_singles && !d.shorts_doubles) return;
      const b = d.bakery || 'Unassigned bakery';
      if (!bakery_shorts[b]) bakery_shorts[b] = { singles: 0, doubles: 0, routes: [] };
      bakery_shorts[b].singles += d.shorts_singles;
      bakery_shorts[b].doubles += d.shorts_doubles;
      bakery_shorts[b].routes.push(d.route_key);
    });

    return res.status(200).json({
      date: today.toISOString().slice(0, 10),
      weekday: DOW[dow],
      is_weekend: isWeekend,
      totals,
      destinations,
      bakery_shorts,
    });
  } catch (err) {
    console.error('baker/today error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
