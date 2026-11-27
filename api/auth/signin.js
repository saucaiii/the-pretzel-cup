// /api/auth/signin — two shapes:
//   GET   → returns the public staff roster { people: [{name, role}] } so
//           the signin page can render its name picker from the DB
//           instead of a hardcoded list that keeps falling behind. Only
//           name + role leave the server; PINs, telegram ids, uuids stay
//           server-side.
//   POST  → verifies name + PIN and sets the session cookie. Dual-role
//           flow: if the person has a secondary_role, the first POST
//           (no chosen_role) returns { choose: true, roles: [...] }
//           without a cookie; the client re-POSTs with chosen_role and
//           the server signs the JWT with that role. First-login (0000)
//           skips the chooser so PIN rotation happens first.
const { supabase, signSession, setSessionCookie } = require('../_lib/auth');

const VALID_ROLES = ['operator', 'baker', 'driver'];
// Roster order on the picker: operators first, then bakers, then drivers.
// Within a role, oldest row first so longstanding staff stay in place.
const ROLE_ORDER = { operator: 0, baker: 1, driver: 2 };

async function handleRoster(res) {
  try {
    const { data, error } = await supabase()
      .from('people')
      .select('name, role, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    const people = (data || [])
      .slice()
      .sort((a, b) => {
        const r = (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9);
        if (r !== 0) return r;
        return String(a.created_at).localeCompare(String(b.created_at));
      })
      .map(p => ({ name: p.name, role: p.role }));
    return res.status(200).json({ people });
  } catch (err) {
    console.error('signin roster error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return handleRoster(res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const pin  = typeof body.pin  === 'string' ? body.pin.trim()  : '';
  const chosenRole = typeof body.chosen_role === 'string' ? body.chosen_role.trim() : '';

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

    const mustChangePin = pin === '0000';
    const roles = [row.role];
    if (row.secondary_role && row.secondary_role !== row.role) {
      roles.push(row.secondary_role);
    }

    // Dual-role branch: ask the client to pick which role to sign in as.
    // Skipped on first-login (0000) so PIN rotation happens before any
    // dashboard loads.
    if (roles.length > 1 && !mustChangePin && !chosenRole) {
      return res.status(200).json({
        ok: true,
        choose: true,
        name: row.name,
        roles,
      });
    }

    // Validate the chosen role if one was supplied.
    let effectiveRole = row.role;
    if (chosenRole) {
      if (!VALID_ROLES.includes(chosenRole) || !roles.includes(chosenRole)) {
        return res.status(400).json({ error: 'invalid role for this user' });
      }
      effectiveRole = chosenRole;
    }

    const token = await signSession({ sub: row.id, name: row.name, role: effectiveRole });
    setSessionCookie(res, token);
    // Starter PIN is 0000 for every seeded account; anyone who signs in
    // with it is on their first login and must rotate before using the
    // app. Checked against the plaintext we just verified — no extra DB
    // column needed. Also catches cases where an operator resets a
    // locked-out user's PIN back to 0000.
    return res.status(200).json({ ok: true, name: row.name, role: effectiveRole, mustChangePin });
  } catch (err) {
    console.error('signin error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
