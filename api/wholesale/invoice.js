// POST /api/wholesale/invoice?o=<order_id>
//
// Operator-gated. Builds an invoice email for a wholesale order and
// either dry-runs it (returns the rendered HTML; nothing sent) or
// live-sends it via Gmail (same sendEmail helper the campaign nurture
// uses) and advances the order's status to 'invoiced'.
//
// Body: { dry_run: true | false }
//
// Mode resolution follows the campaign-sender pattern so operators
// learn one rule:
//   - dry_run !== false     → mode = 'dry_run'
//   - EMAIL_SEND_LIVE_ENABLED !== 'true' → mode = 'dry_run'
//     (response carries `live_disabled_reason` for the UI)
//   - otherwise              → mode = 'live'
//
// On a successful live send, the order's status moves to 'invoiced'
// IF and only if it is currently 'awaiting_payment' — if the operator
// has already advanced it (e.g. clicked "Just mark invoiced" earlier
// or marked paid), the send still counts but the status is left alone
// and the response reports `status_updated: false`.
//
// Response shape:
//   {
//     mode:                'dry_run' | 'live',
//     sent:                boolean,
//     subject:             string,
//     to:                  string,         // destination email
//     status_updated:      boolean,        // true only when we flipped it
//     invoice_number?:     int,            // live only (allocated at CAS)
//     rendered_html?:      string,         // dry_run only
//     rendered_pdf_base64?: string,        // dry_run only — base64 PDF for the modal's Download button
//     live_disabled_reason?: string,       // dry_run only, when flag missing
//     error?:              string,         // live path, when send failed
//   }

