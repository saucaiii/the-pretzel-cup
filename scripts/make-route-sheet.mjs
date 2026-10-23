// Generates a print-ready HTML reference sheet for LYN + FBW routes.
// Data comes from scratchpad/pretzel_stops.json (pre-fetched from Supabase).
const fs = require('fs');
const path = require('path');

const SCRATCH = '/private/tmp/claude-501/-Users-chris/0417dbe8-2b73-40cd-b941-c111afd12f98/scratchpad';
const stops = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'pretzel_stops.json'), 'utf8'));

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const dateStr = new Date().toLocaleDateString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

const ROUTES = {
  LYN: { label: 'Lynbrook Route (LYN)', bakery: 'Lynbrook bakery' },
  FBW: { label: 'Freeport / Baldwin Route (FBW)', bakery: 'Lynbrook bakery' },
};

function sumRoute(rk) {
  const rs = stops.filter(s => s.route_key === rk);
  let s = 0, d = 0, ss = 0, sd = 0;
  for (const r of rs) {
    s += r.singles_drop; d += r.doubles_drop;
    if (r.shorts) { ss += r.singles_drop; sd += r.doubles_drop; }
  }
  return { s, d, ss, sd, count: rs.length };
}

function routePage(rk, meta) {
  const rs = stops.filter(s => s.route_key === rk);
  const totals = sumRoute(rk);
  const rows = rs.map((s, i) => {
    const wk = (s.singles_drop_wknd != null || s.doubles_drop_wknd != null);
    const wknd = wk
      ? ` <span class="wknd">(wknd: ${s.singles_drop_wknd ?? s.singles_drop}/${s.doubles_drop_wknd ?? s.doubles_drop})</span>`
      : '';
    const subBits = [s.address, s.basket && `Basket: ${s.basket}`].filter(Boolean).join(' · ');
    const noteLine = s.note ? `<div class="note">${esc(s.note)}</div>` : '';
    const sub = subBits ? `<div class="sub">${esc(subBits)}</div>` : '';
    return `<tr class="${s.shorts ? 'is-shorts' : ''}">
      <td class="num">${i + 1}</td>
      <td class="stop">
        <div class="nm">${esc(s.name)}${s.shorts ? ' <span class="pill">SHORTS</span>' : ''}</div>
        <div class="tn">${esc(s.town)}</div>
        ${sub}
        ${noteLine}
      </td>
      <td class="qty">${s.singles_drop}${wknd}</td>
      <td class="qty">${s.doubles_drop}</td>
    </tr>`;
  }).join('');

  return `<section class="page">
    <header class="head">
      <div>
        <div class="eyebrow">Pretzel Delivery Sheet · ${esc(dateStr)}</div>
        <h1>${esc(meta.label)}</h1>
        <div class="submeta">Baked at <b>${esc(meta.bakery)}</b> · ${totals.count} active stops</div>
      </div>
      <div class="brand">THE PRETZEL CUP</div>
    </header>

    <div class="totals">
      <div class="t"><div class="t-l">Total Singles</div><div class="t-n">${totals.s}</div></div>
      <div class="t"><div class="t-l">Total Doubles</div><div class="t-n">${totals.d}</div></div>
      <div class="t sh"><div class="t-l">Short Singles</div><div class="t-n">${totals.ss}</div></div>
      <div class="t sh"><div class="t-l">Short Doubles</div><div class="t-n">${totals.sd}</div></div>
    </div>

    <table class="stops">
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Stop</th>
          <th class="qty">Singles</th>
          <th class="qty">Doubles</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td></td>
          <td class="foot">ROUTE TOTAL</td>
          <td class="qty foot">${totals.s}</td>
          <td class="qty foot">${totals.d}</td>
        </tr>
      </tfoot>
    </table>

    <div class="legend">
      <div class="lk"><span class="pill">SHORTS</span> &mdash; shorter pretzel variant, baked only at Lynbrook. Same price, same packaging.</div>
      <div class="lk small">Weekend overrides shown as <span class="wknd">(wknd: S/D)</span> &mdash; use these on Sat / Sun.</div>
    </div>
    <footer class="foot-line">In-store reference &mdash; generated ${esc(dateStr)}. Numbers update automatically from the live DB; reprint when a stop changes.</footer>
  </section>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pretzel Delivery Sheet</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
    color: #111; background: #fff; font-size: 11pt; line-height: 1.4;
  }
  .page { padding: 0; page-break-after: always; }
  .page:last-child { page-break-after: auto; }

  header.head {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid #0D5237; padding-bottom: 10pt; margin-bottom: 12pt;
  }
  .eyebrow { font-size: 9pt; letter-spacing: 0.15em; text-transform: uppercase; color: #0D5237; font-weight: 700; }
  h1 { font-size: 24pt; margin: 2pt 0 4pt; letter-spacing: 0.01em; color: #0D5237; }
  .submeta { font-size: 10pt; color: #444; }
  .submeta b { color: #0D5237; }
  .brand { font-size: 10pt; letter-spacing: 0.2em; color: #0D5237; font-weight: 700; text-align: right; }

  .totals {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt;
    margin-bottom: 14pt;
  }
  .totals .t { border: 1pt solid #0D5237; border-radius: 6pt; padding: 8pt 10pt; }
  .totals .t.sh { border-color: #B4870A; background: #FFF8E1; }
  .totals .t-l { font-size: 8pt; letter-spacing: 0.14em; text-transform: uppercase; color: #0D5237; font-weight: 700; }
  .totals .t.sh .t-l { color: #B4870A; }
  .totals .t-n { font-size: 28pt; font-weight: 700; line-height: 1.05; color: #0D5237; font-variant-numeric: tabular-nums; }
  .totals .t.sh .t-n { color: #B4870A; }

  table.stops { width: 100%; border-collapse: collapse; margin-bottom: 10pt; }
  table.stops th, table.stops td { border: 0.5pt solid #999; padding: 6pt 8pt; vertical-align: top; }
  table.stops th { background: #0D5237; color: #fff; font-size: 9pt; letter-spacing: 0.12em; text-transform: uppercase; }
  table.stops th.num, table.stops td.num { width: 24pt; text-align: center; font-weight: 700; color: #0D5237; }
  table.stops th.qty, table.stops td.qty { width: 60pt; text-align: center; font-size: 16pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  table.stops tbody tr.is-shorts td { background: #FFF8E1; }
  table.stops tbody tr.is-shorts td.qty { color: #B4870A; }

  .nm { font-size: 13pt; font-weight: 700; }
  .pill {
    display: inline-block; font-size: 8pt; letter-spacing: 0.14em; font-weight: 700;
    padding: 1pt 6pt; border-radius: 3pt; background: #B4870A; color: #fff;
    vertical-align: middle; margin-left: 4pt;
  }
  .tn { font-size: 10pt; color: #555; margin-top: 1pt; }
  .sub { font-size: 9pt; color: #666; margin-top: 2pt; }
  .note { font-size: 9pt; color: #B4870A; margin-top: 2pt; font-weight: 600; }
  .wknd { font-size: 8pt; color: #555; font-weight: 400; display: block; }
  .foot { font-weight: 700; font-size: 11pt; text-transform: uppercase; letter-spacing: 0.1em; background: #f0f0f0; }
  .qty.foot { font-size: 18pt; color: #0D5237; }

  .legend { font-size: 9pt; color: #333; margin-top: 10pt; border-top: 0.5pt solid #ccc; padding-top: 8pt; }
  .legend .lk { margin-bottom: 3pt; }
  .legend .small { color: #666; font-size: 8pt; }
  .foot-line { font-size: 8pt; color: #888; margin-top: 16pt; border-top: 0.25pt solid #ddd; padding-top: 6pt; }
</style>
</head>
<body>
${routePage('LYN', ROUTES.LYN)}
${routePage('FBW', ROUTES.FBW)}
</body>
</html>`;

const htmlPath = path.join(SCRATCH, 'pretzel_route_sheet.html');
fs.writeFileSync(htmlPath, html);
console.log('HTML →', htmlPath);
