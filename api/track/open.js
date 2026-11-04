// GET /api/track/open?s=<send_id>
//
// Open-tracking pixel. Records opened_at on the FIRST hit only (SQL
// COALESCE in the update WHERE), so repeat opens from the recipient's
// mail client previewing the message don't overwrite the first open.
//
// Returns a 1x1 transparent GIF with Cache-Control: no-store so mail
// clients re-fetch (and we see each open event — though many clients
// will cache anyway, which is why we only trust the FIRST hit).

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// 43-byte 1x1 transparent GIF.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sendPixel(res) {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', String(PIXEL.length));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.status(200).end(PIXEL);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const sid = (req.query && req.query.s) ? String(req.query.s).trim() : '';
  if (!UUID_RE.test(sid)) {
    // Bad id → still return the pixel so the mail client renders
    // nothing visible. 200 avoids spam of broken-image icons.
    return sendPixel(res);
  }
  try {
    // Only set opened_at if it's currently null. .is('opened_at', null)
    // means we never overwrite a prior open — the FIRST open wins.
    await sb
      .from('wholesale_email_sends')
      .update({ opened_at: new Date().toISOString() })
      .eq('id', sid)
      .is('opened_at', null);
  } catch (_) { /* swallow — tracking must never block the pixel */ }
  return sendPixel(res);
};
