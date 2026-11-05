// Invoice email template for wholesale orders.
//
// Pure function: `renderInvoice({ order, customer })` returns
// `{ subject, bodyMd, html, text }`.
//
// Shape of this email: ORDER CONFIRMATION + UNPAID INVOICE ATTACHED.
// Not a Shopify-style post-payment receipt. The PDF invoice is
// attached by api/wholesale/invoice.js at live-send time; this module
// only builds the body. The HTML mirrors the Shopify order-
// confirmation layout the user shared (logo + order-number header,
// large heading, order-summary rows, totals, two-column customer
// info, footer) but with copy and emphasis that make clear the
// invoice is OPEN — labels read "Amount due", the first thing the
// recipient sees is a cream callout with the dollar figure, and the
// Payment section is a bordered PPF-green panel (the primary CTA).
//
// The plain-text body still uses the markdown renderer in md.js so
// clients that don't render HTML still get a usable receipt — this
// keeps the pre-restyle behavior intact for that path.
//
// Raw user-supplied fields (customer first name, org, pickup text,
// item name, promo code) flow through `escapeHtml` before being
// inlined into the HTML string; `mdSafe` still breaks `[label](url)`
// in the markdown path so a crafted org name can't smuggle an anchor
// into the plain-text / markdown rendering.
//
// Payment instructions come from env `WHOLESALE_INVOICE_PAYMENT_HELP`
// (free-form markdown; renderMarkdown handles the HTML output).
// Default is a conservative "we'll follow up" message so an
// unconfigured install never implies wire details that aren't there.

const { renderMarkdown, escapeHtml } = require('./md');

const DEFAULT_PAYMENT_HELP =
  "We'll follow up with payment details shortly.";

// PPF palette (mirrors brand.css + invoice-pdf.js).
const COLOR_PPF_GREEN = '#0D5237';
const COLOR_PPF_GREEN_DEEP = '#083521';
const COLOR_CREAM     = '#FAF4E1';
const COLOR_INK       = '#333333';
const COLOR_INK_2     = '#555555';
const COLOR_INK_3     = '#999999';
const COLOR_RULE      = '#e5e5e5';
const COLOR_WHITE     = '#ffffff';

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif';

function money(cents) {
  const n = Math.max(0, Math.round(Number(cents || 0)));
  return `$${(n / 100).toFixed(2)}`;
}

function paymentHelpMd() {
  const raw = process.env.WHOLESALE_INVOICE_PAYMENT_HELP;
  const s = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_PAYMENT_HELP;
  return s;
}

function baseUrl() {
  const v = process.env.WHOLESALE_BASE_URL;
  if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim().replace(/\/+$/, '');
  return 'https://the-pretzel-cup.vercel.app';
}

// Break the markdown link syntax `[label](url)` in customer-sourced
// strings. Only used on the markdown / plain-text path. The HTML
// path uses escapeHtml directly.
function mdSafe(s) {
  return String(s == null ? '' : s).replace(/\]\(/g, ') (');
}

function invoiceDisplayNumber(order) {
  if (order && order.invoice_number != null) return `#${order.invoice_number}`;
  if (order && order.id) return `#${String(order.id).slice(0, 8).toUpperCase()}`;
  return '';
}

// ─── Plain-text / markdown body (unchanged shape) ─────────────────

function itemLine(it) {
  const name = mdSafe(it.name || it.sku || 'Item');
  const qty  = Number(it.qty || 0);
  const unit = Number(it.unit_price_cents || 0);
  const line = Number(it.line_total_cents || qty * unit);
  if (it.is_bonus) {
    return `- ${qty} × ${name} — (free)`;
  }
  return `- ${qty} × ${name} @ ${money(unit)} — **${money(line)}**`;
}

function pickupMd(order) {
  const parts = [];
  if (order.pickup_location) parts.push(mdSafe(order.pickup_location));
  if (order.pickup_date)     parts.push(mdSafe(order.pickup_date));
  if (order.pickup_time)     parts.push(mdSafe(order.pickup_time));
  return parts.length ? parts.join(' · ') : null;
}

