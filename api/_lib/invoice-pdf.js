// PDF invoice renderer for wholesale orders.
//
// `renderInvoicePdf({ order, customer, invoiceNumber, invoiceDate })`
// returns a Promise<Buffer> containing a single-page letter-sized PDF
// matching the Pretzels of Long Island LLC invoice template (header +
// "INVOICE NO. | DATE" row + Bill-To / Store-Address columns + items
// table + totals block).
//
// Uses pdfkit built-in Helvetica / Helvetica-Bold — no font files are
// shipped, no network fetches, pure JS. Safe on Vercel serverless.
//
// This module is strictly additive: it does not replace the markdown
// email body (api/_lib/invoice-template.js) — it produces the PDF that
// is attached to it.
//
// Security: raw user-supplied strings (customer org/name/address, item
// name, promo code) pass through `safePdfText()` which strips control
// characters before any `doc.text()` call. pdfkit does not interpret
// its argument as a format string, but control chars could still break
// typography in weird ways. Belt and suspenders.

const PDFDocument = require('pdfkit');

const STORE_NAME    = 'Pretzels of Long Island LLC.';
const STORE_ADDRESS = '118 Broadway, Lynbrook, NY 11563';
const STORE_PHONE   = '516-459-0954';

// Letter page margins (inches → points, 72 pt / inch).
const M = 72 * 0.75;

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

      // ─── Header band ─────────────────────────────────────────────
      doc.font('Helvetica-Bold').fontSize(16).text(STORE_NAME, M, M, { lineGap: 2 });
      doc.font('Helvetica').fontSize(10).text(`${STORE_ADDRESS} · ${STORE_PHONE}`);
      doc.moveDown(1.2);

      // Horizontal rule under the header.
      const ruleY1 = doc.y;
      doc.moveTo(M, ruleY1).lineTo(M + USABLE_W, ruleY1).lineWidth(0.5).stroke();
      doc.moveDown(0.6);

      // ─── Invoice-no / date row ───────────────────────────────────
      const invNo = safePdfText(invoiceNumber);
      const invDate = safePdfText(formatDateMDY(invoiceDate));
      const rowY = doc.y;
      doc.font('Helvetica-Bold').fontSize(12)
        .text(`INVOICE NO. ${invNo}`, M, rowY, { width: USABLE_W / 2 });
      doc.font('Helvetica').fontSize(12)
        .text(invDate, M + USABLE_W / 2, rowY, { width: USABLE_W / 2, align: 'right' });
      doc.moveDown(1.2);

      // ─── Bill-To / Store-Address row ─────────────────────────────
      const colY = doc.y;
      const colW = USABLE_W / 2 - 10;
      doc.font('Helvetica-Bold').fontSize(10)
        .text('BILL TO', M, colY)
        .text('STORE ADDRESS', M + USABLE_W / 2, colY);
      doc.font('Helvetica').fontSize(10);
      const billLines = billToLines(customer);
      let leftY  = doc.y;
      let rightY = leftY;
      billLines.forEach((ln) => {
        doc.text(ln, M, leftY, { width: colW });
        leftY = doc.y;
      });
      doc.text(STORE_ADDRESS, M + USABLE_W / 2, rightY, { width: colW });
      rightY = doc.y;
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

      doc.font('Helvetica-Bold').fontSize(10);
      doc.text('QUANTITY',       colX.qty,   tableTop, { width: COL_W.qty });
      doc.text('DATE PERFORMED', colX.date,  tableTop, { width: COL_W.date });
      doc.text('UNIT PRICE',     colX.unit,  tableTop, { width: COL_W.unit,  align: 'right' });
      doc.text('TOTAL',          colX.total, tableTop, { width: COL_W.total, align: 'right' });
      doc.moveDown(0.3);
      const headerRule = doc.y;
      doc.moveTo(M, headerRule).lineTo(M + USABLE_W, headerRule).lineWidth(0.5).stroke();
      doc.moveDown(0.3);

      doc.font('Helvetica').fontSize(10);
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

      // Thin rule above totals.
      const totalsRule = doc.y + 4;
      doc.moveTo(M + USABLE_W / 2, totalsRule).lineTo(M + USABLE_W, totalsRule).lineWidth(0.5).stroke();
      doc.moveDown(0.6);

      // ─── Totals block ────────────────────────────────────────────
      const totalsLabelX = M + USABLE_W / 2;
      const totalsValueX = M + USABLE_W - 110;
      const totalsLabelW = USABLE_W / 2 - 110 - 6;
      const totalsValueW = 110;

      function totalsRow(label, value, bold) {
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
        doc.text(label, totalsLabelX, y, { width: totalsLabelW });
        doc.text(value, totalsValueX, y, { width: totalsValueW, align: 'right' });
        doc.moveDown(0.3);
      }

      totalsRow('SUBTOTAL', money(order && order.subtotal_cents));
      if (Number(order && order.discount_cents) > 0) {
        const promo = order.promo_code ? ` (${safePdfText(order.promo_code)})` : '';
        totalsRow(`DISCOUNT${promo}`, '-' + money(order.discount_cents));
      }
      totalsRow('SALES TAX', '$0.00');
      totalsRow('TOTAL', money(order && order.total_cents), /* bold */ true);

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
  __test: { money, formatDateMDY, safePdfText, billToLines, itemRows },
};
