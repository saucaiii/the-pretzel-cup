// Google Sheet writer. Appends one row per sheet tab per route submit.
//
// The sheet (Daily Delivery Sales Report) has four tabs; our LYN route
// spans two of them. On a submit we build one row per tab the driver's
// stops touched, in sheet column order:
//
//   [ Timestamp, Date (day before today), $stop1, $stop2, ..., driverName ]
//
// Stops are matched by stop.name → sheet column code. The mapping below
// is the source of truth and must stay in sync with the sheet headers.
//
// Requires env:
//   GOOGLE_SHEET_ID       — the spreadsheet id
//   GOOGLE_SHEET_KEY_B64  — base64 of the service account JSON key file

const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// gid → which tabs each route writes to. LYN splits across two tabs; FSQ
// and FBW are single-tab. Stop codes and the name-column index are read
// LIVE from each tab's header row at runtime (see headerFor below) so
// adding/removing a column on the sheet doesn't require a code change,
// and so an operator-added stop with a matching sheet column starts
// flowing automatically. The sheet is the source of truth for codes.
const TABS = {
  FSQ: [{ gid: 1825588771 }],
  LYN: [{ gid: 1112663081 }, { gid: 580731113 }],
  FBW: [{ gid: 1308920282 }],
};

// Cached tab names by gid, populated on first use per process.
let _tabNamesByGid = null;
async function tabNameFor(sheets, gid) {
  if (!_tabNamesByGid) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      fields: 'sheets.properties(sheetId,title)',
    });
    _tabNamesByGid = Object.create(null);
    for (const s of meta.data.sheets) _tabNamesByGid[s.properties.sheetId] = s.properties.title;
  }
  const name = _tabNamesByGid[gid];
  if (!name) throw new Error(`tab gid ${gid} not found in sheet`);
  return name;
}

// Cached header parse per gid: ordered { codes: [...], nameColIdx }.
// Reads row 1 and extracts the "(CODE)" suffix from each column header.
// First "Name" / "Driver Name" column anchors nameColIdx.
const _headerCache = Object.create(null);
async function headerFor(sheets, gid) {
  if (_headerCache[gid]) return _headerCache[gid];
  const tabName = await tabNameFor(sheets, gid);
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(tabName)}!1:1`,
  });
  const row = (r.data.values && r.data.values[0]) || [];
  const codes = [];        // { col_idx, code }
  let nameColIdx = null;
  for (let i = 2; i < row.length; i++) {   // col 0 = Timestamp, col 1 = Date
    const txt = String(row[i] || '').trim();
    if (!txt) continue;
    if (txt === 'Name' || txt === 'Driver Name') { nameColIdx = i; break; }
    const m = txt.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!m) continue;
    const code = m[2].trim();
    if (/^\d+\s*\/\s*\d+$/.test(code)) continue;  // "(5/5)" count, not code
    codes.push({ colIdx: i, code });
  }
  if (nameColIdx == null) nameColIdx = (codes.length ? codes[codes.length - 1].colIdx + 1 : 2);
  _headerCache[gid] = { codes, nameColIdx };
  return _headerCache[gid];
}

let _sheets = null;
async function getSheets() {
  if (_sheets) return _sheets;
  const b64 = process.env.GOOGLE_SHEET_KEY_B64;
  if (!b64) throw new Error('GOOGLE_SHEET_KEY_B64 not set');
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID not set');
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return _sheets;
}

// Format a date "day before today" as the sheet does: M/D/YYYY (no zero padding).
function fmtSheetDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

// Timestamp as the Form writes it: 10/19/2026 16:04:12
function fmtSheetTimestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Quote the tab name for A1 notation. Google's parser rejects unquoted
// names with spaces or special chars.
function quoteTab(tabName) {
  const needsQuoting = /[^A-Za-z0-9_]/.test(tabName);
  return needsQuoting
    ? `'${tabName.replace(/'/g, "''")}'`
    : tabName;
}

