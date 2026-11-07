// Pretzel pack game backend. Mounted inside api/leads.js as
// ?resource=packs (Vercel Hobby 12-function cap: the leading underscore
// keeps this file from becoming its own function).
//
//   GET  ?resource=packs&view=state       player state (public)
//   GET  ?resource=packs&verify=<token>   magic link: redirects to the page,
//                                         which confirms with POST verify
//                                         (mail scanners never POST)
//   GET  ?resource=packs&view=stats       operator
//   POST ?resource=packs {action, ...}    public, JSON + same-origin only
//        actions: open, email, verify, instagram, app, stop, redeem
//
// Rules:
//   - Every pack wins one free pretzel. No tiers, no chance.
//   - Quest order: first pack, +1 after an Instagram tap, +1 after a
//     verified email, +1 after an App Store tap (taps are honor system).
//     Max 4 pretzels. The DB's unique (player_id, offer_key, source)
//     enforces the cap and makes a double tap mint one voucher, not two.
//   - Golden Ticket ('bonus'): after all 4, when /ops/qr turns it on.
//     One fixed item per offer, the same for everyone (not a draw).
//     What staff give (bonus_staff) is shown only after the staff PIN.
//   - At 3 (first, Instagram, email) a player may end the game with
//     "I don't need another app": keeps 3 pretzels, no Golden Ticket.
//   - pack_games records each player's score and how the game ended.
//   - Player identity: signed httpOnly cookie `ppf_player` (HMAC with
//     APP_JWT_SECRET). A verified email follows the person across
//     devices: verifying on a new device merges into the email's player.
//   - Redemption: staff types the 4-digit PACKS_STAFF_PIN on the
//     customer's phone. 5 wrong PINs lock that code.
//   - Redis (rate limits) and Gmail are optional: if they are down the
//     first pack still opens.
//
// Emails are never logged. Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// APP_JWT_SECRET, PACKS_STAFF_PIN, UPSTASH_REDIS_REST_URL/TOKEN (optional),
// GOOGLE_SHEET_KEY_B64 (Gmail sender, optional), LEAD_IP_SALT.

const crypto = require('crypto');

const COOKIE = 'ppf_player';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180;
// 4 free pretzels, in quest order, then the Golden Ticket ('bonus').
const MAX_PACKS = 4;
const PRETZELS = ['first', 'instagram', 'email', 'app'];
const SOURCES = [...PRETZELS, 'bonus'];
// Golden Ticket defaults (public). What staff hand over is set in
// /ops/qr as bonus_staff and never leaves the staff side.
const BONUS_TITLE = 'Golden Ticket';
const BONUS_TEXT = 'Visit the Pretzel Factory to claim your prize.';
// No 0/O, 1/I/L: easy to read out loud and type at the counter.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const LINK_TTL_MS = 60 * 60 * 1000;
const NO_END_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PIN_TRIES = 5;
const STORES = { lynbrook: 'Lynbrook', franklin_square: 'Franklin Square' };
const TIME_ZONE = 'America/New_York';
// [max, window seconds] per hashed IP (or hashed email).
const LIMITS = {
  open: [60, 600],
  email_ip: [5, 3600],
  email_addr: [3, 3600],
  verify: [20, 600],
  pin_code: [5, 600],
  instagram: [10, 600],
  app: [10, 600],
  stop: [10, 600],
  redeem: [12, 600],
};

const MSG = {
  off: 'The pack game is not running right now.',
  busy: 'Too many tries. Wait a few minutes and try again.',
  setup: 'The pack game is not set up yet.',
  oops: 'Something went wrong on our side. Show this page at the counter and we will sort it out.',
  ended: 'Your game has ended. Show your codes at the counter.',
};

// ─── pure helpers (unit-tested) ─────────────────────────────────────

function makeCode(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

// Accepts "abcd-2345", " ABCD 2345 " etc. Returns the stored form or null.
function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== CODE_LEN) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

function formatCode(code) {
  return code.slice(0, 4) + '-' + code.slice(4);
}

// Per-person limits reset when the offer's start date changes.
function offerKey(offer) {
  return 'o:' + ((offer && offer.starts_at) || 'open');
}

function gameLive(offer, status) {
  return !!(offer && offer.game === true && status === 'live');
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 160) return null;
  if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Pretzel sources this player has unlocked, in quest order.
function unlockedSources(player) {
  const out = ['first'];
  if (player && player.instagram_at) out.push('instagram');
  if (player && player.email_verified_at) out.push('email');
  if (player && player.app_at) out.push('app');
  return out;
}

function pretzelCount(vouchers) {
  return (vouchers || []).filter((v) => PRETZELS.includes(v.source)).length;
}

// Golden Ticket is on only with a staff item set and an App Store link
// (it needs all 4 pretzels, and the 4th is the app).
function bonusOn(offer) {
  return !!(offer && offer.bonus_on === true && offer.bonus_staff && offer.app_store_url);
}

function bonusTexts(offer) {
  return {
    title: (offer && offer.bonus_title) || BONUS_TITLE,
    text: (offer && offer.bonus_text) || BONUS_TEXT,
  };
}

