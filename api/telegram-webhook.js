// POST /api/telegram-webhook
//
// Receives Telegram updates (callback_query taps on the "Got it" button).
// Protected via the X-Telegram-Bot-Api-Secret-Token header which must
// equal TELEGRAM_WEBHOOK_SECRET. The secret is set once with setWebhook
// (see scripts/telegram-set-webhook.sh for the one-off command).
//
// We only handle `callback_query`. Other update types (messages,
// edits, member events) are 200'd and ignored so Telegram doesn't retry.
const { supabase } = require('./_lib/auth');
const tg = require('./_lib/telegram');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'method not allowed' }); }
  if (!tg.verifyWebhookSecret(req)) return res.status(401).json({ error: 'bad secret' });

  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  try {
    if (body.callback_query) {
      const sb = supabase();
      const result = await tg.handleCallback(sb, body.callback_query);
      return res.status(200).json(result);
    }
    // Everything else: ignore quietly so Telegram marks it delivered.
    return res.status(200).json({ ok: true, skipped: true });
  } catch (err) {
    console.error('telegram-webhook error:', err && (err.stack || err.message || err));
    // Still 200 so Telegram doesn't retry a definitively-broken event.
    return res.status(200).json({ ok: false, error: 'handler threw' });
  }
};
