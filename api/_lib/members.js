'use strict';

// api/_lib/members.js
//
// Thin helpers over the public.member / referral_code / ledger_event
// tables added by p23. api/_packs.js writes through these as a
// side-effect at the end of its existing happy paths; failures are
// logged and swallowed so a ledger outage never costs a customer a
// voucher.
//
// `sb` is a Supabase client built with the service-role key. All
// callers get it from require('./auth').supabase() (same singleton
// pattern api/_packs.js uses today).
//
// Exports:
//   ensureMember(sb, { packPlayerId, joinedSource? })
//     → memberId. Creates the member + a unique referral_code on
//     first write. Idempotent per pack_player_id.
//   linkMemberEmail(sb, memberId, email)
//     → { memberId, merged }. Sets email + email_verified_at on the
//     passed member, OR, when another member already owns that email,
//     consolidates ledger events + pack_player_id onto that owner and
//     returns the owner's memberId ("owner's existing member wins",
//     mirroring api/_packs.js' moveVouchers/mergeGames posture).
//   writeLedgerEvent(sb, { memberId, slug, ref, metadata? })
//     → { id, deduped } | { deduped: true }. Looks up earn_rule or
//     spend_rule by slug, computes the signed amount for the type,
//     and inserts. On the unique-violation of (member_id, reason,
//     ref) it swallows the error and returns deduped:true. Throws
//     only if the DB is down or the slug has no active rule.

const crypto = require('crypto');

// No 0/O, 1/I/L — same alphabet pack-voucher codes use.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const CODE_MAX_ATTEMPTS = 6;
const REF_MAX_LEN = 120;

function makeReferralCode(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function isUniqueViolation(error) {
  if (!error) return false;
  return error.code === '23505';
}

async function one(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data == null ? null : data;
}

// ─── member ────────────────────────────────────────────────────────

async function ensureMember(sb, { packPlayerId, joinedSource = 'pack_game' } = {}) {
  if (!packPlayerId) throw new Error('ensureMember: packPlayerId required');
  const existing = await one(
    sb.from('member').select('id').eq('pack_player_id', packPlayerId).maybeSingle(),
  );
  if (existing) return existing.id;
  const { data, error } = await sb.from('member')
    .insert({ pack_player_id: packPlayerId, joined_source: joinedSource })
    .select('id').single();
  let memberId;
  if (error) {
    if (!isUniqueViolation(error)) throw error;
    const racer = await one(
      sb.from('member').select('id').eq('pack_player_id', packPlayerId).maybeSingle(),
    );
    if (!racer) throw error;
    memberId = racer.id;
  } else {
    memberId = data.id;
  }
  await ensureReferralCode(sb, memberId);
  return memberId;
}

async function ensureReferralCode(sb, memberId) {
  const existing = await one(
    sb.from('referral_code').select('id').eq('member_id', memberId).maybeSingle(),
  );
  if (existing) return;
  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt++) {
    const code = makeReferralCode();
    const { error } = await sb.from('referral_code').insert({ member_id: memberId, code });
    if (!error) return;
    if (!isUniqueViolation(error)) throw error;
    // A collision on the random `code` OR on member_id. Re-read:
    const racer = await one(
      sb.from('referral_code').select('id').eq('member_id', memberId).maybeSingle(),
    );
    if (racer) return;
  }
  throw new Error('ensureReferralCode: exhausted retries assigning a unique code');
}

async function linkMemberEmail(sb, memberId, email) {
  if (!memberId) throw new Error('linkMemberEmail: memberId required');
  if (!email) throw new Error('linkMemberEmail: email required');
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner = await one(
      sb.from('member').select('id,pack_player_id').eq('email', email).maybeSingle(),
    );
    if (!owner || owner.id === memberId) {
      const nowIso = new Date().toISOString();
      const { error } = await sb.from('member')
        .update({ email, email_verified_at: nowIso }).eq('id', memberId);
      if (!error) return { memberId, merged: false };
      if (!isUniqueViolation(error)) throw error;
      continue; // race: re-read owner and merge instead
    }
    await mergeMembersInto(sb, memberId, owner);
    return { memberId: owner.id, merged: true };
  }
  throw new Error('linkMemberEmail: unresolved contention for email');
}

