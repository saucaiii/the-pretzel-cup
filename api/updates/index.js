// GET /api/updates — list of visible updates for the signed-in user,
// most recent first, with ack counts and whether I've acked.
// POST /api/updates — operator posts a new update.
// DELETE /api/updates?id=… — operator removes an update (cascades acks).
//
// Visibility rules:
//   - operator sees everything
//   - baker sees updates whose audience includes 'bakers' or is empty
//   - driver sees updates whose audience includes 'drivers' or is empty
//
// An empty audience array means "all hands".
//
// Compose + delete are folded in here (not their own endpoints) because the
// Vercel Hobby plan caps us at 12 serverless functions.
const { supabase, requireRole } = require('../_lib/auth');
const { postUpdate } = require('../_lib/updates');

const VALID_AUDIENCES = new Set(['bakers', 'drivers']);

async function handlePost(req, res, sess) {
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const title    = typeof body.title === 'string' ? body.title.trim() : '';
  const bodyText = typeof body.body  === 'string' ? body.body.trim()  : '';
  const audience = Array.isArray(body.audience) ? body.audience.filter(a => VALID_AUDIENCES.has(a)) : [];
  const effectiveDate = typeof body.effective_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.effective_date)
    ? body.effective_date : null;
  const requiresAck = body.requires_ack !== false;  // default true
  const claimType = body.claim_type === 'claim' ? 'claim' : null;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
  if (bodyText.length > 4000) return res.status(400).json({ error: 'body too long (max 4000)' });

  try {
    const data = await postUpdate({
      title, body: bodyText || null, audience,
      effectiveDate, requiresAck, postedBy: sess.sub, claimType,
    });
    return res.status(200).json({ ok: true, update: data });
  } catch (err) {
    console.error('updates post error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

async function handleDelete(req, res, sess) {
  const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const sb = supabase();
    const { error } = await sb.from('updates').delete().eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('updates delete error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

// Role → audience-size map used to compute "X of Y confirmed". Kept
// server-side since the real counts live in the DB and we don't want
// to leak the staff roster via the frontend bundle.
async function audienceSizes(sb) {
  const { data, error } = await sb.from('people').select('role');
  if (error) throw error;
  const out = { bakers: 0, drivers: 0, total: data.length };
  for (const row of data) {
    if (row.role === 'baker')  out.bakers++;
    if (row.role === 'driver') out.drivers++;
  }
  return out;
}

function totalForAudience(aud, sizes) {
  if (!aud || aud.length === 0) return sizes.total;      // all hands
  return aud.reduce((a, r) => a + (sizes[r] || 0), 0);
}

async function handleAck(req, res, sess) {
  const body = typeof req.body === 'object' && req.body !== null
    ? req.body
    : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
  const updateId = typeof body.updateId === 'string' ? body.updateId : '';
  if (!updateId) return res.status(400).json({ error: 'updateId required' });
  try {
    const sb = supabase();
    const { error } = await sb.from('update_acks').upsert(
      { update_id: updateId, person_id: sess.sub },
      { onConflict: 'update_id,person_id' },
    );
    if (error) throw error;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('ack error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const action = typeof (req.query && req.query.action) === 'string' ? req.query.action : '';
  if (req.method === 'POST' && action === 'ack') {
    const sess = await requireRole(req, res, ['baker','driver','operator']);
    if (!sess) return;
    return handleAck(req, res, sess);
  }
  if (req.method === 'POST') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    return handlePost(req, res, sess);
  }
  if (req.method === 'DELETE') {
    const sess = await requireRole(req, res, ['operator']);
    if (!sess) return;
    return handleDelete(req, res, sess);
  }
  if (req.method !== 'GET') { res.setHeader('Allow','GET, POST, DELETE'); return res.status(405).json({error:'method not allowed'}); }
  const sess = await requireRole(req, res, ['baker','driver','operator']);
  if (!sess) return;

  try {
    const sb = supabase();
    const [{ data: all, error: ue }, sizes] = await Promise.all([
      sb.from('updates').select('*').order('posted_at', { ascending: false }).limit(60),
      audienceSizes(sb),
    ]);
    if (ue) throw ue;

    const myAudience = sess.role === 'operator' ? null : (sess.role + 's');
    const visible = (all || []).filter(u => {
      const aud = u.audience || [];
      if (myAudience === null) return true;      // operator sees everything
      if (aud.length === 0) return true;         // all hands
      return aud.includes(myAudience);
    });

    const ids = visible.map(u => u.id);
    let countMap = {};
    let myAcks = new Set();
    if (ids.length) {
      const [{ data: counts }, { data: mine }] = await Promise.all([
        sb.from('update_acks').select('update_id').in('update_id', ids),
        sb.from('update_acks').select('update_id').in('update_id', ids).eq('person_id', sess.sub),
      ]);
      (counts || []).forEach(a => { countMap[a.update_id] = (countMap[a.update_id] || 0) + 1; });
      myAcks = new Set((mine || []).map(a => a.update_id));
    }

    // Resolve claimer names in bulk for claim-type updates.
    const claimerIds = Array.from(new Set(visible.map(u => u.claimed_by).filter(Boolean)));
    const claimerById = Object.create(null);
    if (claimerIds.length) {
      const { data: claimers } = await sb.from('people').select('id,name').in('id', claimerIds);
      (claimers || []).forEach(p => { claimerById[p.id] = p.name; });
    }

    const out = visible.map(u => ({
      id: u.id,
      title: u.title,
      body: u.body,
      audience: u.audience || [],
      effective_date: u.effective_date,
      posted_at: u.posted_at,
      requires_ack: u.requires_ack,
      claim_type: u.claim_type || null,
      claimed_by: u.claimed_by || null,
      claimed_by_name: u.claimed_by ? (claimerById[u.claimed_by] || null) : null,
      claimed_at: u.claimed_at || null,
      ack_count: countMap[u.id] || 0,
      ack_total: totalForAudience(u.audience || [], sizes),
      my_ack: myAcks.has(u.id),
    }));

    return res.status(200).json({ updates: out });
  } catch (err) {
    console.error('updates error:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'server error' });
  }
};