// A1 column letter from a 1-indexed column number (1 → A, 27 → AA).
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Find the first empty row in column A of a tab (1-indexed sheet row).
// Google Form response sheets have an invisible "table" that confuses
// append's auto-placement, so we locate the next empty row explicitly
// instead of trusting the "A1" default range.
async function nextEmptyRow(sheets, tabName) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(tabName)}!A:A`,
  });
  const used = (r.data.values || []).length;  // last populated row
  return used + 1;
}

// Return the 1-indexed sheet row for an existing submission by this driver on
// this date, or null if none found. Matches on column B (date) + name column.
// Walking newest-to-oldest so the most-recent duplicate wins when there are
// legacy duplicates in the sheet.
async function existingRowFor(sheets, tabName, forDate, driverName, nameColIdx) {
  if (!driverName) return null;
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(tabName)}!A:${columnLetter(nameColIdx + 1)}`,
  });
  const rows = r.data.values || [];
  const dateStr = fmtSheetDate(forDate);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.length <= nameColIdx) continue;
    if (row[1] === dateStr && row[nameColIdx] === driverName) return i + 1;
  }
  return null;
}

// Public: called by /api/driver/submit after rows are upserted to Supabase.
// Args: { routeKey, forDate, rows: [{stop_id, sold_cents, ...}], stopById, driverName }.
// Returns { ok, tabs: [{tab, updates}], skipped: [codes without matching entry] } or { error }.
async function appendRouteRow({ routeKey, forDate, rows, stopById, driverName }) {
  const tabs = TABS[routeKey];
  if (!tabs) return { error: `no sheet mapping for route ${routeKey}` };

  const sheets = await getSheets();

  // stop.name → sold_cents from this submit, as a dollar value (sheet uses dollars).
  const byCode = Object.create(null);
  for (const r of rows) {
    const s = stopById[r.stop_id];
    if (!s) continue;
    byCode[s.name] = r.sold_cents / 100;
  }

  const results = [];
  for (const tab of tabs) {
    const header = await headerFor(sheets, tab.gid);
    const tabCodes = header.codes.map(c => c.code);
    // Any submitted stop match a column on this tab?
    const hasAny = tabCodes.some(code => code in byCode);
    if (!hasAny) continue;

    // Build the row as a sparse-friendly flat array by placing each value
    // at its header's colIdx. Pad gaps with ''. Driver name goes at nameColIdx.
    const row = [fmtSheetTimestamp(), fmtSheetDate(forDate)];
    while (row.length <= header.nameColIdx) row.push('');
    header.codes.forEach(({ colIdx, code }) => {
      if (code in byCode) row[colIdx] = byCode[code];
    });
    row[header.nameColIdx] = driverName || '';

    const tabName  = await tabNameFor(sheets, tab.gid);
    const existing = await existingRowFor(sheets, tabName, forDate, driverName, header.nameColIdx);
    const target   = existing || await nextEmptyRow(sheets, tabName);
    const resp = await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${quoteTab(tabName)}!A${target}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
    results.push({
      tab: tabName,
      row: target,
      replaced: !!existing,
      range: resp.data.updatedRange,
    });
  }

  // If any submitted stop has no matching sheet column across any tab we
  // tried, carry a note so the response can surface it to the operator.
  const matched = new Set();
  for (const tab of tabs) {
    const header = await headerFor(sheets, tab.gid);
    header.codes.forEach(c => { if (c.code in byCode) matched.add(c.code); });
  }
  const unmatched = Object.keys(byCode).filter(k => !matched.has(k));

  return { ok: true, tabs: results, unmatched_codes: unmatched };
}

