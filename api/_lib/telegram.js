// Telegram outbound push + webhook helpers.
//
// Outbound: formatUpdate(update, mentionHandles) → text + inline keyboard
//           sendUpdate(update, mentionHandles) → posts to the group,
//                                                 returns { message_id }
// Inbound:  verifyWebhookSecret(req) → true/false
//           handleCallback(sb, callback_query) → records ack, answers tap
//
// Env vars:
//   TELEGRAM_BOT_TOKEN      — required for push
//   TELEGRAM_CHAT_ID        — target supergroup id (negative integer)
//   TELEGRAM_WEBHOOK_SECRET — expected in X-Telegram-Bot-Api-Secret-Token
//                             header on inbound calls

const BOT   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT  = process.env.TELEGRAM_CHAT_ID;
const SEC   = process.env.TELEGRAM_WEBHOOK_SECRET;

const API = method => `https://api.telegram.org/bot${BOT}/${method}`;

async function tgCall(method, body) {
  if (!BOT) throw new Error('TELEGRAM_BOT_TOKEN not set');
  // Retry a few times on transient failures (network blips, 502s, 429s with
  // short retry_after). Permanent errors (400 "bad request", 403 "bot was
  // blocked", etc.) fail fast. 3 tries total with ~500ms, 1.5s, 3s backoff.
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(API(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({ ok: false, description: `http ${r.status}` }));
      if (j.ok) return j.result;
      // Permanent error — don't waste the retry budget.
      if (r.status >= 400 && r.status < 500 && j.error_code !== 429) {
        throw new Error(`telegram ${method}: ${j.description || r.status}`);
      }
      // Transient. For 429 Telegram tells us the back-off window.
      lastErr = new Error(`telegram ${method}: ${j.description || r.status}`);
      const waitMs = (j.parameters && j.parameters.retry_after)
        ? j.parameters.retry_after * 1000
        : 500 * Math.pow(3, attempt - 1);
      if (attempt < MAX_ATTEMPTS) await new Promise(res => setTimeout(res, waitMs));
    } catch (netErr) {
      // Network throw (dns, socket, timeout). Backoff + retry.
      lastErr = netErr;
      if (attempt < MAX_ATTEMPTS) await new Promise(res => setTimeout(res, 500 * Math.pow(3, attempt - 1)));
    }
  }
  throw lastErr;
}

// Format one update for the group. mentionHandles is an array of
// Telegram @handles (no "@" prefix) to tag inline so the right people
// get a notification; empty array = post without pings.
function formatUpdate(update, mentionHandles = []) {
  const lines = [`*${esc(update.title)}*`];
  if (update.body) lines.push('', esc(update.body));
  if (update.effective_date) lines.push('', `_Effective: ${update.effective_date}_`);
  if (mentionHandles.length) {
    lines.push('', 'cc: ' + mentionHandles.map(h => `@${h}`).join(' '));
  }
  const text = lines.join('\n');
  let reply_markup;
  if (update.claim_type === 'claim') {
    reply_markup = { inline_keyboard: [[{ text: '🙋 Claim it', callback_data: `claim:${update.id}` }]] };
  } else if (update.requires_ack) {
    reply_markup = { inline_keyboard: [[{ text: '✓ Got it', callback_data: `ack:${update.id}` }]] };
  }
  return { text, reply_markup };
}

// MarkdownV2 characters that need escaping for sendMessage parse_mode.
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function sendUpdate(update, mentionHandles = []) {
  if (!CHAT) throw new Error('TELEGRAM_CHAT_ID not set');
  const { text, reply_markup } = formatUpdate(update, mentionHandles);
  const result = await tgCall('sendMessage', {
    chat_id: CHAT,
    text,
    parse_mode: 'MarkdownV2',
    reply_markup,
  });
  return { message_id: result.message_id, chat_id: result.chat.id };
}

// Edit a sent message's text (e.g. after an ack we can show a check
// mark and strip the button). Best-effort — failures are logged.
async function updateSentMessageAfterAck({ chatId, messageId, update, mentionHandles, ackedBy }) {
  const { text } = formatUpdate(update, mentionHandles);
  const ackedLine = `\n\n_Acknowledged by: ${esc(ackedBy)}_`;
  try {
    await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text + ackedLine,
      parse_mode: 'MarkdownV2',
      // No reply_markup → removes the inline button.
    });
  } catch (e) {
    console.error('tg editMessageText:', e.message || e);
  }
}

