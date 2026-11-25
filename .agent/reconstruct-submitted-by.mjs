// Reconstructs returns.submitted_by for rows where it is NULL, using the
// Daily Delivery Sales Report Google Sheet as the primary source and a
// Chris-bootstrap fallback.
//
//   node --env-file=.env .agent/reconstruct-submitted-by.mjs          # dry run
//   node --env-file=.env .agent/reconstruct-submitted-by.mjs --apply  # writes
//
// Requires env: GOOGLE_SHEET_ID, GOOGLE_SHEET_KEY_B64, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY.

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');

// Tab metadata. For LYN the stop code → tab-gid mapping tells us whose Name
// cell to read on a given day, since the two LYN tabs can have different
// drivers on the same day.
const TABS = {
  FSQ: { gid: 1825588771, name: 'Franklin Square ',                     route: 'FSQ' },
  VSR: { gid: 1112663081, name: 'Valley Stream/Rockville Centre',       route: 'LYN' },
  ERK: { gid:  580731113, name: 'East Rock/Oceanside/Long Beach',       route: 'LYN' },
  FBW: { gid: 1308920282, name: 'Baldwin/Freeport',                     route: 'FBW' },
};

// LYN stop code → which LYN tab. Codes come from parentheses in each
// sheet header, matched to stops.name in the DB.
const LYN_STOP_TO_TAB = {
  '711 Bway':  'VSR', '711 SR':  'VSR', '711 NCA': 'VSR',
  '711 M2':    'VSR', '711 M1':  'VSR', 'Kooka RVC': 'VSR', '711 RVC': 'VSR',
  '711 ATL':   'ERK', 'BG':      'ERK', '711 LAW': 'ERK',
  '711 OS':    'ERK', '711 LBR': 'ERK', '711 AU':  'ERK', '711 ATLO': 'ERK',
};

// Name normalization: Sheet uses one-n `Juliana`; DB uses two-n `Julianna`.
// `Mike C` is a signature variant of the existing operator `Mike` (user-confirmed).
const NAME_ALIASES = { 'Juliana': 'Julianna', 'Mike C': 'Mike' };
const normalizeName = s => {
  const t = String(s || '').trim();
  if (!t) return '';
  return NAME_ALIASES[t] || t;
};

// Normalize sheet dates. Two kinds of typos observed:
//   - year `0026` or `0028`       → `2026`/`2028`
//   - year `2025` on 2026 rows    → caller's context says which, we trust
//                                   adjacent rows to flag these; for safety
//                                   we only correct 4-digit `00NN` → `20NN`.
function parseSheetDate(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const mm = Number(m[1]), dd = Number(m[2]);
  let yy = m[3];
  if (yy.length === 2) yy = '20' + yy;
  if (yy.startsWith('00')) yy = '20' + yy.slice(2);     // 0026 → 2026
  if (yy.length !== 4) return null;
  const pad = n => String(n).padStart(2, '0');
  return `${yy}-${pad(mm)}-${pad(dd)}`;
}

