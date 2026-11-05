// PDF invoice renderer for wholesale orders.
//
// `renderInvoicePdf({ order, customer, invoiceNumber, invoiceDate })`
// returns a Promise<Buffer> containing a single-page letter-sized PDF
// matching the Pretzels of Long Island LLC invoice template (header +
// "INVOICE NO. | DATE" row + Bill-To / Store-Address columns + items
// table + totals block), styled with the PPF brand palette: PPF green
// `#0D5237` for the structural rule under the header, the items-table
// header text, and the TOTAL line; a cream `#FAF4E1` band behind the
// items-table header row; and the PPF logo at the top-left of the
// header lockup.
//
// Uses pdfkit built-in Helvetica / Helvetica-Bold — no font files are
// shipped, no network fetches, pure JS. Safe on Vercel serverless.
//
// This module is strictly additive to the existing send path: it does
// not replace the markdown email body (api/_lib/invoice-template.js)
// — it produces the PDF that is attached to it.
//
// Logo bundling note: the PPF logo lives beside this file at
// `./invoice-logo.jpg`. Loading it via `fs.readFileSync(path.join(
// __dirname, 'invoice-logo.jpg'))` at module top level is the pattern
// `@vercel/nft` can trace statically, so Vercel includes the asset in
// the function bundle automatically (no `includeFiles` in vercel.json
// required). If the read fails for any reason (bundle mis-trace,
// local dev without the file, etc.), LOGO_BYTES stays null and the
// renderer falls through to a text-only header — the invoice still
// sends; the branding degrades gracefully.
//
// Security: raw user-supplied strings (customer org/name/address, item
// name, promo code) pass through `safePdfText()` which strips control
// characters before any `doc.text()` call. pdfkit does not interpret
// its argument as a format string, but control chars could still break
// typography in weird ways. Belt and suspenders.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const STORE_NAME    = 'Pretzels of Long Island LLC.';
const STORE_ADDRESS = '118 Broadway, Lynbrook, NY 11563';
const STORE_PHONE   = '516-459-0954';

// PPF brand palette (mirrors the tokens in brand.css).
const COLOR_PPF_GREEN = '#0D5237';
const COLOR_CREAM     = '#FAF4E1';
const COLOR_BLACK     = '#000000';
const COLOR_RULE_GRAY = '#999999';

// Load the logo bytes once at module load so Vercel's @vercel/nft
// tracer picks the file up as a static require. A missing file does
// not throw — the renderer treats LOGO_BYTES=null as "no logo".
const LOGO_PATH = path.join(__dirname, 'invoice-logo.jpg');
let LOGO_BYTES = null;
try {
  LOGO_BYTES = fs.readFileSync(LOGO_PATH);
} catch (ex) {
  LOGO_BYTES = null;
  // eslint-disable-next-line no-console
  console.warn('invoice-pdf: logo not found at ' + LOGO_PATH + ' — falling back to text-only header');
}

// Letter page margins (inches → points, 72 pt / inch).
const M = 72 * 0.75;

// Logo size (square fit). The header text column starts LOGO_W + LOGO_GAP
// to the right of the left margin when the logo is present.
const LOGO_W   = 54;
const LOGO_GAP = 14;

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function money(cents) {
  const n = Math.max(0, Math.round(Number(cents || 0)));
  return `$${(n / 100).toFixed(2)}`;
}

