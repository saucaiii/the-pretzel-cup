// Single write path for the Updates feed.
//
// Every row that lands in `public.updates` — manual or auto — must come
// through postUpdate(). This is the one place Telegram will later hook
// into (one function instead of five). The `telegram_message_ids`
// column on updates is reserved for that.
//
// Auto-publish helpers (newStop/dropChanged/stopDeactivated/...) format
// the title + body + audience from the raw change and delegate here.

const { supabase } = require('./auth');

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDays = days => (days || []).slice().sort((a,b)=>a-b).map(d => DOW_SHORT[d]).join(' ');
const fmtDate = iso => iso
  ? new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  : '';

async function postUpdate({ title, body, audience, requiresAck, postedBy, effectiveDate, claimType }) {
  if (!title) throw new Error('postUpdate: title required');
  // Claim-type updates have their own flow (first-tap wins). Ack is
  // automatically off for claims so the two paths don't collide.
  const claim = claimType === 'claim' ? 'claim' : null;
  const ack = claim ? false : (requiresAck !== false);
  const sb = supabase();
  const { data, error } = await sb.from('updates').insert({
    title: title.slice(0, 200),
    body: body ? body.slice(0, 4000) : null,
    audience: Array.isArray(audience) ? audience : [],
    effective_date: effectiveDate || null,
    posted_by: postedBy || null,
    requires_ack: ack,
    claim_type: claim,
  }).select().single();
  if (error) throw error;

  // Telegram push — best-effort. If it fails, the DB row still exists
  // and bakers/drivers still see the update in-app; the sheet writer
  // is unaffected. We log the message_id so a future ack can edit the
  // message to show the check mark.
  try {
    const tg = require('./telegram');
    const mentions = await mentionHandlesFor(sb, Array.isArray(audience) ? audience : []);
    const sent = await tg.sendUpdate(data, mentions);
    if (sent && sent.message_id) {
      await sb.from('updates')
        .update({ telegram_message_ids: { chat_id: sent.chat_id, message_id: sent.message_id } })
        .eq('id', data.id);
      data.telegram_message_ids = { chat_id: sent.chat_id, message_id: sent.message_id };
    }
  } catch (e) {
    console.error('postUpdate telegram push:', e && (e.message || e));
  }
  return data;
}

// Look up Telegram @handles for the audience of an update. Empty audience
// (all-hands) pings everyone with a handle on file.
async function mentionHandlesFor(sb, audience) {
  const roleQuery = sb.from('people')
    .select('telegram_handle,role')
    .not('telegram_handle', 'is', null);
  if (audience.length > 0) {
    // 'bakers' → role=baker, 'drivers' → role=driver
    const roles = audience.map(a => a === 'bakers' ? 'baker' : a === 'drivers' ? 'driver' : null).filter(Boolean);
    if (roles.length === 0) return [];
    roleQuery.in('role', roles);
  }
  const { data } = await roleQuery;
  return (data || []).map(r => r.telegram_handle).filter(Boolean);
}

// ─── Auto-publish helpers ──────────────────────────────────────────
// Each takes the raw Supabase row(s) and the acting operator's uuid.

async function autoNewStop({ stop, postedBy }) {
  return postUpdate({
    title: `New stop added: ${stop.name} (${stop.route_key})`,
    body: [
      stop.address ? `Address: ${stop.address}` : `Town: ${stop.town}`,
      `Drop: ${stop.singles_drop} singles / ${stop.doubles_drop} doubles`,
      stop.basket ? `Basket: ${stop.basket}` : null,
      stop.note ? `Note: ${stop.note}` : null,
    ].filter(Boolean).join('\n'),
    audience: [],  // all-hands: drivers deliver, bakers bake
    requiresAck: true,
    postedBy,
  });
}

async function autoStopActiveChanged({ stop, nowActive, postedBy }) {
  return postUpdate({
    title: nowActive
      ? `Stop reactivated: ${stop.name} (${stop.route_key})`
      : `Stop deactivated: ${stop.name} (${stop.route_key})`,
    body: nowActive
      ? `Resuming deliveries. Drop: ${stop.singles_drop}/${stop.doubles_drop}.`
      : `No longer delivering to this stop. Skip on routes.`,
    audience: [],
    requiresAck: true,
    postedBy,
  });
}

