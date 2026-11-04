// Invoice template for wholesale orders.
//
// Pure function: `renderInvoice({ order, customer })` returns
// `{ subject, bodyMd, html, text }`.
//
// Rendering goes through the same markdown helper the campaign sender
// uses (api/_lib/md.js) so email-client rendering is consistent with
// the nurture sends. The payment-instructions block is operator
// configurable via env `WHOLESALE_INVOICE_PAYMENT_HELP` (free-form
// markdown); default literal is a conservative "we'll follow up"
// message so an unconfigured install never implies wire details that
// aren't there.
//
// Raw user-supplied fields (customer first name, pickup text, item
// name) flow into the markdown AFTER escapeHtml — see buildBody
// below — so a hostile value cannot smuggle markup into the HTML.

const { renderMarkdown, escapeHtml } = require('./md');

const DEFAULT_PAYMENT_HELP =
  "We'll follow up with payment details shortly.";

function money(cents) {
  const n = Math.max(0, Math.round(Number(cents || 0)));
  return `$${(n / 100).toFixed(2)}`;
}

function paymentHelpMd() {
  const raw = process.env.WHOLESALE_INVOICE_PAYMENT_HELP;
  const s = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_PAYMENT_HELP;
  return s;
}

// Break the markdown link syntax `[label](url)` in customer-sourced
// strings. escapeHtml in md.js runs BEFORE the link regex, but `[ ] ( )`
// aren't HTML-special so they survive escape and can still form an
// anchor via a crafted `first_name` / `organization` / item name. The
// scheme allowlist prevents javascript:/data: so this isn't XSS, but
// it would let a hostile customer put a live external link into an
// invoice they themselves receive. Replace just the `](` joiner with
// `) (` — enough to kill link syntax while barely touching readable
// names (e.g. "Store (NYC)" stays intact).
function mdSafe(s) {
  return String(s == null ? '' : s).replace(/\]\(/g, ') (');
}

// Each line item becomes a markdown list row. Bonus items (is_bonus +
// $0 unit) are tagged "(free)" so operator and customer both see the
// 100-for-25 math the same way. Item name comes from
// wholesale_products.name server-side, but goes through mdSafe anyway
// for defense in depth.
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
  const discount = money(order.discount_cents);
  const promo = order.promo_code ? ` (${mdSafe(order.promo_code)})` : '';

  // Markdown body. Line order:
  //   greeting, intro, items list, totals, pickup, payment help, sig.
  // All templated values that came from user input are escaped by the
  // renderer's escapeHtml step before being wrapped in markup; the
  // greeting + org fields are added raw to the markdown string and
  // escaped on render. No merge-field substitution — the operator
  // sees exactly what the customer will see.
  const lines = [
    `Hi ${greetingName},`,
    '',
    org
      ? `Thanks for your wholesale order for **${org}**. Here are the details:`
      : 'Thanks for your wholesale order. Here are the details:',
    '',
    '### Order',
    itemsMd,
    '',
    `Subtotal: ${subtotal}`,
    '',
    ...(Number(order.discount_cents) > 0
      ? [`Discount: ${discount}${promo}`, '']
      : []),
    `**Total due: ${total}**`,
    '',
  ];
  if (pickup) {
    lines.push('### Pickup', pickup, '');
  }
  lines.push('### Payment', paymentHelpMd(), '', '— Philly Pretzel Factory');
  return lines.join('\n');
}

// Minimal plain-text version. Same trick as campaigns/send.js: strip
// bold / italic markers; markdown already reads as plain text.
function toPlainText(bodyMd) {
  return String(bodyMd)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1');
}

function buildSubject(order) {
  const total = money(order.total_cents);
  return `Your Philly Pretzel Factory wholesale invoice — ${total}`;
}

function renderInvoice({ order, customer }) {
  const bodyMd = buildBody({ order, customer });
  const subject = buildSubject(order);
  const html = renderMarkdown(bodyMd);
  const text = toPlainText(bodyMd);
  return { subject, bodyMd, html, text };
}

module.exports = { renderInvoice, DEFAULT_PAYMENT_HELP };