const { createClient } = require('@supabase/supabase-js');
const { readSession } = require('../_lib/auth');
const { renderInvoice } = require('../_lib/invoice-template');
const { renderInvoicePdf } = require('../_lib/invoice-pdf');
const { sendEmail } = require('../_lib/gmail');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ─── Auth ───────────────────────────────────────────────────────
  const sess = await readSession(req);
  if (!sess)                    return res.status(401).json({ error: 'not signed in' });
  if (sess.role !== 'operator') return res.status(403).json({ error: 'wrong role' });

  // ─── Order id ──────────────────────────────────────────────────
  const id = (req.query && req.query.o) ? String(req.query.o).trim() : '';
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'order id required' });
  }

  // ─── Load order + customer ─────────────────────────────────────
  const { data: order, error: orderErr } = await sb
    .from('wholesale_orders')
    .select('id, customer_id, status, items, subtotal_cents, discount_cents, total_cents, pickup_location, pickup_date, pickup_time, promo_code, invoice_number')
    .eq('id', id)
    .maybeSingle();
  if (orderErr) return res.status(500).json({ error: 'order lookup failed' });
  if (!order)   return res.status(404).json({ error: 'order not found' });

  const { data: customer, error: custErr } = await sb
    .from('wholesale_customers')
    .select('id, email, first_name, contact_name, organization, pickup_address')
    .eq('id', order.customer_id)
    .maybeSingle();
  if (custErr)   return res.status(500).json({ error: 'customer lookup failed' });
  if (!customer) return res.status(404).json({ error: 'customer not found' });
  if (!customer.email) return res.status(400).json({ error: 'customer has no email' });

  // ─── Render ────────────────────────────────────────────────────
  const { subject, html, text } = renderInvoice({ order, customer });

  // ─── Mode ──────────────────────────────────────────────────────
  const body = await readJsonBody(req);
  const dryRun = body.dry_run !== false;
  const liveEnabled = process.env.EMAIL_SEND_LIVE_ENABLED === 'true';
  const mode = (!dryRun && liveEnabled) ? 'live' : 'dry_run';

  const payload = {
    mode,
    sent: false,
    subject,
    to: customer.email,
    status_updated: false,
  };

  // ─── Dry-run → return rendered HTML + PDF, do nothing else ──────
  if (mode === 'dry_run') {
    payload.rendered_html = html;
    // Preview PDF: use the already-allocated invoice_number if this
    // order was previously invoiced, otherwise show "DRAFT" so the
    // operator sees which number will be stamped on the real send.
    const previewNumber = order.invoice_number != null
      ? String(order.invoice_number)
      : 'DRAFT';
    try {
      const pdfBuf = await renderInvoicePdf({
        order,
        customer,
        invoiceNumber: previewNumber,
        invoiceDate: new Date(),
      });
      payload.rendered_pdf_base64 = pdfBuf.toString('base64');
    } catch (ex) {
      // Don't fail the whole dry-run just because the PDF didn't
      // render — the HTML preview still works. Log the real reason
      // server-side (Vercel captures console.error) and surface a
      // fixed message so pdfkit internals never reach the browser.
      // eslint-disable-next-line no-console
      console.error('wholesale invoice pdf render failed', {
        order_id: id,
        err: String(ex && (ex.message || ex)).slice(0, 300),
      });
      payload.pdf_error = 'PDF preview unavailable';
    }
    if (!liveEnabled && !dryRun) {
      payload.live_disabled_reason = 'EMAIL_SEND_LIVE_ENABLED not set to "true"';
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(payload);
  }

  // ─── Live send ─────────────────────────────────────────────────
  // Invoice sends are only allowed from `awaiting_payment`. The UI
  // disables the "Mark invoiced" entry point for any other status, so
  // reaching this branch past that state means a stale client or a
  // direct API call — in either case a resend is not wanted.
  if (order.status !== 'awaiting_payment') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(409).json({
      ...payload,
      error: `cannot send invoice for order in status "${order.status}"`,
    });
  }

  // Claim the send by flipping status to 'invoiced' BEFORE sendEmail
  // AND allocate (or reuse) an invoice_number in the same statement.
  // Two operators racing both pre-see `awaiting_payment`; the RPC's
  // CAS serializes them so only the winner's email goes out, and the
  // COALESCE on invoice_number means a retry after a send failure
  // picks up the already-allocated number instead of burning a new one.
  // RPC returns 0 rows on CAS miss.
  const invoicedAt = new Date().toISOString();
  const { data: claimRows, error: claimErr } = await sb.rpc('assign_invoice_number', {
    p_order_id:      id,
    p_required_from: 'awaiting_payment',
    p_invoiced_by:   sess.sub,
    p_invoiced_at:   invoicedAt,
  });
  if (claimErr) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ...payload, error: 'claim failed' });
  }
  // RPC returns an array (one row on success, zero on CAS miss).
  const claimed = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!claimed) {
    // Lost the race: either another operator already invoiced, or the
    // order moved further on. No email leaves the server.
    res.setHeader('Cache-Control', 'no-store');
    return res.status(409).json({
      ...payload,
      error: 'invoice send in flight (or already completed) by another operator; refresh and retry',
    });
  }
  const invoiceNumber = claimed.invoice_number;
  payload.invoice_number = invoiceNumber;

  // Render the PDF with the real number. A render failure before
  // sendEmail still rolls back the claim — leaves the number dangling
  // only on the (rare) retry path, which is intentional per the plan.
  let pdfBuf;
  try {
    pdfBuf = await renderInvoicePdf({
      order:         { ...order, invoice_number: invoiceNumber },
      customer,
      invoiceNumber: String(invoiceNumber),
      invoiceDate:   new Date(invoicedAt),
    });
  } catch (pdfErr) {
    await sb
      .from('wholesale_orders')
      .update({ status: 'awaiting_payment', invoiced_at: null, invoiced_by: null })
      .eq('id', id)
      .eq('status', 'invoiced')
      .eq('invoiced_at', invoicedAt);
    const reason = String(pdfErr && (pdfErr.message || pdfErr)).slice(0, 300);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ...payload, sent: false, status_updated: false, error: `pdf render failed: ${reason}` });
  }

  try {
    await sendEmail({
      to:      customer.email,
      subject,
      html,
      text,
      attachments: [{
        filename: `invoice-${invoiceNumber}.pdf`,
        mime:     'application/pdf',
        content:  pdfBuf,
      }],
    });
    payload.sent = true;
    payload.status_updated = true;
  } catch (sendErr) {
    // Roll back the claim so the operator can retry. Only revert if the
    // row is still in our claimed state — if somehow another transition
    // beat us to the row after the send attempt, leave their state alone.
    // IMPORTANT: invoice_number stays set. On retry, the RPC's COALESCE
    // reuses it; no duplicate number is ever issued.
    await sb
      .from('wholesale_orders')
      .update({ status: 'awaiting_payment', invoiced_at: null, invoiced_by: null })
      .eq('id', id)
      .eq('status', 'invoiced')
      .eq('invoiced_at', invoicedAt);
    const reason = String(sendErr && (sendErr.message || sendErr)).slice(0, 300);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ ...payload, sent: false, status_updated: false, error: reason });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(payload);
};
