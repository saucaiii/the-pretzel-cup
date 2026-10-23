// ─────────────────────────────────────────────────────────────
// Shared auth + Supabase helpers for /api routes.
//
// We do NOT use Supabase Auth. Instead:
//   1. /api/auth/signin verifies name + PIN against the DB via the
//      verify_pin RPC (bcrypt check in Postgres).
//   2. On success it mints an app JWT (HS256, APP_JWT_SECRET) and
//      sets an httpOnly cookie called `ppf_session`.
//   3. Any /api route that needs auth imports requireRole() from
//      here. The cookie is the only trusted session carrier.
//
// All DB writes/reads server-side use the SERVICE_ROLE key, which
// bypasses RLS. The schema's RLS is deny-all, so direct anon-key
// access from the browser leaks nothing even if the key were exposed.
// ─────────────────────────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');
const { SignJWT, jwtVerify } = require('jose');

const COOKIE_NAME = 'ppf_session';
const JWT_ALG = 'HS256';
// 30 days — operator rotates PINs rarely; convenient for drivers on the road.
const SESSION_SECONDS = 60 * 60 * 24 * 30;

let _supabase = null;
function supabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

function secretKey() {
  const s = process.env.APP_JWT_SECRET;
  if (!s) throw new Error('APP_JWT_SECRET missing');
  return new TextEncoder().encode(s);
}

async function signSession({ sub, name, role }) {
  return await new SignJWT({ name, role })
    .setProtectedHeader({ alg: JWT_ALG })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_SECONDS)
    .sign(secretKey());
}

async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: [JWT_ALG] });
    return payload;
  } catch { return null; }
}

// Parse the raw Cookie header into a plain {name:value} object.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

async function readSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return null;
  return await verifySession(token);
}

function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_SECONDS}`,
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// Guard helper used by every /api route that needs auth.
// Returns the session payload on success, or false (and writes a 401)
// on failure. `roles` is an array like ['operator'] or ['operator','baker'].
async function requireRole(req, res, roles) {
  const sess = await readSession(req);
  if (!sess) {
    res.status(401).json({ error: 'not signed in' });
    return false;
  }
  if (roles && roles.length && !roles.includes(sess.role)) {
    res.status(403).json({ error: 'wrong role' });
    return false;
  }
  return sess;
}

module.exports = {
  COOKIE_NAME,
  supabase,
  signSession,
  verifySession,
  readSession,
  setSessionCookie,
  clearSessionCookie,
  requireRole,
};
