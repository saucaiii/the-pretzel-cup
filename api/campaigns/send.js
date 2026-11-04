// POST /api/campaigns/send
//
// Internal campaign sender. Not customer-facing. Authenticated with
// CRON_SECRET so only the operator (or a scheduled task) can call it.
//
// Body:    { campaign_slug: string, email_position: int }
// Query:   dry_run=true (default) | dry_run=false
// Header:  Authorization: Bearer $CRON_SECRET
//
// Live sends are gated by two things:
//   1. dry_run=false in the query, AND
//   2. EMAIL_SEND_LIVE_ENABLED=true in the environment.
//
// If either is missing, no email leaves the server. The dry_run path
// still inserts wholesale_email_sends rows (sent_at=null,
// notes='dry_run') so the operator can see what the send would do.
// A later live run upgrades those dry_run rows in place.
//
// Idempotency per (campaign_email, customer): UNIQUE constraint in
// the schema. The handler skips any send row already written as live.
//
// Response:
//   {
//     mode: 'dry_run' | 'live',
//     eligible: int,         // customers that match the "no live send yet" filter
//     sent: int,             // actually sent (live) OR dry rows written
//     skipped: int,          // already sent / already queued (dry-run)
//     errors: [{ customer_id, reason }],
//     sample_html?: string,  // only in dry_run — rendered HTML for the first customer
//     sample_text?: string,
//   }

const { createClient } = require('@supabase/supabase-js');
const { renderMarkdown, mergeFields, escapeHtml } = require('../_lib/md');
const { sendEmail } = require('../_lib/gmail');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// Hosts whose links we rewrite through track/click. Hard allowlist —
// anything else in the message body stays as-is (and will not be
// clickable via our redirect; the raw URL still goes through, but
// without tracking). The click endpoint re-checks this on redirect.
const TRACKED_HOSTS = new Set(['the-pretzel-cup.vercel.app', 'docs.google.com']);

function baseUrl() {
  if (process.env.WHOLESALE_BASE_URL) return process.env.WHOLESALE_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_URL)         return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Known store addresses — used as a fallback when a customer has no
// recorded pickup_address, so the nurture templates don't render as
// "at Lynbrook ()" with an empty parenthetical.
const STORE_ADDR = {
  'Lynbrook':        '118 Broadway, Lynbrook',
  'Franklin Square': '197 Franklin Ave, Franklin Square',
};

function fieldsFor(customer) {
  const loc = customer.pickup_location || '';
  return {
    first_name:      customer.first_name      || 'there',
    organization:    customer.organization    || 'your team',
    pickup_location: loc || 'Franklin Square or Lynbrook',
    pickup_address:  customer.pickup_address  || STORE_ADDR[loc] || '118 Broadway, Lynbrook',
  };
}

// Rewrite every <a href="…"> and <img src="…"> in rendered HTML:
//   - <a> whose destination host is in TRACKED_HOSTS → wrap through track/click
//   - <img> is left alone except the tracking pixel we add last
// The browser treats the markup as HTML, so we match on attribute
// text — the markdown renderer always emits double-quoted hrefs.
function rewriteLinks(html, { base, sendId }) {
  return html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>/gi, (m, pre, href, post) => {
    let host;
    try { host = new URL(href, base).host; } catch { return m; }
    if (!TRACKED_HOSTS.has(host)) return m;
    const tracked = `${base}/api/track/click?s=${encodeURIComponent(sendId)}&u=${b64url(href)}`;
    return `<a ${pre}href="${tracked}"${post}>`;
  });
}

function buildHtml({ bodyMd, fields, ctaLabel, ctaHref, trackPixelUrl, sendId, base }) {
  const bodyFilled = mergeFields(bodyMd, fields);
  let html = renderMarkdown(bodyFilled);
  // CTA button appended under the body. Styled inline — email clients
  // don't honor external stylesheets reliably.
  if (ctaLabel && ctaHref) {
    html += `\n<p style="margin:28px 0 24px"><a href="${escapeHtml(ctaHref)}" style="display:inline-block;background:#0D5237;color:#ffffff;text-decoration:none;padding:14px 22px;border-radius:8px;font-family:'Helvetica Neue',Arial,sans-serif;font-weight:600;letter-spacing:0.02em">${escapeHtml(ctaLabel)}</a></p>`;
  }
  // Rewrite any allowlisted links (including the CTA just added).
  html = rewriteLinks(html, { base, sendId });
  // Append the open pixel last so it's at end-of-body.
  html += `\n<img src="${escapeHtml(trackPixelUrl)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0" />`;
  return html;
}

