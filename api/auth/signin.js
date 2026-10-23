// POST /api/auth/signin — verify name + PIN against the DB and set a
// session cookie on success. All real auth happens here; the client's
// name picker and PIN pad are just the UX wrapper.
const { supabase, signSession, setSessionCookie } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const pin  = typeof body.pin  === 'string' ? body.pin.trim()  : '';

  // Loose shape check — the real validation is "the hash matches" in the DB.
  if (!name || !/^\d{4,8}$/.test(pin)) {
    return res.status(400).json({ error: 'name and 4-8 digit pin required' });
  }

  try {
    const { data, error } = await supabase().rpc('verify_pin', { p_name: name, p_pin: pin });
    if (error) {
      console.error('verify_pin rpc error:', error);
      return res.status(500).json({ error: 'server error' });
    }
    const row = Array.isArray(data) && data[0];
    if (!row) {
      // Deliberately vague message — don't tell an attacker whether the
      // name exists but the PIN was wrong, or the name doesn't exist.
      return res.status(401).json({ error: 'wrong name or PIN' });
    }
    const token = await signSession({ sub: row.id, name: row.name, role: row.role });
    setSessionCookie(res, token);
    // Starter PIN is 0000 for every seeded account; anyone who signs in
    // with it is on their first login and must rotate before using the
    // app. Checked against the plaintext we just verified — no extra DB
    // column needed. Also catches cases where an operator resets a
    // locked-out user's PIN back to 0000.
    const mustChangePin = pin === '0000';
    return res.status(200).json({ ok: true, name: row.name, role: row.role, mustChangePin });
  } catch (err) {
    console.error('signin error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