async function autoDropChanged({ stop, before, after, postedBy }) {
  // "after" has the already-updated fields; "before" is the pre-patch snapshot.
  const changes = [];
  const diff = (lbl, b, a) => { if (b !== a) changes.push(`${lbl}: ${b} → ${a}`); };
  diff('Singles',     before.singles_drop,       after.singles_drop);
  diff('Doubles',     before.doubles_drop,       after.doubles_drop);
  diff('Wknd singles', before.singles_drop_wknd ?? '—', after.singles_drop_wknd ?? '—');
  diff('Wknd doubles', before.doubles_drop_wknd ?? '—', after.doubles_drop_wknd ?? '—');
  if (!changes.length) return null;
  return postUpdate({
    title: `Drop size changed: ${after.name} (${after.route_key})`,
    body: changes.join('\n'),
    audience: [],
    requiresAck: true,
    postedBy,
  });
}

async function autoShortsChanged({ stop, nowShorts, postedBy }) {
  // Fired when a stop's shorts flag flips. Baker needs to know how many
  // to pull short (or stop pulling short); driver needs to know which bag
  // to deliver to this stop.
  return postUpdate({
    title: nowShorts
      ? `SHORTS flag ON: ${stop.name} (${stop.route_key})`
      : `SHORTS flag OFF: ${stop.name} (${stop.route_key})`,
    body: nowShorts
      ? [
          `${stop.name} (${stop.town}) now gets SHORT pretzels.`,
          `Drop: ${stop.singles_drop} singles / ${stop.doubles_drop} doubles — all baked short.`,
          `Baker: pull short at the Lynbrook bakery (only one that bakes shorts).`,
          `Driver: grab the SHORTS bag for this stop before heading out.`,
        ].join('\n')
      : [
          `${stop.name} (${stop.town}) is back to standard (long) pretzels.`,
          `Drop: ${stop.singles_drop} singles / ${stop.doubles_drop} doubles — bake and deliver standard.`,
        ].join('\n'),
    audience: [],
    requiresAck: true,
    postedBy,
  });
}

async function autoShiftChanged({ before, after, personName, postedBy }) {
  // after is the updated row with people:{name} embedded; before is the raw snapshot.
  const name = personName || (after.people && after.people.name) || '—';
  const role = after.role || (after.people && after.people.role) || 'driver';
  const changes = [];
  if (before.location !== after.location) changes.push(`Location: ${before.location} → ${after.location}`);
  if ((before.route_key || '—') !== (after.route_key || '—'))
    changes.push(`Route: ${before.route_key || '—'} → ${after.route_key || '—'}`);
  const bDays = fmtDays(before.days), aDays = fmtDays(after.days);
  if (bDays !== aDays) changes.push(`Days: ${bDays} → ${aDays}`);
  if (!changes.length) return null;
  return postUpdate({
    title: `Shift updated: ${name} (${role})`,
    body: changes.join('\n'),
    audience: [role === 'baker' ? 'bakers' : role === 'driver' ? 'drivers' : null].filter(Boolean),
    requiresAck: true,
    postedBy,
  });
}

async function autoTimeOffApproved({ request, personName, personRole, coverName, postedBy }) {
  const name = personName || '—';
  const type = request.type === 'off' ? 'off' : 'needs cover';
  return postUpdate({
    title: `Time off approved: ${name} ${type === 'off' ? 'off' : 'needs cover'} ${fmtDate(request.requested_date)}`,
    body: coverName
      ? `Covered by: ${coverName}`
      : `No cover assigned yet — anyone free, please pick it up.`,
    audience: [personRole === 'baker' ? 'bakers' : 'drivers'],
    requiresAck: true,
    postedBy,
  });
}

module.exports = {
  postUpdate,
  autoNewStop,
  autoStopActiveChanged,
  autoDropChanged,
  autoShortsChanged,
  autoShiftChanged,
  autoTimeOffApproved,
};