// e.g. "NOV 4, 2026". A bare `YYYY-MM-DD` string (how Supabase returns a
// `date` column) is parsed as a LOCAL date — the default Date parser
// treats it as UTC midnight, which flips to the previous day in any
// western-hemisphere timezone. Other inputs fall through to the Date
// constructor.
function formatDateMDY(input) {
  if (!input) return '';
  let d;
  if (input instanceof Date) {
    d = input;
  } else {
    const s = String(input);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  }
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Strip control chars that could break typography. Keeps tab + newline
// out since the template is single-line per cell anyway.
function safePdfText(s) {
  if (s == null) return '';
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function billToLines(customer) {
  const line1 = safePdfText(
    (customer && (customer.organization || customer.contact_name || customer.first_name)) || '—',
  );
  const line2 = safePdfText(customer && customer.pickup_address);
  return line2 ? [line1, line2] : [line1];
}

// Stacked pickup lines: location, date (MMM D, YYYY), time. Any field
// that's empty is skipped so the column collapses to fewer lines
// rather than showing blanks. `order.pickup_location` wins when set
// (that's what the submit path writes); `customer.pickup_location` is
// the fallback for orders captured before the submit path propagated
// it (pre-P14 legacy).
function pickupLines(order, customer) {
  const loc = safePdfText(
    (order && order.pickup_location) ||
    (customer && customer.pickup_location),
  );
  const date = safePdfText(order && order.pickup_date ? formatDateMDY(order.pickup_date) : '');
  const time = safePdfText(order && order.pickup_time);
  return [loc, date, time].filter(Boolean);
}

// Build the items array in render-ready form (one row per order.items[*]).
// Bonus rows (is_bonus=true, unit_price_cents=0) render "(free)" in the
// UNIT PRICE column and $0.00 in TOTAL; regular rows show both figures.
function itemRows(order) {
  const items = Array.isArray(order && order.items) ? order.items : [];
  const datePerformed = order && order.pickup_date ? formatDateMDY(order.pickup_date) : '';
  return items.map((it) => {
    const qty  = Number(it.qty || 0);
    const name = safePdfText(it.name || it.sku || 'Item');
    const unit = Number(it.unit_price_cents || 0);
    const line = Number(it.line_total_cents || qty * unit);
    return {
      quantity:  `${qty}x ${name}`,
      performed: datePerformed,
      unit:      it.is_bonus ? '(free)' : money(unit),
      total:     money(line),
    };
  });
}

// Letter page width / height in pt: 612 x 792. After 0.75" margins,
// usable width = 612 - 2*54 = 504 pt.
const PAGE_W = 612;
const USABLE_W = PAGE_W - 2 * M;

// Column fractions for the items table — relative widths that sum to 1.
const COL_FR = { qty: 0.44, date: 0.24, unit: 0.16, total: 0.16 };
const COL_W  = {
  qty:   USABLE_W * COL_FR.qty,
  date:  USABLE_W * COL_FR.date,
  unit:  USABLE_W * COL_FR.unit,
  total: USABLE_W * COL_FR.total,
};

function renderInvoicePdf({ order, customer, invoiceNumber, invoiceDate }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: M, bottom: M, left: M, right: M },
        info: {
          Title:   `Invoice ${invoiceNumber || ''}`.trim(),
          Author:  STORE_NAME,
          Creator: STORE_NAME,
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ─── Header band (logo + lockup) ─────────────────────────────
      const headerTextX = LOGO_BYTES ? M + LOGO_W + LOGO_GAP : M;
      const headerTextW = USABLE_W - (headerTextX - M);
      if (LOGO_BYTES) {
        try {
          doc.image(LOGO_BYTES, M, M, { fit: [LOGO_W, LOGO_W] });
        } catch (ex) {
          // Corrupt JPEG or pdfkit refused it — degrade to text-only
          // without failing the whole render.
          // eslint-disable-next-line no-console
          console.warn('invoice-pdf: doc.image failed, continuing text-only: ' + (ex && ex.message));
        }
      }
      doc.fillColor(COLOR_BLACK)
        .font('Helvetica-Bold').fontSize(16)
        .text(STORE_NAME, headerTextX, M, { width: headerTextW, lineGap: 2 });
      doc.font('Helvetica').fontSize(10)
        .text(`${STORE_ADDRESS} · ${STORE_PHONE}`, headerTextX, doc.y, { width: headerTextW });

      // Push the cursor below whichever is taller: logo or text lockup.
      const headerBottom = Math.max(doc.y, M + LOGO_W + 6);
      doc.y = headerBottom;
      doc.moveDown(0.4);

      // PPF-green accent rule under the header.
      const ruleY1 = doc.y;
      doc.save();
      doc.strokeColor(COLOR_PPF_GREEN).lineWidth(1.0)
        .moveTo(M, ruleY1).lineTo(M + USABLE_W, ruleY1).stroke();
      doc.restore();
      doc.moveDown(0.8);

      // ─── Invoice-no / date row ───────────────────────────────────
      const invNo = safePdfText(invoiceNumber);
      const invDate = safePdfText(formatDateMDY(invoiceDate));
      const rowY = doc.y;
      doc.fillColor(COLOR_BLACK)
        .font('Helvetica-Bold').fontSize(12)
        .text(`INVOICE NO. ${invNo}`, M, rowY, { width: USABLE_W / 2 });
      doc.font('Helvetica').fontSize(12)
        .text(invDate, M + USABLE_W / 2, rowY, { width: USABLE_W / 2, align: 'right' });
      doc.moveDown(1.2);

      // ─── Bill-To / Pickup row ───────────────────────────────────
      // Store Address isn't duplicated here — it's already in the
      // header band above. The right column now surfaces pickup
      // location + date + time, which is what the customer needs to
      // act on (e2e report flagged the missing pickup time + the
      // buried pickup location).
      const colY = doc.y;
      const colW = USABLE_W / 2 - 10;
      doc.font('Helvetica-Bold').fontSize(10)
        .text('BILL TO', M, colY)
        .text('PICKUP', M + USABLE_W / 2, colY);
      doc.font('Helvetica').fontSize(10);
      const billLines = billToLines(customer);
      const pickLines = pickupLines(order, customer);
      let leftY  = doc.y;
      let rightY = leftY;
      billLines.forEach((ln) => {
        doc.text(ln, M, leftY, { width: colW });
        leftY = doc.y;
      });
      if (pickLines.length) {
        pickLines.forEach((ln) => {
          doc.text(ln, M + USABLE_W / 2, rightY, { width: colW });
          rightY = doc.y;
        });
      } else {
        // No pickup fields populated — keep the right column vertical
        // footprint comparable so the layout doesn't collapse.
        doc.text('—', M + USABLE_W / 2, rightY, { width: colW });
        rightY = doc.y;
      }
      doc.y = Math.max(leftY, rightY);
      doc.moveDown(1.0);

      // ─── Items table ─────────────────────────────────────────────
      const tableTop = doc.y;
      const colX = {
        qty:   M,
        date:  M + COL_W.qty,
        unit:  M + COL_W.qty + COL_W.date,
        total: M + COL_W.qty + COL_W.date + COL_W.unit,
      };

      // Cream band behind the column header row.
      const headerBandH = 20;
      doc.save();
      doc.rect(M, tableTop - 4, USABLE_W, headerBandH).fill(COLOR_CREAM);
      doc.restore();

      // Header labels in PPF green.
      doc.fillColor(COLOR_PPF_GREEN).font('Helvetica-Bold').fontSize(10);
      const headerY = tableTop + 2;
      doc.text('QUANTITY',       colX.qty,   headerY, { width: COL_W.qty });
      doc.text('DATE PERFORMED', colX.date,  headerY, { width: COL_W.date });
      doc.text('UNIT PRICE',     colX.unit,  headerY, { width: COL_W.unit,  align: 'right' });
      doc.text('TOTAL',          colX.total, headerY, { width: COL_W.total, align: 'right' });

      // Cursor just below the cream band.
      doc.y = tableTop + headerBandH + 2;
      doc.fillColor(COLOR_BLACK).font('Helvetica').fontSize(10);
      const rows = itemRows(order);
      if (!rows.length) {
        doc.text('(no line items)', M, doc.y, { width: USABLE_W });
        doc.moveDown(0.3);
      } else {
        rows.forEach((r) => {
          const rowY2 = doc.y;
          doc.text(r.quantity,  colX.qty,   rowY2, { width: COL_W.qty });
          doc.text(r.performed, colX.date,  rowY2, { width: COL_W.date });
          doc.text(r.unit,      colX.unit,  rowY2, { width: COL_W.unit,  align: 'right' });
          doc.text(r.total,     colX.total, rowY2, { width: COL_W.total, align: 'right' });
          doc.moveDown(0.3);
        });
      }

      // Thin gray rule above totals.
      const totalsRule = doc.y + 4;
      doc.save();
      doc.strokeColor(COLOR_RULE_GRAY).lineWidth(0.5)
        .moveTo(M + USABLE_W / 2, totalsRule).lineTo(M + USABLE_W, totalsRule).stroke();
      doc.restore();
      doc.moveDown(0.6);

      // ─── Totals block ────────────────────────────────────────────
      const totalsLabelX = M + USABLE_W / 2;
      const totalsValueX = M + USABLE_W - 110;
      const totalsLabelW = USABLE_W / 2 - 110 - 6;
      const totalsValueW = 110;

      function totalsRow(label, value, { bold, color, size } = {}) {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size || 10);
        doc.fillColor(color || COLOR_BLACK);
        doc.text(label, totalsLabelX, y, { width: totalsLabelW });
        doc.text(value, totalsValueX, y, { width: totalsValueW, align: 'right' });
        doc.moveDown(0.3);
      }

      // No DISCOUNT row. The 100-for-25 is a comped-units free gift,
      // not a price cut — the `(free)` entry in the UNIT PRICE column
      // of each bonus line item already carries the story, and
      // printing a dollar discount beside an unchanged TOTAL reads
      // as broken math and assigns a public dollar value to a gift.
      // `discount_cents` stays on the order row for internal
      // analytics; it just stops being rendered on the PDF.
      totalsRow('SUBTOTAL', money(order && order.subtotal_cents));
      totalsRow('SALES TAX', '$0.00');
      totalsRow('TOTAL', money(order && order.total_cents), {
        bold:  true,
        color: COLOR_PPF_GREEN,
        size:  11,
      });

      doc.end();
    } catch (ex) {
      reject(ex);
    }
  });
}

module.exports = {
  renderInvoicePdf,
  // Internal: test-only exports. Kept on the module so a static smoke
  // can exercise formatting helpers without round-tripping a real PDF.
  __test: { money, formatDateMDY, safePdfText, billToLines, pickupLines, itemRows, LOGO_LOADED: Boolean(LOGO_BYTES) },
};