async function sheetsClient() {
  const b64 = process.env.GOOGLE_SHEET_KEY_B64;
  if (!b64) throw new Error('GOOGLE_SHEET_KEY_B64 not set');
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key:   creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

// Pull a tab, return [{ for_date, driver_name }] keyed by date (last wins).
async function pullTab(sheets, spreadsheetId, tab) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab.name}'!A1:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const rows = r.data.values || [];
  if (rows.length < 2) return new Map();
  const header = rows[0];
  // Name column: whichever header text == 'Name' or 'Driver Name'.
  const nameIdx = header.findIndex(h => {
    const s = String(h || '').trim().toLowerCase();
    return s === 'name' || s === 'driver name';
  });
  if (nameIdx < 0) throw new Error(`No Name column in tab ${tab.name}`);
  const dateIdx = 1; // Column B everywhere.

  const byDate = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const iso = parseSheetDate(row[dateIdx]);
    if (!iso) continue;
    const driver = normalizeName(row[nameIdx]);
    byDate.set(iso, driver); // last wins
  }
  return byDate;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const sheets = await sheetsClient();

  // Fetch everything we need.
  const [fsq, vsr, erk, fbw] = await Promise.all([
    pullTab(sheets, process.env.GOOGLE_SHEET_ID, TABS.FSQ),
    pullTab(sheets, process.env.GOOGLE_SHEET_ID, TABS.VSR),
    pullTab(sheets, process.env.GOOGLE_SHEET_ID, TABS.ERK),
    pullTab(sheets, process.env.GOOGLE_SHEET_ID, TABS.FBW),
  ]);
  const SHEETS_BY_TAB = { FSQ: fsq, VSR: vsr, ERK: erk, FBW: fbw };

  const { data: people, error: pe } = await sb.from('people').select('id,name,role');
  if (pe) throw pe;
  const idByName = new Map(people.map(p => [p.name, p.id]));

  // Ensure the two Sheet-only drivers exist (user-confirmed additions).
  for (const name of ['Vikas', 'Nick']) {
    if (idByName.get(name)) continue;
    if (APPLY) {
      // pin_hash is NOT NULL on people. Set a placeholder that cannot match
      // any bcrypt verify_pin check (bcrypt hashes start with `$2`). Operator
      // can set a real PIN later if the driver needs portal access.
      const { data, error } = await sb.from('people')
        .insert({ name, role: 'driver', pin_hash: '!DISABLED_RECONSTRUCTION_PLACEHOLDER' })
        .select('id').single();
      if (error) throw error;
      idByName.set(name, data.id);
      console.log(`created people row for ${name} (id ${data.id})`);
    } else {
      idByName.set(name, `00000000-0000-0000-0000-${name.toLowerCase().padEnd(12,'x').slice(0,12)}`);
      console.log(`[dry-run] would create people row for ${name}`);
    }
  }

  const chrisId = idByName.get('Chris');
  if (!chrisId) throw new Error('Chris not found in people — bootstrap fallback impossible');

  const { data: stops, error: se } = await sb.from('stops').select('id,name,route_key');
  if (se) throw se;
  const stopById = new Map(stops.map(s => [s.id, s]));

  // Supabase JS caps at 1000 rows; paginate explicitly.
  const nulls = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('returns')
      .select('for_date,route_key,stop_id,sold_cents')
      .is('submitted_by', null)
      .order('for_date').order('stop_id')
      .range(from, from + 999);
    if (error) throw error;
    if (!data || !data.length) break;
    nulls.push(...data);
    if (data.length < 1000) break;
  }

  // Classify each null row and pick a driver name, then id.
  const outcome = {
    bySource: { sheet_named: 0, fallback_chris_blank: 0, fallback_chris_no_sheet: 0 },
    byDriver: new Map(),            // name → count
    unknownNames: new Map(),        // sheet name not in people → count
    unmappedLynStops: new Map(),    // lyn stop.name missing from LYN_STOP_TO_TAB
    rows: [],                       // (for_date, stop_id, old=null, new_name, source, revenue)
  };

  for (const r of nulls) {
    const stop = stopById.get(r.stop_id);
    let sheetName = '';
    let tabKey = null;

    if (r.route_key === 'FSQ') {
      tabKey = 'FSQ';
      sheetName = SHEETS_BY_TAB.FSQ.get(r.for_date) || '';
    } else if (r.route_key === 'FBW') {
      tabKey = 'FBW';
      sheetName = SHEETS_BY_TAB.FBW.get(r.for_date) || '';
    } else if (r.route_key === 'LYN') {
      const stopCode = stop ? stop.name : '';
      tabKey = LYN_STOP_TO_TAB[stopCode] || null;
      if (!tabKey) {
        outcome.unmappedLynStops.set(stopCode, (outcome.unmappedLynStops.get(stopCode) || 0) + 1);
        // fall through: no tab means no sheet lookup; fallback to Chris.
      } else {
        sheetName = SHEETS_BY_TAB[tabKey].get(r.for_date) || '';
      }
    }

    let chosenName, source;
    if (sheetName) {
      chosenName = sheetName;
      source = 'sheet_named';
    } else if (tabKey && SHEETS_BY_TAB[tabKey].has(r.for_date)) {
      // Sheet row exists but Name is blank.
      chosenName = 'Chris';
      source = 'fallback_chris_blank';
    } else {
      chosenName = 'Chris';
      source = 'fallback_chris_no_sheet';
    }

    const id = idByName.get(chosenName);
    if (!id) {
      outcome.unknownNames.set(chosenName, (outcome.unknownNames.get(chosenName) || 0) + 1);
      // Also record route + month ranges for unknowns so we can see where
      // they drive.
      outcome.unknownDetail = outcome.unknownDetail || {};
      const bucket = `${chosenName} | ${r.route_key} | ${r.for_date.slice(0,7)}`;
      outcome.unknownDetail[bucket] = (outcome.unknownDetail[bucket] || 0) + 1;
      continue;
    }

    outcome.bySource[source]++;
    outcome.byDriver.set(chosenName, (outcome.byDriver.get(chosenName) || 0) + 1);
    outcome.rows.push({
      for_date: r.for_date, stop_id: r.stop_id, route_key: r.route_key,
      new_submitted_by: id, new_name: chosenName, source, revenue_cents: r.sold_cents || 0,
    });
  }

  // Report.
  console.log(`\nTotal NULL rows: ${nulls.length}`);
  console.log('By source:');
  for (const [k, v] of Object.entries(outcome.bySource)) console.log(`  ${k.padEnd(28)} ${v}`);
  const revBySource = outcome.rows.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] || 0) + r.revenue_cents;
    return acc;
  }, {});
  console.log('Revenue by source:');
  for (const [k, v] of Object.entries(revBySource)) {
    console.log(`  ${k.padEnd(28)} $${(v/100).toFixed(2)}`);
  }
  console.log('By driver (after reconstruction):');
  const sorted = [...outcome.byDriver.entries()].sort((a,b) => b[1]-a[1]);
  for (const [n, c] of sorted) console.log(`  ${n.padEnd(12)} ${c}`);

  if (outcome.unknownNames.size) {
    console.log('\nUNKNOWN sheet names (not in people):');
    for (const [n, c] of outcome.unknownNames) console.log(`  ${n} × ${c}`);
    console.log('\nUnknown names by (name, route, month):');
    for (const [k, c] of Object.entries(outcome.unknownDetail || {}).sort()) {
      console.log(`  ${k}  × ${c}`);
    }
  }
  if (outcome.unmappedLynStops.size) {
    console.log('\nUNMAPPED LYN stops (not in LYN_STOP_TO_TAB):');
    for (const [s, c] of outcome.unmappedLynStops) console.log(`  "${s}" × ${c}`);
  }

  // Sidecar log + UPDATE. Applied only with --apply.
  if (!APPLY) {
    console.log('\nDry run only. Pass --apply to write.');
    return;
  }

  // Record every change for reversible rollback.
  await sb.from('returns_reconstruction_log').insert(
    outcome.rows.map(r => ({
      for_date: r.for_date, stop_id: r.stop_id,
      old_submitted_by: null,
      new_submitted_by: r.new_submitted_by,
      source: r.source,
      ran_at: new Date().toISOString(),
    }))
  ).throwOnError();

  // Batch updates: one UPDATE per (for_date, stop_id). Supabase JS client
  // doesn't do bulk UPDATE with per-row values, so loop.
  let n = 0;
  for (const r of outcome.rows) {
    const { error } = await sb.from('returns')
      .update({ submitted_by: r.new_submitted_by })
      .eq('for_date', r.for_date)
      .eq('stop_id', r.stop_id)
      .is('submitted_by', null);
    if (error) throw error;
    n++;
    if (n % 100 === 0) console.log(`  updated ${n}/${outcome.rows.length}`);
  }
  console.log(`\nApplied: ${n} rows updated.`);
}

main().catch(e => { console.error(e); process.exit(1); });
