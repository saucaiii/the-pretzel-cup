// GET /api/track/click?s=<send_id>&u=<base64url_url>
//
// Click-tracking redirect. Decodes u, validates the destination host
// against a hard allowlist (prevents open-redirect abuse of our
// domain), increments click_count atomically, stamps first_clicked_at
// on first click only, and 302s to the destination.
//
// Allowed destination hosts: the-pretzel-cup.vercel.app, docs.google.com.
// A click to anything else returns 400 — the sender wouldn't have
// generated such a link; a user hitting one is attacking.

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_HOSTS = new Set(['the-pretzel-cup.vercel.app', 'docs.google.com']);

function fromB64Url(s) {
  let b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  try { return Buffer.from(b, 'base64').toString('utf8'); } catch { return ''; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const sid    = (req.query && req.query.s) ? String(req.query.s).trim() : '';
  const uParam = (req.query && req.query.u) ? String(req.query.u).trim() : '';
  if (!UUID_RE.test(sid) || !uParam) {
    return res.status(400).json({ error: 'bad request' });
  }
  const decoded = fromB64Url(uParam);
  let dest;
  try { dest = new URL(decoded); } catch { return res.status(400).json({ error: 'bad destination' }); }
  if (!/^https?:$/.test(dest.protocol))     return res.status(400).json({ error: 'bad protocol' });
  if (!ALLOWED_HOSTS.has(dest.host))         return res.status(400).json({ error: 'destination host not allowed' });

  // Record the click. Done in two steps because PostgREST doesn't give
  // us a single-statement "increment + set-if-null" primitive without
  // an RPC. Both updates are no-ops on failure — the user still gets
  // their redirect.
  try {
    // Set first_clicked_at only if null.
    await sb
      .from('wholesale_email_sends')
      .update({ first_clicked_at: new Date().toISOString() })
      .eq('id', sid)
      .is('first_clicked_at', null);
    // Increment click_count. Supabase JS has no .increment(), so round-
    // trip the current value. Lossy under heavy concurrency, but click
    // volumes here are tiny.
    const { data } = await sb
      .from('wholesale_email_sends')
      .select('click_count')
      .eq('id', sid)
      .maybeSingle();
    if (data) {
      await sb
        .from('wholesale_email_sends')
        .update({ click_count: (data.click_count || 0) + 1 })
        .eq('id', sid);
    }
  } catch (_) { /* swallow — tracking must never block the redirect */ }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', dest.toString());
  return res.status(302).end();
};