// opts: {bonus: Golden Ticket available, ended: game end state}.
function nextSource(player, vouchers, opts = {}) {
  if (opts.ended === 'stopped_at_3') return null;
  const used = new Set((vouchers || []).map((v) => v.source));
  if (pretzelCount(vouchers) >= MAX_PACKS) {
    return opts.bonus && !used.has('bonus') ? 'bonus' : null;
  }
  return unlockedSources(player).find((s) => !used.has(s)) || null;
}

// "I don't need another app": only at exactly first + instagram + email,
// before the app pack is unlocked or opened, and only once.
function canStop(offer, player, vouchers, game) {
  if (game && game.ended) return false;
  if (!(offer && offer.app_store_url)) return false;
  if (player && player.app_at) return false;
  const used = new Set((vouchers || []).map((v) => v.source));
  return used.has('first') && used.has('instagram') && used.has('email') && !used.has('app');
}

// j***@example.com: enough for staff to recognise, no more.
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  return local.slice(0, 1) + '***@' + domain;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function signPlayer(id, secret) {
  const mac = crypto.createHmac('sha256', 'ppf_player:v1:' + secret).update(id).digest('base64url');
  return id + '.' + mac;
}

function verifyPlayerCookie(value, secret) {
  if (typeof value !== 'string' || !secret) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  if (!UUID_RE.test(id)) return null;
  const want = Buffer.from(signPlayer(id, secret));
  const got = Buffer.from(value);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  return id;
}

function pinOk(input, pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return false;
  const a = Buffer.from(String(input == null ? '' : input).padEnd(4).slice(0, 8));
  const b = Buffer.from(pin.padEnd(4).slice(0, 8));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Offset (ms) of a time zone from UTC at a given instant.
function tzOffsetMs(tz, at) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime();
}

// Last second of a YYYY-MM-DD day in `tz`.
function endOfDayIn(dateStr, tz = TIME_ZONE) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const nextMidnightWall = Date.UTC(y, m - 1, d + 1);
  let t = nextMidnightWall - tzOffsetMs(tz, new Date(nextMidnightWall));
  t = nextMidnightWall - tzOffsetMs(tz, new Date(t));
  return new Date(t - 1000);
}

function voucherExpiry(offer, now) {
  if (offer && offer.ends_at) return endOfDayIn(offer.ends_at);
  return new Date(now.getTime() + NO_END_TTL_MS);
}

// Public view of a voucher. Never includes prize_staff.
function publicVoucher(v, now) {
  const out = {
    code: formatCode(v.code),
    source: v.source,
    expires_at: v.expires_at,
    redeemed_at: v.redeemed_at || null,
    redeemed_store: v.redeemed_store ? (STORES[v.redeemed_store] || null) : null,
    expired: !v.redeemed_at && new Date(v.expires_at).getTime() <= now.getTime(),
  };
  if (v.source === 'bonus') {
    out.title = v.prize_title || BONUS_TITLE;
    out.text = v.prize_public || BONUS_TEXT;
  }
  return out;
}

function bonusState(source, player, vouchers, available) {
  const used = (vouchers || []).some((v) => v.source === source);
  if (used) return 'used';
  if (unlockedSources(player).includes(source)) return 'unlocked';
  return available ? 'locked' : 'off';
}

// Trail nodes: done | ready (unlocked, not opened) | locked | off.
function trailOf(offer, player, vouchers, ended) {
  const used = new Set((vouchers || []).map((v) => v.source));
  const unlocked = new Set(unlockedSources(player));
  const avail = { first: true, instagram: !!offer.instagram_handle, email: true, app: !!offer.app_store_url };
  const stopped = ended === 'stopped_at_3';
  const nodes = PRETZELS.map((key) => {
    let state;
    if (used.has(key)) state = 'done';
    else if (!avail[key] || stopped) state = 'off';
    else state = unlocked.has(key) ? 'ready' : 'locked';
    return { key, state };
  });
  let b = 'off';
  if (used.has('bonus')) b = 'done';
  else if (bonusOn(offer) && !stopped) b = pretzelCount(vouchers) >= MAX_PACKS ? 'ready' : 'locked';
  nodes.push({ key: 'bonus', state: b });
  return nodes;
}

function playerState({ offer, status, player, vouchers, game, now }) {
  if (!gameLive(offer, status)) return { game: false, status };
  const ig = offer.instagram_handle || '';
  const app = offer.app_store_url || '';
  const ended = (game && game.ended) || null;
  const score = pretzelCount(vouchers);
  const allowed = Math.min(MAX_PACKS, unlockedSources(player).length);
  const next = nextSource(player, vouchers, { bonus: bonusOn(offer), ended });
  const trail = trailOf(offer, player, vouchers, ended);
  // The one quest to show: the first locked pretzel step, only when no
  // pack is waiting and the game has not ended.
  let quest = null;
  if (!next && !ended) {
    const q = trail.find((n) => n.key !== 'first' && n.key !== 'bonus' && n.state === 'locked');
    quest = q ? q.key : null;
  }
  const bt = bonusTexts(offer);
  return {
    game: true,
    status,
    headline: offer.headline || '',
    stamp: offer.stamp || '',
    max: MAX_PACKS,
    used: score,
    score,
    collected: score,
    allowed,
    can_open: !!next,
    next_source: next,
    next_quest: quest,
    can_stop: canStop(offer, player, vouchers, game),
    ended,
    completed_all: !!(game && game.completed_all),
    trail,
    instagram: ig || null,
    app_store_url: app || null,
    email_verified: !!(player && player.email_verified_at),
    bonuses: {
      email: bonusState('email', player, vouchers, true),
      instagram: bonusState('instagram', player, vouchers, !!ig),
      app: bonusState('app', player, vouchers, !!app),
    },
    bonus: { on: bonusOn(offer), title: bt.title, text: bt.text, state: trail[trail.length - 1].state },
    vouchers: vouchers.map((v) => publicVoucher(v, now)),
  };
}

