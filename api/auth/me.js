// GET  /api/auth/me — returns { name, role, sub } from the session cookie,
//                     or 401. Used by every page's boot script to decide
//                     whether to render the app or redirect to /signin.
// POST /api/auth/me — clears the session cookie. Idempotent, 200 even if
//                     the user wasn't signed in. (Was /api/auth/signout.js;
//                     folded in here to stay under the Vercel Hobby 12-fn cap.)
const { readSession, clearSessionCookie } = require('../_lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'POST') {
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  }
  if (req.method === 'GET') {
    const sess = await readSession(req);
    if (!sess) return res.status(401).json({ error: 'not signed in' });
    return res.status(200).json({ name: sess.name, role: sess.role, sub: sess.sub });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method not allowed' });
};