function verifyWebhookSecret(req) {
  if (!SEC) return false;
  const got = req.headers['x-telegram-bot-api-secret-token'];
  return got && got === SEC;
}

// Called from the webhook: a user tapped a button.
// Supports two actions:
//   ack:<id>   — generic acknowledgment (every tapper gets credited)
//   claim:<id> — first-tap-wins (one claimer, group message edits to show it)
//
// Uses callback_query.from.id to find the person; if we haven't seen
// this telegram_user_id before, falls back to matching by @handle
// stored on the people row, and persists the user_id for next time.
async function handleCallback(sb, cq) {
  const data = cq.data || '';
  const isDecide = data.startsWith('decide:to:');
  const isClaim  = data.startsWith('claim:');
  const isAck    = data.startsWith('ack:');
  if (!isDecide && !isClaim && !isAck) return { answered: 'unknown action' };
  const updateId = isDecide ? null : data.slice((isClaim ? 'claim:' : 'ack:').length);
  const tgUser = cq.from || {};
  const tgUserId = tgUser.id;
  const tgHandle = (tgUser.username || '').toLowerCase();

  // Resolve the PPF person.
  let person = null;
  if (tgUserId) {
    const { data: byId } = await sb.from('people').select('id,name,role,telegram_handle').eq('telegram_user_id', tgUserId).maybeSingle();
    if (byId) person = byId;
  }
  if (!person && tgHandle) {
    const { data: byHandle } = await sb.from('people').select('id,name,role,telegram_handle').ilike('telegram_handle', tgHandle).maybeSingle();
    if (byHandle) {
      person = byHandle;
      await sb.from('people').update({ telegram_user_id: tgUserId }).eq('id', person.id);
    }
  }
  if (!person) {
    await tgCall('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `Not linked yet — tell Mike your Telegram handle (@${tgHandle || 'you'}) so he can add it.`,
      show_alert: true,
    });
    return { answered: 'unlinked user' };
  }

  if (isDecide) return handleDecideTimeOff(sb, cq, data, person);
  if (isClaim)  return handleClaim(sb, cq, updateId, person);
  return handleAck(sb, cq, updateId, person);
}

// Decide callback shape: decide:to:{req_id}:{approved|denied}
async function handleDecideTimeOff(sb, cq, data, person) {
  if (person.role !== 'operator') {
    await tgCall('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `Only operators can approve or deny.`,
      show_alert: true,
    });
    return { answered: 'not operator' };
  }
  // decide:to:{req_id}:{status}
  const parts = data.split(':');
  const reqId = parts[2];
  const status = parts[3];
  if (!['approved', 'denied'].includes(status)) return { answered: 'bad status' };

  // Fetch the request so we can report it correctly, and detect "already decided".
  const { data: req, error: re } = await sb.from('time_off_requests')
    .select('id,status,requested_date,type,person:person_id(name,role)')
    .eq('id', reqId).maybeSingle();
  if (re || !req) {
    await tgCall('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `Request not found — may have been deleted.`,
      show_alert: true,
    });
    return { answered: 'not found' };
  }
  if (req.status !== 'pending') {
    await tgCall('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `Already ${req.status}.`,
      show_alert: true,
    });
    return { answered: 'already decided' };
  }

  // Apply the decision — mirrors /api/time-off PATCH logic.
  const { data: updated, error: ue } = await sb.from('time_off_requests')
    .update({ status, decided_by: person.id, decided_at: new Date().toISOString() })
    .eq('id', reqId)
    .select('id,status,requested_date,type,decided_at,person:person_id(name,role)')
    .single();
  if (ue) {
    console.error('decide update:', ue);
    await tgCall('answerCallbackQuery', { callback_query_id: cq.id, text: `Server error — try the web app.`, show_alert: true });
    return { answered: 'db error' };
  }

  // Fire the standard approved-time-off auto-publish so drivers see it.
  if (status === 'approved') {
    try {
      const { autoTimeOffApproved } = require('./updates');
      await autoTimeOffApproved({
        request: updated,
        personName: updated.person && updated.person.name,
        personRole: updated.person && updated.person.role,
        coverName: null,  // TG approve path doesn't pick a cover; operator can set one on /ops/time-off
        postedBy: person.id,
      });
    } catch (e) { console.error('autoTimeOffApproved:', e); }
  }

  // Edit the request-ping message to show the decision + strip buttons.
  if (cq.message && cq.message.chat && cq.message.message_id) {
    try {
      await tgCall('editMessageText', {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: (cq.message.text || '')
          .split('\n').map(l => esc(l)).join('\n')  // re-escape since text comes back un-escaped
          + `\n\n*${status === 'approved' ? '✓ Approved' : '✗ Denied'} by ${esc(person.name)}*`,
        parse_mode: 'MarkdownV2',
      });
    } catch (e) { console.error('decide editMessageText:', e.message || e); }
  }

  await tgCall('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: status === 'approved'
      ? `Approved. The team has been notified.`
      : `Denied. ${(updated.person && updated.person.name) || 'They'} will see this on their Time Off tab.`,
  });
  return { answered: 'decided', status, person_id: person.id };
}