function magicLinkEmail(link) {
  const text = [
    'Tap the link below to verify your email and unlock one more free pretzel pack.',
    '',
    link,
    '',
    'The link works once and expires in 1 hour.',
    'If you did not ask for this, ignore this email. Nothing happens.',
    '',
    'Philly Pretzel Factory, Lynbrook and Franklin Square.',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#0D5237">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D5237"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#F2E7A4">
<tr><td style="background:#000000;padding:18px 22px;font-family:'Arial Black',Arial,sans-serif;font-size:20px;letter-spacing:0.02em;color:#D4B662;text-transform:uppercase">One more pretzel pack</td></tr>
<tr><td style="padding:22px;font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#000000">
<p style="margin:0 0 18px">Tap the button to verify your email and unlock one more free pretzel pack.</p>
<p style="margin:0 0 18px"><a href="${link}" style="display:inline-block;background:#0D5237;color:#FFFFFF;padding:14px 22px;font-family:'Arial Black',Arial,sans-serif;font-size:15px;letter-spacing:0.04em;text-decoration:none;text-transform:uppercase">Verify and unlock</a></p>
<p style="margin:0 0 8px;font-size:14px">The link works once and expires in 1 hour. If you did not ask for this, ignore this email.</p>
<p style="margin:0;font-size:13px;color:#6D6E71">Philly Pretzel Factory, Lynbrook and Franklin Square.</p>
</td></tr></table></td></tr></table></body></html>`;
  return {
    subject: 'Your bonus pretzel pack',
    preheader: 'Verify your email to unlock one more free pretzel pack.',
    text,
    html,
  };
}

// Merge two game records for one person (email verify across devices):
// higher score, and the stronger end state (completed > stopped > none).
const END_RANK = { completed: 2, stopped_at_3: 1 };
function mergeGame(target, from) {
  const rank = (g) => END_RANK[g.ended] || 0;
  const end = rank(from) > rank(target) ? from : target;
  return {
    score: Math.max(target.score || 0, from.score || 0),
    ended: end.ended || null,
    ended_at: end.ended ? end.ended_at : null,
    completed_all: end.ended === 'completed',
    started_at: [target.started_at, from.started_at].filter(Boolean).sort()[0] || target.started_at,
    last_at: [target.last_at, from.last_at].filter(Boolean).sort().at(-1) || target.last_at,
  };
}

// "Completed all 4" list for /ops/qr. Operator only; emails masked.
function completedList(games, tickets, players) {
  const ticketOf = new Map((tickets || []).map((t) => [t.player_id, t]));
  const emailOf = new Map((players || []).map((p) => [p.id, p.email]));
  return (games || [])
    .filter((g) => g.completed_all)
    .sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)))
    .map((g) => {
      const t = ticketOf.get(g.player_id);
      return {
        completed_at: g.ended_at,
        ticket: t ? formatCode(t.code) : null,
        ticket_redeemed: !!(t && t.redeemed_at),
        email: maskEmail(emailOf.get(g.player_id)),
      };
    });
}

// ─── storage (Supabase) ─────────────────────────────────────────────

function isUnique(err) {
  return !!err && (err.code === '23505' || /duplicate key/i.test(err.message || ''));
}

function supabaseStore(sb) {
  const one = async (q) => {
    const { data, error } = await q;
    if (error) throw error;
    return data || null;
  };
  return {
    getPlayer: (id) => one(sb.from('pack_players').select('*').eq('id', id).maybeSingle()),
    createPlayer: () => one(sb.from('pack_players').insert({ marketing_opt_in: false }).select('*').single()),
    findPlayerByEmail: (email) => one(sb.from('pack_players').select('*').eq('email', email).maybeSingle()),
    async updatePlayer(id, patch) {
      const { data, error } = await sb.from('pack_players').update(patch).eq('id', id).select('*').single();
      if (isUnique(error)) return { conflict: true };
      if (error) throw error;
      return { ok: true, player: data };
    },
    async listVouchers(playerId, key) {
      const rows = await one(sb.from('pack_vouchers').select('*').eq('player_id', playerId).eq('offer_key', key).order('created_at'));
      return rows || [];
    },
    async insertVoucher(row) {
      const { data, error } = await sb.from('pack_vouchers').insert(row).select('*').single();
      if (isUnique(error)) {
        const where = `${error.message || ''} ${error.details || ''}`;
        return { conflict: /pack_vouchers_code_key|\(code\)/.test(where) ? 'code' : 'slot' };
      }
      if (error) throw error;
      return { ok: true, voucher: data };
    },
    findVoucher: (code) => one(sb.from('pack_vouchers').select('*').eq('code', code).maybeSingle()),
    // Compare-and-set so parallel wrong PINs cannot overwrite each other.
    async bumpPinFailures(code, from, to) {
      await one(sb.from('pack_vouchers').update({ pin_failures: to })
        .eq('code', code).eq('pin_failures', from).is('redeemed_at', null));
    },
    async burnVoucher(code, store, nowIso) {
      const rows = await one(sb.from('pack_vouchers')
        .update({ redeemed_at: nowIso, redeemed_store: store })
        .eq('code', code).is('redeemed_at', null).gt('expires_at', nowIso).select('*'));
      return (rows && rows[0]) || null;
    },
    insertMagicLink: (row) => one(sb.from('pack_magic_links').insert(row)),
    // Single use, unexpired, and only for the player who asked for it.
    async consumeMagicLink(hash, nowIso, playerId) {
      const rows = await one(sb.from('pack_magic_links')
        .update({ used_at: nowIso })
        .eq('token_hash', hash).eq('player_id', playerId).is('used_at', null).gt('expires_at', nowIso).select('*'));
      return (rows && rows[0]) || null;
    },
    // Move vouchers to the email's player. A slot the target already
    // used is a duplicate: if unredeemed it is voided (expired now), so
    // one email never holds two live codes for the same slot.
    async moveVouchers(fromId, toId, nowIso) {
      const rows = await one(sb.from('pack_vouchers').select('id,redeemed_at').eq('player_id', fromId));
      for (const r of rows || []) {
        const { error } = await sb.from('pack_vouchers').update({ player_id: toId }).eq('id', r.id);
        if (isUnique(error)) {
          if (!r.redeemed_at) await one(sb.from('pack_vouchers').update({ expires_at: nowIso }).eq('id', r.id).is('redeemed_at', null));
          continue;
        }
        if (error) throw error;
      }
    },
    // ─ game record (pack_games, p11) ─
    getGame: (pid, key) => one(sb.from('pack_games').select('*').eq('player_id', pid).eq('offer_key', key).maybeSingle()),
    // Insert or update score + last_at. started_at keeps its insert default.
    touchGame: (pid, key, score, nowIso) => one(sb.from('pack_games')
      .upsert({ player_id: pid, offer_key: key, score, last_at: nowIso }, { onConflict: 'player_id,offer_key' })
      .select('*').single()),
    // Set the end once: a game that already ended is never overwritten.
    async endGame(pid, key, ended, nowIso) {
      const rows = await one(sb.from('pack_games')
        .update({ ended, ended_at: nowIso, completed_all: ended === 'completed', last_at: nowIso })
        .eq('player_id', pid).eq('offer_key', key).is('ended', null).select('*'));
      return (rows && rows[0]) || null;
    },
    async mergeGames(fromId, toId) {
      const rows = await one(sb.from('pack_games').select('*').eq('player_id', fromId));
      for (const g of rows || []) {
        const t = await one(sb.from('pack_games').select('*').eq('player_id', toId).eq('offer_key', g.offer_key).maybeSingle());
        if (!t) {
          await one(sb.from('pack_games').update({ player_id: toId }).eq('player_id', fromId).eq('offer_key', g.offer_key));
          continue;
        }
        await one(sb.from('pack_games').update(mergeGame(t, g)).eq('player_id', toId).eq('offer_key', g.offer_key));
        await one(sb.from('pack_games').delete().eq('player_id', fromId).eq('offer_key', g.offer_key));
      }
    },
    // Head-only counts: no row cap (PostgREST returns at most 1000 rows).
    async stats(key) {
      const n = async (q) => {
        const { count, error } = await q;
        if (error) throw error;
        return count || 0;
      };
      const v = () => sb.from('pack_vouchers').select('id', { count: 'exact', head: true }).eq('offer_key', key);
      const p = () => sb.from('pack_players').select('id', { count: 'exact', head: true });
      const g = () => sb.from('pack_games').select('player_id', { count: 'exact', head: true }).eq('offer_key', key);
      const [first, email, instagram, app, bonus, redeemed, bonus_redeemed, emails_verified, instagram_taps, app_taps,
        completed, stopped, u1, u2, u3, u4] = await Promise.all([
        n(v().eq('source', 'first')), n(v().eq('source', 'email')), n(v().eq('source', 'instagram')), n(v().eq('source', 'app')),
        n(v().eq('source', 'bonus')),
        n(v().not('redeemed_at', 'is', null)), n(v().eq('source', 'bonus').not('redeemed_at', 'is', null)),
        n(p().not('email_verified_at', 'is', null)), n(p().not('instagram_at', 'is', null)), n(p().not('app_at', 'is', null)),
        n(g().eq('ended', 'completed')), n(g().eq('ended', 'stopped_at_3')),
        n(g().is('ended', null).eq('score', 1)), n(g().is('ended', null).eq('score', 2)),
        n(g().is('ended', null).eq('score', 3)), n(g().is('ended', null).eq('score', 4)),
      ]);
      const games = await one(sb.from('pack_games').select('player_id,ended_at,completed_all')
        .eq('offer_key', key).eq('completed_all', true).order('ended_at', { ascending: false }).limit(200));
      const ids = (games || []).map((x) => x.player_id);
      let tickets = [];
      let players = [];
      if (ids.length) {
        [tickets, players] = await Promise.all([
          one(sb.from('pack_vouchers').select('player_id,code,redeemed_at').eq('offer_key', key).eq('source', 'bonus').in('player_id', ids)),
          one(sb.from('pack_players').select('id,email').in('id', ids)),
        ]);
      }
      return {
        opened: { first, instagram, email, app, bonus, total: first + email + instagram + app },
        redeemed, bonus_redeemed, emails_verified, instagram_taps, app_taps,
        games: { completed, stopped_at_3: stopped, unfinished: { 1: u1, 2: u2, 3: u3, 4: u4 } },
        completed_list: completedList(games, tickets, players),
      };
    },
  };
}

// Same shape as supabaseStore().stats, from plain rows (tests, local mock).
function summarize(rows, emails_verified, instagram_taps, app_taps = 0, games = [], players = []) {
  const opened = { first: 0, instagram: 0, email: 0, app: 0, bonus: 0, total: 0 };
  let redeemed = 0;
  let bonus_redeemed = 0;
  for (const r of rows) {
    if (opened[r.source] != null) opened[r.source]++;
    if (PRETZELS.includes(r.source)) opened.total++;
    if (r.redeemed_at) redeemed++;
    if (r.redeemed_at && r.source === 'bonus') bonus_redeemed++;
  }
  const g = { completed: 0, stopped_at_3: 0, unfinished: { 1: 0, 2: 0, 3: 0, 4: 0 } };
  for (const x of games) {
    if (x.ended === 'completed') g.completed++;
    else if (x.ended === 'stopped_at_3') g.stopped_at_3++;
    else if (g.unfinished[x.score] != null) g.unfinished[x.score]++;
  }
  const tickets = rows.filter((r) => r.source === 'bonus');
  return {
    opened, redeemed, bonus_redeemed, emails_verified, instagram_taps, app_taps,
    games: g, completed_list: completedList(games, tickets, players),
  };
}

// ─── IO (injectable for tests) ──────────────────────────────────────

function defaultDeps() {
  const qr = require('./_qr');
  const qrDeps = qr.defaultDeps();
  let store;
  return {
    store: () => {
      if (!store) store = supabaseStore(require('./_lib/auth').supabase());
      return store;
    },
    readOffer: () => qr.readLiveOffer(qrDeps),
    readSession: (req) => require('./_lib/auth').readSession(req),
    redis: qrDeps.redis,
    sendEmail: (msg) => require('./_lib/gmail').sendEmail(msg),
    env: process.env,
    now: () => new Date(),
    randomBytes: crypto.randomBytes,
    randomInt: crypto.randomInt,
  };
}

// ─── HTTP ───────────────────────────────────────────────────────────

function readBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip */ }
  }
  return out;
}

function setPlayerCookie(res, id, secret) {
  res.setHeader('Set-Cookie', `${COOKIE}=${signPlayer(id, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
}

function clientIpHash(req, env) {
  const xff = req.headers['x-forwarded-for'];
  const ip = xff ? String(xff).split(',')[0].trim() : ((req.socket && req.socket.remoteAddress) || 'unknown');
  return sha256((env.LEAD_IP_SALT || 'ppf-lead-v1') + '|' + ip).slice(0, 32);
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
  } catch {
    return false;
  }
}

// Origin for emailed links. Only our own hosts (production, this
// project's preview deployments, local dev); anything else falls back to
// production so a spoofed Host header can never point a link elsewhere.
const CANONICAL_ORIGIN = 'https://the-pretzel-cup.vercel.app';
function siteOrigin(req, env = {}) {
  if (env.PACKS_SITE_URL && /^https:\/\/[a-z0-9.-]+$/i.test(env.PACKS_SITE_URL)) return env.PACKS_SITE_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  if (host === 'the-pretzel-cup.vercel.app' || /^the-pretzel-cup-[a-z0-9-]+\.vercel\.app$/.test(host)) return `https://${host}`;
  return CANONICAL_ORIGIN;
}

// Fixed-window counter. Fails open: Redis down never blocks a pack.
async function overLimit(deps, name, id) {
  const r = deps.redis();
  if (!r) return false;
  const [max, win] = LIMITS[name];
  const key = `packs:rl:${name}:${id}`;
  try {
    // Create the key with its TTL first, so a failed EXPIRE can never
    // leave a counter that blocks this IP forever.
    await r.set(key, 0, { nx: true, ex: win });
    const n = await r.incr(key);
    return n > max;
  } catch (e) {
    console.error('[packs] rate-limit check failed:', e.message || e);
    return false;
  }
}

function redirect(res, location) {
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.status(302);
  if (typeof res.end === 'function') return res.end();
  return res.json({ redirect: location });
}

async function loadContext(req, deps) {
  const secret = deps.env.APP_JWT_SECRET;
  const { offer, status } = await deps.readOffer();
  const store = deps.store();
  const id = verifyPlayerCookie(parseCookies(req.headers.cookie)[COOKIE], secret);
  const player = id ? await store.getPlayer(id) : null;
  const key = offer ? offerKey(offer) : null;
  return { secret, offer, status, store, player, key, live: gameLive(offer, status) };
}

// Keep the game record in step with the vouchers (also backfills players
// from before p11 and re-scores after an email merge). Fails soft: if the
// game table is missing or down, pretzels still open.
async function syncGame(ctx, vouchers, now) {
  try {
    const pid = ctx.player.id;
    let game = await ctx.store.getGame(pid, ctx.key);
    if (!vouchers.length) return game;
    const score = pretzelCount(vouchers);
    const iso = now.toISOString();
    if (!game || game.score !== score) game = await ctx.store.touchGame(pid, ctx.key, score, iso);
    if (score >= MAX_PACKS && !game.ended) {
      game = (await ctx.store.endGame(pid, ctx.key, 'completed', iso)) || await ctx.store.getGame(pid, ctx.key);
    }
    return game;
  } catch (e) {
    console.error('[packs] game record failed:', e.message || e);
    return null;
  }
}

async function stateOf(ctx, deps) {
  let vouchers = [];
  let game = null;
  if (ctx.player && ctx.live) {
    vouchers = await ctx.store.listVouchers(ctx.player.id, ctx.key);
    game = await syncGame(ctx, vouchers, deps.now());
  }
  return playerState({ offer: ctx.offer, status: ctx.status, player: ctx.player, vouchers, game, now: deps.now() });
}

async function readGame(ctx) {
  if (!ctx.player) return null;
  try {
    return await ctx.store.getGame(ctx.player.id, ctx.key);
  } catch (e) {
    console.error('[packs] game read failed:', e.message || e);
    return null;
  }
}

async function ensurePlayer(ctx, res) {
  if (ctx.player) return ctx.player;
  ctx.player = await ctx.store.createPlayer();
  setPlayerCookie(res, ctx.player.id, ctx.secret);
  return ctx.player;
}

async function handleState(req, res, deps) {
  const ctx = await loadContext(req, deps);
  return res.status(200).json(await stateOf(ctx, deps));
}

async function handleOpen(req, res, deps, ctx) {
  if (!ctx.live) return res.status(409).json({ error: MSG.off, state: await stateOf(ctx, deps) });
  if (await overLimit(deps, 'open', clientIpHash(req, deps.env))) return res.status(429).json({ error: MSG.busy });
  const player = await ensurePlayer(ctx, res);
  const expires_at = voucherExpiry(ctx.offer, deps.now()).toISOString();
  const game = await readGame(ctx);
  const opts = { bonus: bonusOn(ctx.offer), ended: game && game.ended };
  for (let attempt = 0; attempt < 4; attempt++) {
    const vouchers = await ctx.store.listVouchers(player.id, ctx.key);
    const source = nextSource(player, vouchers, opts);
    if (!source) {
      const error = opts.ended === 'stopped_at_3' ? MSG.ended : 'No packs left. You have opened all of yours for this offer.';
      return res.status(409).json({ error, code: 'none_left', state: await stateOf(ctx, deps) });
    }
    const row = { code: makeCode(deps.randomInt), player_id: player.id, offer_key: ctx.key, source, expires_at };
    if (source === 'bonus') {
      // One fixed item per offer: the texts are copied onto the ticket.
      const t = bonusTexts(ctx.offer);
      Object.assign(row, { prize_title: t.title, prize_public: t.text, prize_staff: String(ctx.offer.bonus_staff) });
    }
    const r = await ctx.store.insertVoucher(row);
    if (r.ok) {
      try {
        await ctx.store.touchGame(player.id, ctx.key, pretzelCount([...vouchers, r.voucher]), deps.now().toISOString());
      } catch (e) {
        console.error('[packs] game touch failed:', e.message || e);
      }
      return res.status(200).json({ voucher: publicVoucher(r.voucher, deps.now()), state: await stateOf(ctx, deps) });
    }
    // 'code' = random code collided, 'slot' = a parallel tap took this
    // source. Either way, re-read and try again.
  }
  return res.status(409).json({ error: 'That pack is already open. Pull down to refresh.', state: await stateOf(ctx, deps) });
}

async function handleEmail(req, res, deps, ctx, body) {
  if (!ctx.live) return res.status(409).json({ error: MSG.off });
  const email = normalizeEmail(body.email);
  if (!email) return res.status(400).json({ error: 'That email does not look right.' });
  if (ctx.player && ctx.player.email_verified_at) return res.status(409).json({ error: 'Your email is already verified.' });
  if (await overLimit(deps, 'email_ip', clientIpHash(req, deps.env))
      || await overLimit(deps, 'email_addr', sha256('email|' + email).slice(0, 32))) {
    return res.status(429).json({ error: MSG.busy });
  }
  const player = await ensurePlayer(ctx, res);
  const token = deps.randomBytes(32).toString('base64url');
  const now = deps.now();
  await ctx.store.insertMagicLink({
    token_hash: sha256(token),
    player_id: player.id,
    email,
    marketing_opt_in: body.marketing_opt_in === true,
    expires_at: new Date(now.getTime() + LINK_TTL_MS).toISOString(),
  });
  const link = `${siteOrigin(req, deps.env)}/api/leads?resource=packs&verify=${token}`;
  try {
    await deps.sendEmail({ to: email, ...magicLinkEmail(link) });
  } catch (e) {
    // Never log the address itself.
    console.error('[packs] magic link send failed:', e.message || e);
    return res.status(502).json({ error: 'We could not send the email right now. Try again later. Your pretzel is safe.' });
  }
  return res.status(200).json({ ok: true });
}

// GET from the email: never touches the token. It hands it to the page
// in the URL fragment (kept out of logs and Referer); the page confirms
// with POST {action:'verify'}. Link scanners that pre-open URLs never
// send that POST, so they cannot use up or redeem a token.
function handleVerifyLink(res, token) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return redirect(res, '/free-pretzels?pack_email=invalid');
  return redirect(res, `/free-pretzels#pack_verify=${token}`);
}

// POST {action:'verify', token}. The link only works in the browser that
// asked for it (same ppf_player cookie), so a link sent to someone
// else's inbox cannot attach their email to a stranger's player.
async function handleVerify(req, res, deps, ctx, body) {
  const token = typeof body.token === 'string' ? body.token : '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return res.status(400).json({ result: 'invalid', error: 'That link did not work.' });
  if (await overLimit(deps, 'verify', clientIpHash(req, deps.env))) return res.status(429).json({ result: 'busy', error: MSG.busy });
  const store = ctx.store;
  const now = deps.now();
  const hash = sha256(token);
  if (!ctx.player) return res.status(403).json({ result: 'device', error: 'Open the link on the same phone and browser you used to ask for it.' });
  const link = await store.consumeMagicLink(hash, now.toISOString(), ctx.player.id);
  if (!link) {
    return res.status(410).json({ result: 'expired', error: 'That link has expired, was already used, or was opened on a different phone.' });
  }
  // One verified email per player: verifying a second address would free
  // the first one to earn another email bonus somewhere else.
  if (ctx.player.email && ctx.player.email !== link.email) {
    return res.status(409).json({ result: 'already', error: 'This phone already has a verified email.' });
  }

  let finalId = null;
  for (let attempt = 0; attempt < 2 && !finalId; attempt++) {
    const owner = await store.findPlayerByEmail(link.email);
    if (!owner) {
      const r = await store.updatePlayer(link.player_id, {
        email: link.email, email_verified_at: now.toISOString(), marketing_opt_in: !!link.marketing_opt_in,
      });
      if (r.conflict) continue; // another link for this email won the race: merge instead
      finalId = link.player_id;
      break;
    }
    if (owner.id !== link.player_id) {
      await store.moveVouchers(link.player_id, owner.id, now.toISOString());
      try {
        await store.mergeGames(link.player_id, owner.id);
      } catch (e) {
        console.error('[packs] game merge failed:', e.message || e);
      }
      const patch = {};
      if (!owner.instagram_at && ctx.player.instagram_at) patch.instagram_at = ctx.player.instagram_at;
      if (!owner.app_at && ctx.player.app_at) patch.app_at = ctx.player.app_at;
      if (link.marketing_opt_in && !owner.marketing_opt_in) patch.marketing_opt_in = true;
      if (Object.keys(patch).length) await store.updatePlayer(owner.id, patch);
    }
    finalId = owner.id;
  }
  if (!finalId) return res.status(409).json({ result: 'busy', error: MSG.busy });
  setPlayerCookie(res, finalId, ctx.secret);
  ctx.player = await store.getPlayer(finalId);
  return res.status(200).json({ ok: true, result: 'verified', state: await stateOf(ctx, deps) });
}

// Honor-system bonuses: the follow or download cannot be checked, so a
// tap unlocks the pack once per player. kind: 'instagram' | 'app'.
const HONOR = {
  instagram: { field: 'instagram_at', enabled: (o) => !!o.instagram_handle, off: 'The Instagram bonus is not on right now.' },
  app: { field: 'app_at', enabled: (o) => !!o.app_store_url, off: 'The app bonus is not on right now.' },
};
async function handleHonor(req, res, deps, ctx, kind) {
  const h = HONOR[kind];
  if (!ctx.live) return res.status(409).json({ error: MSG.off });
  if (!h.enabled(ctx.offer)) return res.status(409).json({ error: h.off });
  if (await overLimit(deps, kind, clientIpHash(req, deps.env))) return res.status(429).json({ error: MSG.busy });
  const game = await readGame(ctx);
  if (game && game.ended === 'stopped_at_3') return res.status(409).json({ error: MSG.ended, state: await stateOf(ctx, deps) });
  const player = await ensurePlayer(ctx, res);
  if (!player[h.field]) {
    const r = await ctx.store.updatePlayer(player.id, { [h.field]: deps.now().toISOString() });
    if (r.ok) ctx.player = r.player;
  }
  return res.status(200).json({ ok: true, state: await stateOf(ctx, deps) });
}

// POST {action:'stop'}: "I don't need another app". Ends the game at 3.
// The player keeps their 3 pretzels and gets no Golden Ticket.
async function handleStop(req, res, deps, ctx) {
  if (!ctx.live) return res.status(409).json({ error: MSG.off });
  if (!ctx.player) return res.status(409).json({ error: 'Open your first pack first.' });
  if (await overLimit(deps, 'stop', clientIpHash(req, deps.env))) return res.status(429).json({ error: MSG.busy });
  const vouchers = await ctx.store.listVouchers(ctx.player.id, ctx.key);
  const game = await ctx.store.getGame(ctx.player.id, ctx.key);
  if (!canStop(ctx.offer, ctx.player, vouchers, game)) {
    return res.status(409).json({ error: 'You can end your game after your 3rd pretzel.', state: await stateOf(ctx, deps) });
  }
  const iso = deps.now().toISOString();
  await ctx.store.touchGame(ctx.player.id, ctx.key, pretzelCount(vouchers), iso);
  await ctx.store.endGame(ctx.player.id, ctx.key, 'stopped_at_3', iso);
  return res.status(200).json({ ok: true, state: await stateOf(ctx, deps) });
}

async function handleRedeem(req, res, deps, body) {
  const code = normalizeCode(body.code);
  if (!code) return res.status(400).json({ error: 'Code not found. Check the letters and numbers.' });
  const store = STORES[body.store] ? body.store : null;
  if (!store) return res.status(400).json({ error: 'Pick the store first.' });
  const pin = deps.env.PACKS_STAFF_PIN;
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(503).json({ error: 'Redemption is not set up yet. Staff: write the code down and honour it.' });
  }
  if (await overLimit(deps, 'redeem', clientIpHash(req, deps.env))) return res.status(429).json({ error: MSG.busy });
  const db = deps.store();
  const now = deps.now();
  const v = await db.findVoucher(code);
  if (!v) return res.status(404).json({ error: 'Code not found. Check the letters and numbers.' });
  if (v.redeemed_at) return res.status(409).json({ error: 'This code was already used.', voucher: publicVoucher(v, now) });
  if (new Date(v.expires_at).getTime() <= now.getTime()) return res.status(410).json({ error: 'This code has expired.', voucher: publicVoucher(v, now) });
  if ((v.pin_failures || 0) >= PIN_TRIES) return res.status(423).json({ error: 'Too many wrong PINs for this code. Ask a manager.' });
  if (!pinOk(body.pin, pin)) {
    if (await overLimit(deps, 'pin_code', sha256('code|' + code).slice(0, 32))) {
      return res.status(423).json({ error: 'Too many wrong PINs for this code. Ask a manager.' });
    }
    const n = (v.pin_failures || 0) + 1;
    await db.bumpPinFailures(code, v.pin_failures || 0, n);
    return res.status(403).json({ error: 'Wrong PIN.', tries_left: Math.max(0, PIN_TRIES - n) });
  }
  const burned = await db.burnVoucher(code, store, now.toISOString());
  if (!burned) return res.status(409).json({ error: 'This code was already used.' });
  // Staff side only (correct PIN): what to hand over, and the badge.
  let completed_all = false;
  try {
    const g = await db.getGame(burned.player_id, burned.offer_key);
    completed_all = !!(g && g.completed_all);
  } catch (e) {
    console.error('[packs] redeem game read failed:', e.message || e);
  }
  const staff = { give: burned.source === 'bonus' ? (burned.prize_staff || null) : null, completed_all };
  return res.status(200).json({ ok: true, voucher: publicVoucher(burned, now), staff });
}