async function mergeMembersInto(sb, loserId, winnerSnap) {
  const winnerId = winnerSnap.id;
  // 1. Move ledger events onto the winner. A (reason, ref) pair that
  // already exists on the winner collides on the unique index; those
  // loser rows are duplicates and can be deleted.
  const losing = await one(
    sb.from('ledger_event').select('id').eq('member_id', loserId),
  );
  for (const row of losing || []) {
    const u = await sb.from('ledger_event').update({ member_id: winnerId }).eq('id', row.id);
    if (u.error) {
      if (isUniqueViolation(u.error)) {
        const d = await sb.from('ledger_event').delete().eq('id', row.id);
        if (d.error) throw d.error;
        continue;
      }
      throw u.error;
    }
  }
  // 2. Transfer pack_player_id when the winner has none and the loser
  // does. Unique index on member.pack_player_id forces a two-step
  // update (null the loser first, then write the winner).
  const loser = await one(
    sb.from('member').select('id,pack_player_id').eq('id', loserId).maybeSingle(),
  );
  if (loser && loser.pack_player_id && !winnerSnap.pack_player_id) {
    const n = await sb.from('member').update({ pack_player_id: null }).eq('id', loserId);
    if (n.error) throw n.error;
    const w = await sb.from('member').update({ pack_player_id: loser.pack_player_id }).eq('id', winnerId);
    if (w.error) throw w.error;
  }
  // 3. Drop the loser's referral_code (uniq per member) and the loser.
  const rc = await sb.from('referral_code').delete().eq('member_id', loserId);
  if (rc.error) throw rc.error;
  const del = await sb.from('member').delete().eq('id', loserId);
  if (del.error) throw del.error;
}

// ─── ledger ────────────────────────────────────────────────────────

async function writeLedgerEvent(sb, { memberId, slug, ref, metadata = {} } = {}) {
  if (!memberId) throw new Error('writeLedgerEvent: memberId required');
  if (!slug) throw new Error('writeLedgerEvent: slug required');
  if (!ref) throw new Error('writeLedgerEvent: ref required');
  const refStr = String(ref).slice(0, REF_MAX_LEN);
  const row = await buildLedgerRow(sb, { memberId, slug, ref: refStr, metadata });
  const { data, error } = await sb.from('ledger_event').insert(row).select('id').single();
  if (!error) return { id: data.id, deduped: false };
  if (isUniqueViolation(error)) return { deduped: true };
  throw error;
}

async function buildLedgerRow(sb, { memberId, slug, ref, metadata }) {
  const earn = await one(
    sb.from('earn_rule').select('currency,amount,active').eq('slug', slug).eq('active', true).maybeSingle(),
  );
  if (earn) {
    return {
      member_id: memberId,
      event_type: earn.currency === 'points' ? 'earned' : 'granted',
      currency: earn.currency,
      amount: earn.amount,
      reason: slug,
      ref,
      metadata,
    };
  }
  const spend = await one(
    sb.from('spend_rule').select('cost_currency,cost_amount,active').eq('slug', slug).eq('active', true).maybeSingle(),
  );
  if (spend) {
    return {
      member_id: memberId,
      event_type: 'spent',
      currency: spend.cost_currency,
      amount: -spend.cost_amount,
      reason: slug,
      ref,
      metadata,
    };
  }
  throw new Error(`writeLedgerEvent: no active rule for slug "${slug}"`);
}

module.exports = {
  ensureMember,
  linkMemberEmail,
  writeLedgerEvent,
  // internals, exported for tests
  makeReferralCode,
  CODE_ALPHABET,
  CODE_LEN,
};