// ─── Add-a-column helper ────────────────────────────────────────────
// Insert a new column immediately before the "Name" / "Driver Name"
// column on `gid`, with the given header text. The column is created
// with the previous column's formatting inherited (so number vs text
// formatting stays sensible for stop sales columns).
//
// Returns { gid, tab_name, inserted_at_col_idx, column_letter, header }.
// Throws on failure; caller catches to report to the operator.
async function insertSheetColumn({ gid, header }) {
  if (!gid || typeof gid !== 'number') throw new Error('insertSheetColumn: gid (number) required');
  if (!header || typeof header !== 'string') throw new Error('insertSheetColumn: header required');
  const sheets = await getSheets();
  // Resolve where "Name" lives today, before we mutate.
  const h = await headerFor(sheets, gid);
  const insertAt = h.nameColIdx;  // 0-indexed; insert pushes Name one to the right
  const tabName = await tabNameFor(sheets, gid);
  // Step 1: insert the physical column.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        insertDimension: {
          range: { sheetId: gid, dimension: 'COLUMNS', startIndex: insertAt, endIndex: insertAt + 1 },
          inheritFromBefore: true,
        },
      }],
    },
  });
  // Step 2: set the header cell.
  const colLetter = columnLetter(insertAt + 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(tabName)}!${colLetter}1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[header]] },
  });
  // Step 3: bust the header cache for this gid so the next submit sees
  // the new column (and the Name column at its new index).
  delete _headerCache[gid];
  return { gid, tab_name: tabName, inserted_at_col_idx: insertAt, column_letter: colLetter, header };
}

// Read EVERY data row from a tab. Returns a parsed structure the backfill
// endpoint can hand to the returns table. Each row carries:
//   { for_date: "YYYY-MM-DD" | null, driver_name: "Eric" | null,
//     cells: { "711 SRRVC": 19.70, ... } }
// Blank / malformed cells are skipped. for_date is parsed from column B
// (M/D/YYYY or M/D/YY). Rows without a parseable date are skipped.
async function readTabRows(gid) {
  const sheets = await getSheets();
  const header = await headerFor(sheets, gid);
  const tabName = await tabNameFor(sheets, gid);
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${quoteTab(tabName)}!A2:ZZ`,  // skip the header row
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const raw = r.data.values || [];
  const parseDate = s => {
    if (!s) return null;
    if (typeof s === 'number') {
      // Google Sheets stores dates as serial numbers; day 1 = 1899-12-30.
      const d = new Date(Date.UTC(1899, 11, 30));
      d.setUTCDate(d.getUTCDate() + Math.floor(s));
      let y = d.getUTCFullYear();
      // Some sheet rows had dates typed as "11/21/25" which Google interpreted
      // as year 25 AD (negative serials). Recover: any year < 1900 is treated
      // as a 2-digit shortform and bumped into the 2000s.
      if (y < 1900) y = 2000 + (y % 100);
      return `${y}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    let y = parseInt(m[3], 10); if (y < 100) y += 2000;
    return `${y}-${String(parseInt(m[1],10)).padStart(2,'0')}-${String(parseInt(m[2],10)).padStart(2,'0')}`;
  };
  const parseDollars = v => {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return Number.isNaN(n) ? null : n;
  };
  const out = [];
  for (const row of raw) {
    if (!row || !row.length) continue;
    const forDate = parseDate(row[1]);
    if (!forDate) continue;
    const driverName = (row[header.nameColIdx] || '').toString().trim() || null;
    const cells = {};
    for (const { colIdx, code } of header.codes) {
      const v = parseDollars(row[colIdx]);
      if (v != null) cells[code] = v;
    }
    if (!Object.keys(cells).length) continue;
    out.push({ for_date: forDate, driver_name: driverName, cells });
  }
  return { tab_name: tabName, rows: out };
}

// Which sheet gids each route writes to, in display order. Exported for
// the ops UI (add-stop) so it can show a tab picker. Names are resolved
// lazily — call routeTabsMeta() to get [{gid, name}] with names filled.
const ROUTE_TABS = TABS;

async function routeTabsMeta(routeKey) {
  const tabs = TABS[routeKey];
  if (!tabs) return [];
  const sheets = await getSheets();
  const out = [];
  for (const t of tabs) {
    const name = await tabNameFor(sheets, t.gid);
    out.push({ gid: t.gid, name });
  }
  return out;
}

module.exports = { appendRouteRow, insertSheetColumn, routeTabsMeta, ROUTE_TABS, readTabRows };