async function handleStats(req, res, deps) {
  const sess = await deps.readSession(req).catch(() => null);
  if (!sess) return res.status(401).json({ error: 'not signed in' });
  if (sess.role !== 'operator') return res.status(403).json({ error: 'wrong role' });
  const { offer, status } = await deps.readOffer();
  const key = offerKey(offer);
  const s = await deps.store().stats(key);
  return res.status(200).json({ offer_key: key, game: gameLive(offer, status), ...s });
}

async function handle(req, res, deps = defaultDeps()) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url || '/', 'http://x');
    if (req.method === 'GET') {
      const view = url.searchParams.get('view') || 'state';
      if (view === 'stats') return await handleStats(req, res, deps);
      if (!deps.env.APP_JWT_SECRET) return res.status(503).json({ error: MSG.setup });
      if (url.searchParams.has('verify')) return handleVerifyLink(res, url.searchParams.get('verify') || '');
      if (view === 'state') return await handleState(req, res, deps);
      return res.status(400).json({ error: 'unknown view' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'method not allowed' });
    }
    // CSRF: JSON body (forces a CORS preflight cross-site) + same-origin.
    const ctype = String(req.headers['content-type'] || '');
    if (!ctype.toLowerCase().startsWith('application/json')) return res.status(415).json({ error: 'json only' });
    if (!originOk(req)) return res.status(403).json({ error: 'bad origin' });
    if (!deps.env.APP_JWT_SECRET) return res.status(503).json({ error: MSG.setup });
    const body = readBody(req);
    if (body.action === 'redeem') return await handleRedeem(req, res, deps, body);
    const ctx = await loadContext(req, deps);
    if (body.action === 'open') return await handleOpen(req, res, deps, ctx);
    if (body.action === 'email') return await handleEmail(req, res, deps, ctx, body);
    if (body.action === 'verify') return await handleVerify(req, res, deps, ctx, body);
    if (body.action === 'instagram' || body.action === 'app') return await handleHonor(req, res, deps, ctx, body.action);
    if (body.action === 'stop') return await handleStop(req, res, deps, ctx);
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[packs] unhandled:', e.message || e);
    return res.status(500).json({ error: MSG.oops });
  }
}

module.exports = {
  handle,
  supabaseStore,
  makeCode,
  normalizeCode,
  formatCode,
  offerKey,
  gameLive,
  normalizeEmail,
  unlockedSources,
  nextSource,
  pretzelCount,
  bonusOn,
  canStop,
  maskEmail,
  mergeGame,
  completedList,
  trailOf,
  signPlayer,
  verifyPlayerCookie,
  pinOk,
  endOfDayIn,
  voucherExpiry,
  playerState,
  magicLinkEmail,
  siteOrigin,
  summarize,
  sha256,
  COOKIE,
  MAX_PACKS,
  PRETZELS,
  SOURCES,
  BONUS_TITLE,
  BONUS_TEXT,
  CODE_ALPHABET,
  PIN_TRIES,
  STORES,
  LIMITS,
};