function buildBody({ order, customer }) {
  const greetingName = customer && customer.first_name
    ? mdSafe(String(customer.first_name).trim())
    : 'there';
  const org = customer && customer.organization
    ? mdSafe(String(customer.organization).trim())
    : null;
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsMd = items.length
    ? items.map(itemLine).join('\n')
    : '- (no line items)';
  const pickup = pickupMd(order);
  const total = money(order.total_cents);
  const subtotal = money(order.subtotal_cents);

  // No "Discount" line. The 100-for-25 is a comped-units free gift,
  // not a price cut. The `(free)` cell on each bonus line item is
  // the story. discount_cents still lives on the order row for
  // internal analytics; we just don't surface it to the customer.
  const lines = [
    `Hi ${greetingName},`,
    '',
    org
      ? `Thanks for your wholesale order for **${org}**. Your invoice is attached — it's currently unpaid. See the Payment section below for how to settle it.`
      : 'Thanks for your wholesale order. Your invoice is attached — it\'s currently unpaid. See the Payment section below for how to settle it.',
    '',
    '### Order',
    itemsMd,
    '',
    `Subtotal: ${subtotal}`,
    '',
    `**Amount due: ${total}**`,
    '',
  ];
  if (pickup) {
    lines.push('### Pickup', pickup, '');
  }
  lines.push('### Payment', paymentHelpMd(), '', '— Philly Pretzel Factory');
  return lines.join('\n');
}

function toPlainText(bodyMd) {
  return String(bodyMd)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1');
}

function buildSubject(order) {
  const total = money(order.total_cents);
  return `Your Philly Pretzel Factory wholesale invoice — ${total}`;
}

// ─── HTML body — hand-built table layout for email clients ────────

// Order-summary row (one <tr> per line item). Styled to match the
// Pudgy Penguins template's row pattern, but without product images
// (wholesale SKUs don't carry images today).
function itemRowHtml(it, isFirst) {
  const name = escapeHtml(it.name || it.sku || 'Item');
  const qty  = Number(it.qty || 0);
  const unit = Number(it.unit_price_cents || 0);
  const line = Number(it.line_total_cents || qty * unit);
  const isBonus = Boolean(it.is_bonus);
  const titleHtml = `${qty} × ${name}`;
  const subHtml = isBonus
    ? `<span style="font-size:14px;color:${COLOR_INK_3};font-weight:400">Promo bonus — free</span>`
    : `<span style="font-size:14px;color:${COLOR_INK_3};font-weight:400">${escapeHtml(money(unit))} each</span>`;
  const rightHtml = isBonus
    ? `<span style="color:${COLOR_INK_3}">Free</span>`
    : escapeHtml(money(line));
  const topBorder = isFirst ? 'none' : `1px solid ${COLOR_RULE}`;
  return `
<tr>
  <td style="font-family:${FONT_STACK};padding:12px 0;border-top:${topBorder};width:100%;vertical-align:top">
    <div style="font-size:16px;font-weight:600;color:${COLOR_INK_2};line-height:1.4">${titleHtml}</div>
    <div style="margin-top:2px">${subHtml}</div>
  </td>
  <td style="font-family:${FONT_STACK};padding:12px 0;border-top:${topBorder};text-align:right;white-space:nowrap;vertical-align:top">
    <span style="font-size:16px;font-weight:600;color:${COLOR_INK_2}">${rightHtml}</span>
  </td>
</tr>`;
}

function subtotalRowHtml(label, value, { bold, big, color } = {}) {
  const labelColor = bold ? COLOR_PPF_GREEN : COLOR_INK_3;
  const valueColor = color || COLOR_INK_2;
  const labelWeight = bold ? '600' : '400';
  const labelSize = big ? '18px' : '16px';
  const valueSize = big ? '22px' : '16px';
  const valueWeight = bold ? '700' : '600';
  return `
<tr>
  <td style="font-family:${FONT_STACK};padding:4px 0">
    <span style="font-size:${labelSize};color:${labelColor};font-weight:${labelWeight}">${label}</span>
  </td>
  <td style="font-family:${FONT_STACK};padding:4px 0;text-align:right">
    <strong style="font-size:${valueSize};color:${valueColor};font-weight:${valueWeight}">${value}</strong>
  </td>
</tr>`;
}