async function handleAck(sb, cq, updateId, person) {
  await sb.from('update_acks').upsert(
    { update_id: updateId, person_id: person.id },
    { onConflict: 'update_id,person_id' },
  );
  await tgCall('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: `Got it — thanks ${person.name}.`,
  });
  return { answered: 'ack', person_id: person.id, update_id: updateId };
}

async function handleClaim(sb, cq, updateId, person) {
  // Atomic first-wins: only update if claimed_by is still NULL. If no
  // rows come back, someone beat this tapper to it; look up who, and
  // answer privately with their name.
  const { data: won } = await sb.from('updates')
    .update({ claimed_by: person.id, claimed_at: new Date().toISOString() })
    .eq('id', updateId)
    .is('claimed_by', null)
    .select('id,title,audience,body,effective_date,telegram_message_ids,requires_ack,claim_type')
    .maybeSingle();

  if (!won) {
    // Already claimed. Look up the winner to show in the private answer.
    const { data: row } = await sb.from('updates')
      .select('claimed_by, people:claimed_by(name)')
      .eq('id', updateId)
      .maybeSingle();
    const winner = (row && row.people && row.people.name) || 'someone else';
    await tgCall('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `Already claimed by ${winner}.`,
      show_alert: true,
    });
    return { answered: 'already claimed', winner };
  }

  // Edit the group message: strip the button, append "Claimed by {name}".
  const tgm = won.telegram_message_ids;
  if (tgm && tgm.chat_id && tgm.message_id) {
    try {
      const { text } = formatUpdate(won, []);  // no @-cc on edit; keeps it tidy
      await tgCall('editMessageText', {
        chat_id: tgm.chat_id,
        message_id: tgm.message_id,
        text: text + `\n\n*✓ Claimed by ${esc(person.name)}*`,
        parse_mode: 'MarkdownV2',
        // No reply_markup → removes the Claim button.
      });
    } catch (e) {
      console.error('tg claim editMessageText:', e.message || e);
    }
  }

  await tgCall('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: `You've got it, ${person.name}. Thanks!`,
  });
  return { answered: 'claim', person_id: person.id, update_id: updateId };
}

// ─── Time-off request notification + decide buttons ─────────────────
// Separate from postUpdate: these aren't broadcasts, they're a direct
// ping to operators asking for a decision. Not stored in `updates`;
// the decision itself (via autoTimeOffApproved) creates the feed entry.
async function sendTimeOffRequest({ request, personName, operatorHandles }) {
  if (!CHAT) throw new Error('TELEGRAM_CHAT_ID not set');
  const dateStr = request.requested_date;
  const typeStr = request.type === 'off' ? 'off' : 'needs cover';
  const lines = [
    `*Time off request · ${esc(personName || '—')}*`,
    '',
    `${esc(typeStr)} on ${esc(dateStr)}`,
  ];
  if (request.note) lines.push('', esc(request.note));
  if ((operatorHandles || []).length) {
    lines.push('', 'cc: ' + operatorHandles.map(h => `@${h}`).join(' '));
  }
  const text = lines.join('\n');
  const reply_markup = {
    inline_keyboard: [[
      { text: '✓ Approve', callback_data: `decide:to:${request.id}:approved` },
      { text: '✗ Deny',    callback_data: `decide:to:${request.id}:denied` },
    ]],
  };
  const result = await tgCall('sendMessage', {
    chat_id: CHAT,
    text,
    parse_mode: 'MarkdownV2',
    reply_markup,
  });
  return { message_id: result.message_id, chat_id: result.chat.id };
}

module.exports = {
  formatUpdate,
  sendUpdate,
  sendTimeOffRequest,
  updateSentMessageAfterAck,
  verifyWebhookSecret,
  handleCallback,
  tgCall,  // exported so webhook branches can editMessageText directly
  esc,
};
