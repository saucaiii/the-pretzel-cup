// /api/time-off
//   GET                    → the signed-in user's own requests (last 20).
//   GET  ?scope=all        → operator-only: all requests from the last 60 days
//                            and anything still pending (whatever its date).
//   POST                   → create a request: date, type ('off'|'cover'), note.
//   PATCH ?id=…            → operator-only: approve or deny a request. Body:
//                            { status: 'approved'|'denied', coverPersonId?: uuid }
const { supabase, requireRole } = require('./_lib/auth');
const auto = require('./_lib/updates');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const sess = await requireRole(req, res, ['baker','driver','operator']);
  if (!sess) return;

  if (req.method === 'GET') {
    const scope = typeof (req.query && req.query.scope) === 'string' ? req.query.scope : '';
    try {
      const sb = supabase();
      if (scope === 'all') {
        if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
        const since = new Date();
        since.setDate(since.getDate() - 60);
        const sinceIso = since.toISOString().slice(0, 10);
        // Everything within the window, plus anything still pending outside
        // the window — the operator shouldn't lose sight of an old open ask.
        const { data, error } = await sb
          .from('time_off_requests')
          .select('id,type,requested_date,note,status,cover_person_id,cover:cover_person_id(name),decided_by,decided_at,created_at,person:person_id(id,name,role)')
          .or(`requested_date.gte.${sinceIso},status.eq.pending`)
          .order('requested_date', { ascending: false })
          .limit(200);
        if (error) throw error;
        return res.status(200).json({ requests: data || [] });
      }
      const { data, error } = await sb
        .from('time_off_requests')
        .select('id,type,requested_date,note,status,cover_person_id,cover:cover_person_id(name),created_at,decided_at')
        .eq('person_id', sess.sub)
        .order('requested_date', { ascending: false })
        .limit(20);
      if (error) throw error;
      return res.status(200).json({ requests: data || [] });
    } catch (err) {
      console.error('time-off GET:', err && (err.stack || err.message || err));
      return res.status(500).json({ error: 'server error' });
    }
  }

  if (req.method === 'PATCH') {
    if (sess.role !== 'operator') return res.status(403).json({ error: 'operator only' });
    const id = typeof (req.query && req.query.id) === 'string' ? req.query.id : '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const body = typeof req.body === 'object' && req.body !== null
      ? req.body
      : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
    const status = body.status;
    if (!['approved','denied'].includes(status)) return res.status(400).json({ error: 'bad status' });
    const coverPersonId = (status === 'approved' && typeof body.coverPersonId === 'string') ? body.coverPersonId : null;
    try {
      const sb = supabase();
      const patch = { status, decided_by: sess.sub, decided_at: new Date().toISOString() };
      if (coverPersonId) patch.cover_person_id = coverPersonId;
      if (status === 'denied') patch.cover_person_id = null;  // clear a prior pick
      const { data, error } = await sb
        .from('time_off_requests')
        .update(patch)
        .eq('id', id)
        .select('id,type,requested_date,status,cover_person_id,cover:cover_person_id(name),decided_at,person:person_id(name,role)')
        .single();
      if (error) throw error;
      // Auto-publish: approvals only (denials stay quiet; the asker sees
      // the status on their own Time Off tab).
      let auto_update = null;
      if (status === 'approved') {
        try {
          const u = await auto.autoTimeOffApproved({
            request: data,
            personName: data.person && data.person.name,
            personRole: data.person && data.person.role,
            coverName: data.cover && data.cover.name,
            postedBy: sess.sub,
          });
          if (u) auto_update = { id: u.id, title: u.title };
        } catch (e) { console.error('auto autoTimeOffApproved:', e); }
      }
      return res.status(200).json({ ok: true, request: data, auto_update });
    } catch (err) {
      console.error('time-off PATCH:', err && (err.stack || err.message || err));
      return res.status(500).json({ error: 'server error' });
    }
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'object' && req.body !== null
      ? req.body
      : (() => { try { return JSON.parse(req.body || '{}'); } catch { return {}; } })();
    const requestedDate = body.requestedDate;
    const type = body.type;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '')) return res.status(400).json({ error: 'bad date' });
    if (!['off','cover'].includes(type)) return res.status(400).json({ error: 'bad type' });

    try {
      const sb = supabase();
      // Reject a duplicate open request for the same date — the UI shouldn't
      // get here but defend anyway.
      const { data: existing } = await sb
        .from('time_off_requests')
        .select('id')
        .eq('person_id', sess.sub)
        .eq('requested_date', requestedDate)
        .in('status', ['pending','approved']);
      if ((existing || []).length > 0) {
        return res.status(409).json({ error: 'already a request for that day' });
      }

      const { data, error } = await sb
        .from('time_off_requests')
        .insert({ person_id: sess.sub, type, requested_date: requestedDate, note })
        .select()
        .single();
      if (error) throw error;

      // Ping operators in Telegram with Approve/Deny buttons. Best-effort —
      // the DB row is saved either way; operators can still handle it on
      // /ops/time-off if the push fails.
      try {
        const tg = require('./_lib/telegram');
        // Look up operator Telegram handles for the @-mention line.
        const { data: ops } = await sb.from('people')
          .select('telegram_handle')
          .eq('role', 'operator')
          .not('telegram_handle', 'is', null);
        const operatorHandles = (ops || []).map(o => o.telegram_handle).filter(Boolean);
        await tg.sendTimeOffRequest({
          request: data,
          personName: sess.name,
          operatorHandles,
        });
      } catch (e) {
        console.error('time-off POST telegram push:', e && (e.message || e));
      }
      return res.status(200).json({ ok: true, request: data });
    } catch (err) {
      console.error('time-off POST:', err && (err.stack || err.message || err));
      return res.status(500).json({ error: 'server error' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: 'method not allowed' });
};