function customerInfoColHtml(title, bodyHtml) {
  return `
<td class="customer-info__item" style="font-family:${FONT_STACK};padding-bottom:30px;width:50%;vertical-align:top">
  <h4 style="font-weight:500;font-size:16px;color:${COLOR_INK_2};margin:0 0 6px">${title}</h4>
  <div style="color:${COLOR_INK_3};line-height:150%;font-size:16px;margin:0">${bodyHtml}</div>
</td>`;
}

function buildHtml({ order, customer }) {
  const org = customer && customer.organization ? escapeHtml(String(customer.organization).trim()) : null;
  const contact = customer && customer.contact_name ? escapeHtml(String(customer.contact_name).trim()) : null;
  const firstName = customer && customer.first_name ? escapeHtml(String(customer.first_name).trim()) : null;
  const pickupAddress = customer && customer.pickup_address ? escapeHtml(String(customer.pickup_address).trim()) : null;

  const items = Array.isArray(order.items) ? order.items : [];
  const itemsHtml = items.length
    ? items.map((it, i) => itemRowHtml(it, i === 0)).join('')
    : `<tr><td style="font-family:${FONT_STACK};padding:12px 0;font-size:16px;color:${COLOR_INK_3}">(no line items)</td></tr>`;

  // No "Discount" row. The bonus is comped units, not a price cut —
  // rendering a dollar discount frames a gift as a price cut and
  // reads as broken math beside an unchanged Amount due. The `(free)`
  // cell on bonus item rows already tells the customer what happened.
  const subtotalRows = subtotalRowHtml('Subtotal', escapeHtml(money(order.subtotal_cents)));

  const totalRow = `
<table style="width:100%;border-spacing:0;border-collapse:collapse;margin-top:14px;border-top:2px solid ${COLOR_RULE}">
  <tbody>
    <tr>
      <td style="font-family:${FONT_STACK};padding:18px 0 0">
        <span style="font-size:18px;color:${COLOR_PPF_GREEN};font-weight:700">Amount due</span>
      </td>
      <td style="font-family:${FONT_STACK};padding:18px 0 0;text-align:right">
        <strong style="font-size:24px;color:${COLOR_PPF_GREEN};font-weight:700">${escapeHtml(money(order.total_cents))} USD</strong>
      </td>
    </tr>
  </tbody>
</table>`;

  const pickupLines = [];
  if (order.pickup_location) pickupLines.push(escapeHtml(order.pickup_location));
  if (order.pickup_date)     pickupLines.push(escapeHtml(order.pickup_date));
  if (order.pickup_time)     pickupLines.push(escapeHtml(order.pickup_time));
  const pickupHtml = pickupLines.length ? pickupLines.join('<br/>') : '(see invoice for details)';

  const billToLines = [];
  if (org) billToLines.push(`<strong style="color:${COLOR_INK_2}">${org}</strong>`);
  if (contact && contact !== org) billToLines.push(contact);
  else if (firstName && !org) billToLines.push(firstName);
  if (pickupAddress) billToLines.push(pickupAddress);
  const billToHtml = billToLines.length ? billToLines.join('<br/>') : '(see invoice for details)';

  const paymentHtml = renderMarkdown(paymentHelpMd());
  const invNoText = invoiceDisplayNumber(order);
  const logoUrl = `${baseUrl()}/ppf-logo.jpg`;
  const subjectTotal = escapeHtml(money(order.total_cents));

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN" "http://www.w3.org/TR/REC-html40/loose.dtd">
<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width"/>
<title>Your wholesale invoice</title>
<style>
  body { margin: 0; }
  @media (max-width: 600px) {
    .container { width: 94% !important; }
    .shop-name__cell { display: block !important; width: 100% !important; }
    .order-number__cell { display: block !important; text-align: left !important; margin-top: 16px !important; width: 100% !important; }
    .customer-info__item { display: block !important; width: 100% !important; }
    .amount-due-callout { font-size: 20px !important; }
  }
</style>
</head>
<body style="margin:0;background:${COLOR_WHITE};color:${COLOR_INK}">
<table style="width:100%;border-spacing:0;border-collapse:collapse" cellpadding="0" cellspacing="0">
  <tbody><tr><td style="font-family:${FONT_STACK}">

    <!-- Header: logo + invoice number -->
    <table style="width:100%;border-spacing:0;border-collapse:collapse;margin:40px 0 20px" cellpadding="0" cellspacing="0">
      <tbody><tr><td style="font-family:${FONT_STACK}">
        <center>
          <table class="container" style="width:600px;max-width:100%;text-align:left;border-spacing:0;border-collapse:collapse;margin:0 auto" cellpadding="0" cellspacing="0">
            <tbody><tr>
              <td class="shop-name__cell" style="font-family:${FONT_STACK};vertical-align:middle">
                <img src="${logoUrl}" alt="Philly Pretzel Factory" width="160" style="display:block;border:0;outline:none;text-decoration:none"/>
              </td>
              <td class="order-number__cell" style="font-family:${FONT_STACK};text-align:right;text-transform:uppercase;font-size:14px;color:${COLOR_INK_3};vertical-align:middle">
                <span style="font-size:16px;letter-spacing:0.04em">Invoice ${escapeHtml(invNoText)}</span>
              </td>
            </tr></tbody>
          </table>
        </center>
      </td></tr></tbody>
    </table>

    <!-- Content: heading, intro, amount-due callout -->
    <table style="width:100%;border-spacing:0;border-collapse:collapse" cellpadding="0" cellspacing="0">
      <tbody><tr><td style="font-family:${FONT_STACK};padding-bottom:40px">
        <center>
          <table class="container" style="width:600px;max-width:100%;text-align:left;border-spacing:0;border-collapse:collapse;margin:0 auto" cellpadding="0" cellspacing="0">
            <tbody><tr><td style="font-family:${FONT_STACK}">
              <h2 style="font-weight:700;font-size:24px;color:${COLOR_PPF_GREEN};margin:0 0 10px">Thanks for your order — invoice attached.</h2>
              <p style="color:${COLOR_INK_2};line-height:150%;font-size:16px;margin:0 0 20px">
                Your wholesale order is confirmed. The PDF invoice attached to this email is <strong>unpaid</strong> — see <em>Payment</em> below for how to settle it. We'll have your order ready for the pickup date listed.
              </p>

              <!-- Amount-due callout -->
              <table style="width:100%;border-spacing:0;border-collapse:collapse;background:${COLOR_CREAM};border-radius:6px" cellpadding="0" cellspacing="0">
                <tbody><tr>
                  <td style="font-family:${FONT_STACK};padding:18px 22px">
                    <span class="amount-due-callout" style="font-size:14px;color:${COLOR_PPF_GREEN_DEEP};letter-spacing:0.14em;text-transform:uppercase;font-weight:600">Amount due</span>
                    <div class="amount-due-callout" style="font-size:28px;font-weight:700;color:${COLOR_PPF_GREEN};margin-top:4px">${escapeHtml(money(order.total_cents))} <span style="font-size:14px;color:${COLOR_INK_3};font-weight:500;letter-spacing:0.04em">USD</span></div>
                  </td>
                </tr></tbody>
              </table>

            </td></tr></tbody>
          </table>
        </center>
      </td></tr></tbody>
    </table>

    <!-- Order summary -->
    <table style="width:100%;border-spacing:0;border-collapse:collapse;border-top:1px solid ${COLOR_RULE}" cellpadding="0" cellspacing="0">
      <tbody><tr><td style="font-family:${FONT_STACK};padding:30px 0 40px">
        <center>
          <table class="container" style="width:600px;max-width:100%;text-align:left;border-spacing:0;border-collapse:collapse;margin:0 auto" cellpadding="0" cellspacing="0">
            <tbody><tr><td style="font-family:${FONT_STACK}">
              <h3 style="font-weight:600;font-size:20px;color:${COLOR_INK_2};margin:0 0 20px">Order summary</h3>
              <table style="width:100%;border-spacing:0;border-collapse:collapse" cellpadding="0" cellspacing="0">
                <tbody>${itemsHtml}</tbody>
              </table>
              <table style="width:100%;border-spacing:0;border-collapse:collapse;margin-top:16px;border-top:1px solid ${COLOR_RULE};padding-top:12px" cellpadding="0" cellspacing="0">
                <tbody>${subtotalRows}</tbody>
              </table>
              ${totalRow}
            </td></tr></tbody>
          </table>
        </center>
      </td></tr></tbody>
    </table>

    <!-- Pickup + Bill-to columns -->
    <table style="width:100%;border-spacing:0;border-collapse:collapse;border-top:1px solid ${COLOR_RULE}" cellpadding="0" cellspacing="0">
      <tbody><tr><td style="font-family:${FONT_STACK};padding:30px 0 10px">
        <center>
          <table class="container" style="width:600px;max-width:100%;text-align:left;border-spacing:0;border-collapse:collapse;margin:0 auto" cellpadding="0" cellspacing="0">
            <tbody><tr><td style="font-family:${FONT_STACK}">
              <h3 style="font-weight:600;font-size:20px;color:${COLOR_INK_2};margin:0 0 20px">Order details</h3>
              <table style="width:100%;border-spacing:0;border-collapse:collapse" cellpadding="0" cellspacing="0">
                <tbody><tr>
                  ${customerInfoColHtml('Pickup', pickupHtml)}
                  ${customerInfoColHtml('Bill to', billToHtml)}
                </tr></tbody>
              </table>
            </td></tr></tbody>
          </table>
        </center>
      </td></tr></tbody>
    </table>

    <!-- Payment panel (primary CTA) -->
    <table style="width:100%;border-spacing:0;border-collapse:collapse" cellpadding="0" cellspacing="0">
      <tbody><tr><td style="font-family:${FONT_STACK};padding:10px 0 30px">
        <center>
          <table class="container" style="width:600px;max-width:100%;text-align:left;border-spacing:0;border-collapse:collapse;margin:0 auto" cellpadding="0" cellspacing="0">
            <tbody><tr><td style="font-family:${FONT_STACK}">
              <table style="width:100%;border-spacing:0;border-collapse:collapse;border:1px solid ${COLOR_PPF_GREEN};border-radius:6px" cellpadding="0" cellspacing="0">
                <tbody><tr><td style="font-family:${FONT_STACK};padding:20px 22px">
                  <h3 style="font-weight:700;font-size:18px;color:${COLOR_PPF_GREEN};margin:0 0 10px;text-transform:uppercase;letter-spacing:0.08em">Payment</h3>
                  <div style="color:${COLOR_INK_2};line-height:150%;font-size:16px">${paymentHtml}</div>
                </td></tr></tbody>
              </table>
            </td></tr></tbody>
          </table>
        </center>
      </td></tr></tbody>
    </table>

    <!-- Footer -->
    <table style="width:100%;border-spacing:0;border-collapse:collapse;border-top:1px solid ${COLOR_RULE}" cellpadding="0" cellspacing="0">
      <tbody><tr><td style="font-family:${FONT_STACK};padding:30px 0">
        <center>
          <table class="container" style="width:600px;max-width:100%;text-align:left;border-spacing:0;border-collapse:collapse;margin:0 auto" cellpadding="0" cellspacing="0">
            <tbody><tr><td style="font-family:${FONT_STACK}">
              <p style="color:${COLOR_INK_3};line-height:150%;font-size:14px;margin:0">
                Questions? Reply to this email or write to <a href="mailto:mcaiazzoppffs@gmail.com" style="color:${COLOR_PPF_GREEN};text-decoration:none">mcaiazzoppffs@gmail.com</a>.
              </p>
            </td></tr></tbody>
          </table>
        </center>
      </td></tr></tbody>
    </table>

  </td></tr></tbody>
</table>
<!-- subject reference: ${subjectTotal} -->
</body>
</html>`;
}

function renderInvoice({ order, customer }) {
  const bodyMd = buildBody({ order, customer });
  const subject = buildSubject(order);
  const html = buildHtml({ order, customer });
  const text = toPlainText(bodyMd);
  return { subject, bodyMd, html, text };
}

module.exports = { renderInvoice, DEFAULT_PAYMENT_HELP };
