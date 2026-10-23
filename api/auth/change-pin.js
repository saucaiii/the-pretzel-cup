// POST /api/auth/change-pin — self-service PIN rotation.
// Session cookie proves identity (user already signed in with their old
// PIN or with the starter 0000). Body: { newPin: "1234" }.
// New PIN rules: 4-6 digits, not 0000. Keeping it minimal — the point
// is to get people off the shared starter immediately, not to enforce
// a strong-password policy for a 4-digit PIN.
const { supabase, requireRole } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Any signed-in role can rotate their own PIN.
  const sess = await requireRole(req, res, ['operator', 'baker', 'driver']);
  if (!sess) return;

  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const newPin = typeof body.newPin === 'string' ? body.newPin.trim() : '';
  if (!/^\d{4,6}$/.test(newPin)) {
    return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  }
  if (newPin === '0000') {
    return res.status(400).json({ error: 'PIN cannot be 0000' });
  }

  try {
    // Use the DB's crypt() + gen_salt() so we never hold the plaintext
    // in Node memory any longer than this request.
    const { data, error } = await supabase().rpc('set_pin', { p_person_id: sess.sub, p_new_pin: newPin });
    if (error) {
      console.error('set_pin rpc error:', error);
      return res.status(500).json({ error: 'server error' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('change-pin error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