// Minimal plain-text version — strip bold/italic markers but keep the
// text otherwise intact. Markdown already reads as plain text.
function toPlainText(bodyMd, ctaLabel, ctaHref) {
  let s = String(bodyMd);
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  if (ctaLabel && ctaHref) s += `\n\n${ctaLabel}: ${ctaHref}\n`;
  return s;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // ─── Auth ───────────────────────────────────────────────────────
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(500).json({ error: 'CRON_SECRET not set' });
  const auth = String(req.headers.authorization || '');
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ─── Body / mode ────────────────────────────────────────────────
  const body = (typeof req.body === 'object' && req.body !== null)
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const slug = String(body.campaign_slug || '').trim();
  const position = Number.parseInt(body.email_position, 10);
  if (!slug) return res.status(400).json({ error: 'campaign_slug required' });
  if (!Number.isFinite(position) || position < 1) {
    return res.status(400).json({ error: 'email_position (>=1) required' });
  }

  const dryRunParam = String((req.query && req.query.dry_run) ?? 'true').toLowerCase();
  const liveEnabled = process.env.EMAIL_SEND_LIVE_ENABLED === 'true';
  const mode = (dryRunParam === 'false' && liveEnabled) ? 'live' : 'dry_run';

  // ─── Resolve campaign + email ───────────────────────────────────
  const { data: camp, error: campErr } = await sb
    .from('wholesale_campaigns').select('id').eq('slug', slug).maybeSingle();
  if (campErr || !camp) return res.status(404).json({ error: 'campaign not found' });

  const { data: email, error: emailErr } = await sb
    .from('wholesale_campaign_emails')
    .select('id, position, subject, preheader, body_md, cta_label, cta_src, promo_code')
    .eq('campaign_id', camp.id)
    .eq('position', position)
    .maybeSingle();
  if (emailErr || !email) return res.status(404).json({ error: 'campaign email not found' });

  // ─── Load customers + existing send rows for this email ─────────
  const { data: customers, error: custErr } = await sb
    .from('wholesale_customers')
    .select('id, email, first_name, organization, pickup_location, pickup_address')
    .order('created_at', { ascending: true });
  if (custErr) return res.status(500).json({ error: 'customers lookup failed' });

  const { data: existing, error: exErr } = await sb
    .from('wholesale_email_sends')
    .select('id, customer_id, sent_at, notes')
    .eq('campaign_email_id', email.id);
  if (exErr) return res.status(500).json({ error: 'existing sends lookup failed' });

  const existingByCust = new Map();
  for (const row of existing) existingByCust.set(row.customer_id, row);

  // ─── Walk customers ─────────────────────────────────────────────
  const base = baseUrl();
  const result = { mode, eligible: 0, sent: 0, skipped: 0, errors: [] };
  let sampleHtml = null;
  let sampleText = null;

  for (const c of customers) {
    const prev = existingByCust.get(c.id);
    // Already live-sent → skip.
    if (prev && prev.sent_at) { result.skipped++; continue; }
    result.eligible++;

    // Build message (same for dry-run and live; we need the send id
    // for tracking links, so we insert the row first if there isn't
    // one, then build the HTML with that id).
    let sendId;
    try {
      if (prev) {
        sendId = prev.id;
      } else {
        const { data: ins, error: insErr } = await sb
          .from('wholesale_email_sends')
          .insert([{
            campaign_email_id: email.id,
            customer_id: c.id,
            notes: mode === 'dry_run' ? 'dry_run' : null,
          }])
          .select('id')
          .single();
        if (insErr) throw insErr;
        sendId = ins.id;
      }

      const fields = fieldsFor(c);
      const ctaHref = `${base}/wholesale/?contact=${encodeURIComponent(c.id)}&src=${encodeURIComponent(email.cta_src || '')}`;
      const trackPixel = `${base}/api/track/open?s=${encodeURIComponent(sendId)}`;
      const html = buildHtml({
        bodyMd: email.body_md,
        fields,
        ctaLabel: email.cta_label,
        ctaHref,
        trackPixelUrl: trackPixel,
        sendId,
        base,
      });
      const text = toPlainText(mergeFields(email.body_md, fields), email.cta_label, ctaHref);
      if (!sampleHtml) { sampleHtml = html; sampleText = text; }

      if (mode === 'live') {
        try {
          await sendEmail({
            to: c.email,
            subject: email.subject,
            html,
            text,
            preheader: email.preheader,
          });
          const { error: upErr } = await sb
            .from('wholesale_email_sends')
            .update({ sent_at: new Date().toISOString(), notes: null })
            .eq('id', sendId);
          if (upErr) throw upErr;
          result.sent++;
        } catch (sendErr) {
          const reason = String(sendErr && (sendErr.message || sendErr)).slice(0, 300);
          await sb.from('wholesale_email_sends')
            .update({ bounced_at: new Date().toISOString(), notes: reason })
            .eq('id', sendId);
          result.errors.push({ customer_id: c.id, reason });
        }
      } else {
        result.sent++;  // "sent" counts dry-run queued rows too
      }
    } catch (ex) {
      const reason = String(ex && (ex.message || ex)).slice(0, 300);
      result.errors.push({ customer_id: c.id, reason });
    }
  }

  if (mode === 'dry_run') {
    result.sample_html = sampleHtml;
    result.sample_text = sampleText;
    if (!liveEnabled) result.live_disabled_reason = 'EMAIL_SEND_LIVE_ENABLED not set to "true"';
  }
  return res.status(200).json(result);
};
