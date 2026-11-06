// Tests for api/_packs.js (pretzel pack game). Run: npm test
// Uses an in-memory store that enforces the same unique constraints as
// supabase/migrations/p10_pretzel_packs.sql. The Supabase adapter itself
// is not exercised here (no database in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packs = require(join(root, 'api', '_packs.js'));
const qr = require(join(root, 'api', '_qr.js'));

const SECRET = 'test-secret-not-real';
const HOST = 'the-pretzel-cup.vercel.app';
const NOW = new Date('2026-11-05T15:00:00Z');
const OFFER = {
  headline: 'Free Pretzel', game: true, instagram_handle: 'example_pretzels',
  app_store_url: 'https://apps.apple.com/us/app/example/id000000000',
  starts_at: '2026-11-01', ends_at: '2026-11-30', layout: 'green',
};

// ─── fakes ───────────────────────────────────────────────────────────
function memStore() {
  const players = new Map();
  const vouchers = [];
  const links = new Map();
  const dupe = () => ({ conflict: true });
  return {
    players, vouchers, links,
    async getPlayer(id) { return players.get(id) || null; },
    async createPlayer() {
      const p = { id: randomUUID(), email: null, email_verified_at: null, marketing_opt_in: false, instagram_at: null, app_at: null };
      players.set(p.id, p);
      return { ...p };
    },
    async findPlayerByEmail(email) { return [...players.values()].find((p) => p.email === email) || null; },
    async updatePlayer(id, patch) {
      if (patch.email && [...players.values()].some((p) => p.email === patch.email && p.id !== id)) return dupe();
      const p = players.get(id);
      Object.assign(p, patch);
      return { ok: true, player: { ...p } };
    },
    async listVouchers(pid, key) { return vouchers.filter((v) => v.player_id === pid && v.offer_key === key); },
    async insertVoucher(row) {
      if (vouchers.some((v) => v.code === row.code)) return { conflict: 'code' };
      if (vouchers.some((v) => v.player_id === row.player_id && v.offer_key === row.offer_key && v.source === row.source)) return { conflict: 'slot' };
      const v = { id: randomUUID(), redeemed_at: null, redeemed_store: null, pin_failures: 0, created_at: NOW.toISOString(), ...row };
      vouchers.push(v);
      return { ok: true, voucher: { ...v } };
    },
    async findVoucher(code) { return vouchers.find((v) => v.code === code) || null; },
    async bumpPinFailures(code, from, to) { const v = vouchers.find((x) => x.code === code && x.pin_failures === from); if (v) v.pin_failures = to; },
    async burnVoucher(code, store, nowIso) {
      const v = vouchers.find((x) => x.code === code && !x.redeemed_at && x.expires_at > nowIso);
      if (!v) return null;
      v.redeemed_at = nowIso; v.redeemed_store = store;
      return { ...v };
    },
    async insertMagicLink(row) { links.set(row.token_hash, { used_at: null, ...row }); },
    async consumeMagicLink(hash, nowIso, playerId) {
      const l = links.get(hash);
      if (!l || l.used_at || l.expires_at <= nowIso || l.player_id !== playerId) return null;
      l.used_at = nowIso;
      return { ...l };
    },
    async moveVouchers(from, to, nowIso) {
      for (const v of vouchers.filter((x) => x.player_id === from)) {
        const clash = vouchers.some((x) => x.player_id === to && x.offer_key === v.offer_key && x.source === v.source);
        if (!clash) v.player_id = to;
        else if (!v.redeemed_at) v.expires_at = nowIso;
      }
    },
    async stats(key) {
      const rows = vouchers.filter((v) => v.offer_key === key);
      const all = [...players.values()];
      return packs.summarize(rows, all.filter((p) => p.email_verified_at).length, all.filter((p) => p.instagram_at).length, all.filter((p) => p.app_at).length);
    },
  };
}
function mockRedis(fail = false) {
  const n = {}; const ttl = {};
  return {
    n, ttl,
    async set(k, v, o) { if (fail) throw new Error('redis down'); if (o && o.nx && k in n) return null; n[k] = v; ttl[k] = o && o.ex; return 'OK'; },
    async incr(k) { if (fail) throw new Error('redis down'); n[k] = (n[k] || 0) + 1; return n[k]; },
  };
}
function deps(over = {}) {
  const store = memStore();
  const sent = [];
  let i = 0;
  return {
    store: () => store, s: store, sent,
    readOffer: async () => ({ offer: OFFER, status: 'live' }),
    readSession: async () => ({ sub: 'u1', name: 'Op', role: 'operator' }),
    redis: () => null,
    sendEmail: async (m) => { sent.push(m); return { id: 'x' }; },
    env: { APP_JWT_SECRET: SECRET, PACKS_STAFF_PIN: '4821' },
    now: () => NOW,
    randomBytes,
    randomInt: (n) => (i++ * 7) % n,
    ...over,
  };
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}
const cookieOf = (res) => (res.headers['set-cookie'] || '').split(';')[0];
function post(body, { cookie, headers = {} } = {}) {
  return {
    method: 'POST', url: '/api/leads?resource=packs', body,
    headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', ...(cookie ? { cookie } : {}), ...headers },
  };
}
function get(qs, cookie) {
  return { method: 'GET', url: `/api/leads?resource=packs&${qs}`, headers: { host: HOST, 'x-forwarded-for': '203.0.113.9', ...(cookie ? { cookie } : {}) } };
}
async function call(d, req) { const res = mockRes(); await packs.handle(req, res, d); return res; }
async function openPack(d, cookie) { return call(d, post({ action: 'open' }, { cookie })); }
// Request a magic link, open it (GET redirect), confirm it (POST verify).
async function verifyEmail(d, cookie, email = 'player@example.com') {
  const r = await call(d, post({ action: 'email', email }, { cookie }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = cookie || cookieOf(r);
  const token = d.sent.at(-1).text.match(/verify=([A-Za-z0-9_-]+)/)[1];
  const g = await call(d, get('verify=' + token, c));
  assert.equal(g.headers.location, '/free-pretzels#pack_verify=' + token);
  const v = await call(d, post({ action: 'verify', token }, { cookie: c }));
  return { res: v, cookie: cookieOf(v) || c, token };
}

// ─── pure helpers ────────────────────────────────────────────────────
test('codes: alphabet, length, normalize, format', () => {
  const c = packs.makeCode();
  assert.equal(c.length, 8);
  for (const ch of c) assert.ok(packs.CODE_ALPHABET.includes(ch));
  assert.equal(packs.normalizeCode(' abcd-2345 '), 'ABCD2345');
  assert.equal(packs.normalizeCode('ABCD 2345'), 'ABCD2345');
  assert.equal(packs.normalizeCode('ABCD-0O1I'), null); // ambiguous chars are never issued
  assert.equal(packs.normalizeCode('ABC'), null);
  assert.equal(packs.normalizeCode(42), null);
  assert.equal(packs.formatCode('ABCD2345'), 'ABCD-2345');
});

test('offerKey follows the start date', () => {
  assert.equal(packs.offerKey({ starts_at: '2026-11-01' }), 'o:2026-11-01');
  assert.equal(packs.offerKey({}), 'o:open');
});

test('gameLive needs game on and a live offer', () => {
  assert.equal(packs.gameLive(OFFER, 'live'), true);
  assert.equal(packs.gameLive({ ...OFFER, game: false }, 'live'), false);
  assert.equal(packs.gameLive(OFFER, 'ended'), false);
  assert.equal(packs.gameLive(OFFER, 'scheduled'), false);
  assert.equal(packs.gameLive(null, 'none'), false);
});

test('normalizeEmail', () => {
  assert.equal(packs.normalizeEmail('  Player@Example.COM '), 'player@example.com');
  for (const bad of ['', 'no-at', 'a@b', 'a b@example.com', '<a>@example.com', 'x'.repeat(160) + '@example.com', null]) {
    assert.equal(packs.normalizeEmail(bad), null, String(bad));
  }
});

test('allowance: first, email, instagram, app, max 4', () => {
  const p = { email_verified_at: null, instagram_at: null };
  assert.deepEqual(packs.unlockedSources(p), ['first']);
  assert.equal(packs.nextSource(p, []), 'first');
  assert.equal(packs.nextSource(p, [{ source: 'first' }]), null);
  const full = { email_verified_at: 'x', instagram_at: 'y' };
  assert.equal(packs.nextSource(full, [{ source: 'first' }]), 'email');
  assert.equal(packs.nextSource(full, [{ source: 'first' }, { source: 'email' }]), 'instagram');
  assert.equal(packs.nextSource(full, [{ source: 'first' }, { source: 'email' }, { source: 'instagram' }]), null);
  assert.equal(packs.nextSource({ instagram_at: 'y' }, [{ source: 'first' }]), 'instagram');
  const all = { email_verified_at: 'x', instagram_at: 'y', app_at: 'z' };
  assert.deepEqual(packs.unlockedSources(all), ['first', 'email', 'instagram', 'app']);
  assert.equal(packs.nextSource(all, [{ source: 'first' }, { source: 'email' }, { source: 'instagram' }]), 'app');
  assert.equal(packs.nextSource(all, packs.SOURCES.map((source) => ({ source }))), null);
  assert.equal(packs.nextSource({ app_at: 'z' }, [{ source: 'first' }]), 'app');
  assert.equal(packs.MAX_PACKS, 4);
});

test('player cookie: signed, tamper-proof', () => {
  const id = randomUUID();
  const v = packs.signPlayer(id, SECRET);
  assert.equal(packs.verifyPlayerCookie(v, SECRET), id);
  assert.equal(packs.verifyPlayerCookie(v, 'other'), null);
  assert.equal(packs.verifyPlayerCookie(randomUUID() + v.slice(36), SECRET), null);
  assert.equal(packs.verifyPlayerCookie('not-a-uuid.abc', SECRET), null);
  assert.equal(packs.verifyPlayerCookie(undefined, SECRET), null);
  assert.equal(packs.verifyPlayerCookie(v, ''), null);
});

test('pinOk', () => {
  assert.equal(packs.pinOk('4821', '4821'), true);
  assert.equal(packs.pinOk('4822', '4821'), false);
  assert.equal(packs.pinOk('48210', '4821'), false);
  assert.equal(packs.pinOk('', '4821'), false);
  assert.equal(packs.pinOk(null, '4821'), false);
  assert.equal(packs.pinOk('4821', undefined), false); // unset PIN never matches
  assert.equal(packs.pinOk('abcd', 'abcd'), false);
});

test('voucher expiry is the end of the offer day in New York', () => {
  // Nov 30 2026 is EST (UTC-5): 23:59:59 local = 04:59:59Z next day.
  assert.equal(packs.endOfDayIn('2026-11-30').toISOString(), '2026-12-01T04:59:59.000Z');
  // Jul 4 is EDT (UTC-4).
  assert.equal(packs.endOfDayIn('2026-07-04').toISOString(), '2026-07-05T03:59:59.000Z');
  // DST end day (Nov 1 2026).
  assert.equal(packs.endOfDayIn('2026-11-01').toISOString(), '2026-11-02T04:59:59.000Z');
  const noEnd = packs.voucherExpiry({}, NOW);
  assert.equal(noEnd.getTime() - NOW.getTime(), 30 * 86400000);
});

test('magic link email: plain brand copy, no emojis or dashes', () => {
  const m = packs.magicLinkEmail('https://example.com/x?verify=abc');
  for (const t of [m.subject, m.preheader, m.text, m.html]) {
    assert.ok(!/[—–]/.test(t), 'no em/en dashes');
    assert.ok(!/\p{Extended_Pictographic}/u.test(t.replace(/®/g, '')), 'no emojis');
  }
  assert.ok(m.text.includes('https://example.com/x?verify=abc'));
});

// ─── offer validation (game flag) ───────────────────────────────────
test('validateOffer: game flag defaults off, handle validated', () => {
  const base = { headline: 'Free Pretzel' };
  assert.equal(qr.validateOffer(base).offer.game, false);
  assert.equal(qr.validateOffer({ ...base, game: 'true' }).offer.game, false);
  assert.equal(qr.validateOffer({ ...base, game: true, starts_at: '2026-11-01' }).offer.game, true);
  assert.equal(qr.validateOffer({ ...base, instagram_handle: '@philly.pretzel_1' }).offer.instagram_handle, 'philly.pretzel_1');
  assert.ok(qr.validateOffer({ ...base, instagram_handle: 'bad handle' }).errors);
  assert.ok(qr.validateOffer({ ...base, instagram_handle: 'x'.repeat(31) }).errors);
  assert.ok(qr.validateOffer({ ...base, instagram_handle: 'https://instagram.com/x' }).errors);
});

// ─── HTTP: state + open ─────────────────────────────────────────────
test('state: new visitor can open one pack, game on', async () => {
  const d = deps();
  const r = await call(d, get('view=state'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.game, true);
  assert.equal(r.body.allowed, 1);
  assert.equal(r.body.can_open, true);
  assert.equal(r.body.bonuses.email, 'locked');
  assert.equal(r.body.bonuses.instagram, 'locked');
  assert.equal(r.body.bonuses.app, 'locked');
  assert.equal(r.body.app_store_url, OFFER.app_store_url);
  assert.equal(r.body.max, 4);
  assert.equal(r.body.headline, OFFER.headline);
  assert.equal(r.body.stamp, '');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(d.s.players.size, 0, 'state never creates a player');
});

test('game off: state says off and open is refused', async () => {
  const d = deps({ readOffer: async () => ({ offer: { ...OFFER, game: false }, status: 'live' }) });
  assert.deepEqual((await call(d, get('view=state'))).body, { game: false, status: 'live' });
  const r = await openPack(d);
  assert.equal(r.statusCode, 409);
  assert.equal(d.s.vouchers.length, 0);
});

test('ended offer: game off', async () => {
  const d = deps({ readOffer: async () => ({ offer: OFFER, status: 'ended' }) });
  assert.equal((await call(d, get('view=state'))).body.game, false);
});

test('instagram bonus hidden when no handle is set', async () => {
  const d = deps({ readOffer: async () => ({ offer: { ...OFFER, instagram_handle: '' }, status: 'live' }) });
  const r = await call(d, get('view=state'));
  assert.equal(r.body.instagram, null);
  assert.equal(r.body.bonuses.instagram, 'off');
  assert.equal((await call(d, post({ action: 'instagram' }))).statusCode, 409);
});

test('open: first pack wins a voucher and sets a signed cookie', async () => {
  const d = deps();
  const r = await openPack(d);
  assert.equal(r.statusCode, 200);
  assert.match(r.body.voucher.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(r.body.voucher.source, 'first');
  assert.equal(r.body.voucher.expires_at, '2026-12-01T04:59:59.000Z');
  assert.match(r.headers['set-cookie'], /^ppf_player=[0-9a-f-]{36}\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=\d+$/);
  assert.equal(r.body.state.used, 1);
  assert.equal(r.body.state.can_open, false);
});

test('open: second pack without a bonus is refused', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  const r = await openPack(d, c);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.code, 'none_left');
  assert.equal(d.s.vouchers.length, 1);
});

test('open: double tap race mints exactly one voucher', async () => {
  const d = deps();
  const c = cookieOf(await call(d, post({ action: 'instagram' }))); // creates the player
  const before = d.s.vouchers.length;
  const [a, b, x] = await Promise.all([openPack(d, c), openPack(d, c), openPack(d, c)]);
  const ok = [a, b, x].filter((r) => r.statusCode === 200);
  // first + instagram are unlocked: 2 slots, never 3.
  assert.equal(ok.length, 2);
  assert.equal(d.s.vouchers.length - before, 2);
  assert.deepEqual(d.s.vouchers.map((v) => v.source).sort(), ['first', 'instagram']);
});

test('open: retries on a code collision', async () => {
  const d = deps({ randomInt: () => 0 }); // always AAAAAAAA
  const c1 = cookieOf(await openPack(d));
  assert.ok(c1);
  const r = await openPack(d); // new player, same code -> collision every time
  assert.equal(r.statusCode, 409);
  assert.equal(d.s.vouchers.length, 1, 'never two vouchers with one code');
});

test('open: forged cookie is ignored (new player)', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  const forged = c.replace(/\.[^.]+$/, '.AAAA');
  const r = await openPack(d, forged);
  assert.equal(r.statusCode, 200);
  assert.equal(d.s.players.size, 2);
});

test('full run: first + email + instagram + app = 4, then a 5th is impossible', async () => {
  const d = deps();
  let c = cookieOf(await openPack(d));
  const v = await verifyEmail(d, c);
  assert.equal(v.res.statusCode, 200);
  assert.equal(v.res.body.result, 'verified');
  assert.equal(v.res.body.state.bonuses.email, 'unlocked');
  c = v.cookie;
  assert.equal((await openPack(d, c)).body.voucher.source, 'email');
  const ig = await call(d, post({ action: 'instagram' }, { cookie: c }));
  assert.equal(ig.body.state.bonuses.instagram, 'unlocked');
  assert.equal((await openPack(d, c)).body.voucher.source, 'instagram');
  const app = await call(d, post({ action: 'app' }, { cookie: c }));
  assert.equal(app.body.state.bonuses.app, 'unlocked');
  assert.equal((await openPack(d, c)).body.voucher.source, 'app');
  const fifth = await openPack(d, c);
  assert.equal(fifth.statusCode, 409);
  assert.equal(fifth.body.state.used, 4);
  assert.equal(fifth.body.state.bonuses.email, 'used');
  assert.equal(fifth.body.state.bonuses.instagram, 'used');
  assert.equal(fifth.body.state.bonuses.app, 'used');
});

test('app tap counts once and is off without an App Store URL', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  await call(d, post({ action: 'app' }, { cookie: c }));
  const first = [...d.s.players.values()][0].app_at;
  assert.ok(first);
  await call(d, post({ action: 'app' }, { cookie: c }));
  assert.equal([...d.s.players.values()][0].app_at, first);
  assert.equal((await openPack(d, c)).body.voucher.source, 'app');
  assert.equal((await openPack(d, c)).statusCode, 409);
  const off = deps({ readOffer: async () => ({ offer: { ...OFFER, app_store_url: '' }, status: 'live' }) });
  assert.equal((await call(off, get('view=state'))).body.bonuses.app, 'off');
  assert.equal((await call(off, post({ action: 'app' }))).statusCode, 409);
  assert.equal(off.s.players.size, 0);
});

test('validateOffer: app_store_url must be an App Store link', () => {
  const base = { headline: 'x' };
  assert.equal(qr.validateOffer({ ...base, app_store_url: 'https://apps.apple.com/us/app/ppf/id123' }).offer.app_store_url, 'https://apps.apple.com/us/app/ppf/id123');
  assert.equal(qr.validateOffer(base).offer.app_store_url, '');
  for (const bad of ['http://apps.apple.com/x', 'https://apps.apple.com.evil.example.com/x', 'https://example.com/app', 'javascript:alert(1)', 'https://apps.apple.com/' + 'a'.repeat(300), 'https://apps.apple.com/x"><b>']) {
    assert.ok(qr.validateOffer({ ...base, app_store_url: bad }).errors, bad);
  }
});

test('instagram tap counts once', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  await call(d, post({ action: 'instagram' }, { cookie: c }));
  const first = [...d.s.players.values()][0].instagram_at;
  await call(d, post({ action: 'instagram' }, { cookie: c }));
  assert.equal([...d.s.players.values()][0].instagram_at, first);
  assert.equal((await openPack(d, c)).statusCode, 200);
  assert.equal((await openPack(d, c)).statusCode, 409);
});

// ─── email + magic link ─────────────────────────────────────────────
test('email: stores a hashed token, sends a link, never stores the raw token', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  const r = await call(d, post({ action: 'email', email: 'Player@Example.com', marketing_opt_in: true }, { cookie: c }));
  assert.equal(r.statusCode, 200);
  assert.equal(d.sent.length, 1);
  assert.equal(d.sent[0].to, 'player@example.com');
  const token = d.sent[0].text.match(/verify=([A-Za-z0-9_-]+)/)[1];
  assert.ok(d.sent[0].text.includes(`https://${HOST}/api/leads?resource=packs&verify=`));
  const [hash, row] = [...d.s.links.entries()][0];
  assert.equal(hash, packs.sha256(token));
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(row.marketing_opt_in, true);
  // The email is not on the player until the link is clicked.
  assert.equal([...d.s.players.values()][0].email, null);
});

test('email: bad address -> 400, send failure -> 502 and first pack unaffected', async () => {
  const d = deps({ sendEmail: async () => { throw new Error('gmail auth failed'); } });
  assert.equal((await call(d, post({ action: 'email', email: 'nope' }))).statusCode, 400);
  const r = await call(d, post({ action: 'email', email: 'player@example.com' }));
  assert.equal(r.statusCode, 502);
  assert.match(r.body.error, /could not send/);
  assert.equal((await openPack(d, cookieOf(r))).statusCode, 200);
});

test('magic link: GET never uses the token (mail scanners)', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  await call(d, post({ action: 'email', email: 'player@example.com' }, { cookie: c }));
  const token = d.sent[0].text.match(/verify=([A-Za-z0-9_-]+)/)[1];
  for (let i = 0; i < 3; i++) await call(d, get('verify=' + token)); // scanner, no cookie
  assert.equal([...d.s.links.values()][0].used_at, null);
  assert.equal([...d.s.players.values()][0].email, null);
  const v = await call(d, post({ action: 'verify', token }, { cookie: c }));
  assert.equal(v.body.result, 'verified');
});

test('magic link: works once', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  const v = await verifyEmail(d, c);
  const again = await call(d, post({ action: 'verify', token: v.token }, { cookie: c }));
  assert.equal(again.statusCode, 410);
  assert.equal(again.body.result, 'expired');
});

test('magic link: expired after 1 hour', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  await call(d, post({ action: 'email', email: 'player@example.com' }, { cookie: c }));
  const token = d.sent[0].text.match(/verify=([A-Za-z0-9_-]+)/)[1];
  d.now = () => new Date(NOW.getTime() + 61 * 60 * 1000);
  const r = await call(d, post({ action: 'verify', token }, { cookie: c }));
  assert.equal(r.body.result, 'expired');
  assert.equal([...d.s.players.values()][0].email_verified_at, null);
});

test('magic link: garbage token -> invalid', async () => {
  const d = deps();
  assert.equal((await call(d, get('verify=%3Cscript%3E'))).headers.location, '/free-pretzels?pack_email=invalid');
  assert.equal((await call(d, post({ action: 'verify', token: '<x>' }))).body.result, 'invalid');
});

test('magic link: only the browser that asked can use it (no email hijack)', async () => {
  const d = deps();
  // Attacker asks for a link to the victim's address.
  const attacker = cookieOf(await openPack(d));
  await call(d, post({ action: 'email', email: 'victim@example.com' }, { cookie: attacker }));
  const token = d.sent[0].text.match(/verify=([A-Za-z0-9_-]+)/)[1];
  // Victim (or the victim's mail scanner) opens it in their own browser.
  const victim = cookieOf(await openPack(d));
  const r = await call(d, post({ action: 'verify', token }, { cookie: victim }));
  assert.equal(r.statusCode, 410);
  const noCookie = await call(d, post({ action: 'verify', token }));
  assert.equal(noCookie.body.result, 'device');
  assert.ok([...d.s.players.values()].every((p) => p.email === null), 'nobody got the email');
  assert.equal(r.headers['set-cookie'], undefined);
});

test('one verified email per player', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  // Ask for two links before verifying either.
  await call(d, post({ action: 'email', email: 'one@example.com' }, { cookie: c }));
  await call(d, post({ action: 'email', email: 'two@example.com' }, { cookie: c }));
  const [t1, t2] = d.sent.map((m) => m.text.match(/verify=([A-Za-z0-9_-]+)/)[1]);
  assert.equal((await call(d, post({ action: 'verify', token: t1 }, { cookie: c }))).body.result, 'verified');
  const r2 = await call(d, post({ action: 'verify', token: t2 }, { cookie: c }));
  assert.equal(r2.body.result, 'already');
  assert.equal([...d.s.players.values()][0].email, 'one@example.com');
});

test('email link points at our own host, never a spoofed one', () => {
  const r = (host) => packs.siteOrigin({ headers: { host } });
  assert.equal(r('the-pretzel-cup.vercel.app'), 'https://the-pretzel-cup.vercel.app');
  assert.equal(r('the-pretzel-cup-abc123-team.vercel.app'), 'https://the-pretzel-cup-abc123-team.vercel.app');
  assert.equal(r('localhost:3000'), 'http://localhost:3000');
  assert.equal(r('evil.example.com'), 'https://the-pretzel-cup.vercel.app');
  assert.equal(r('the-pretzel-cup.vercel.app.evil.example.com'), 'https://the-pretzel-cup.vercel.app');
  assert.equal(packs.siteOrigin({ headers: { host: 'evil.example.com' } }, { PACKS_SITE_URL: 'https://pretzels.example.com' }), 'https://pretzels.example.com');
});

test('verify on a new device merges into the email player; limit follows the person', async () => {
  const d = deps();
  // Phone A: first pack, verify email, email pack.
  let a = cookieOf(await openPack(d));
  a = (await verifyEmail(d, a)).cookie;
  assert.equal((await openPack(d, a)).statusCode, 200);
  // Phone B: fresh cookie, first pack (the accepted cookie-clearing gap).
  let b = cookieOf(await openPack(d));
  await call(d, post({ action: 'instagram' }, { cookie: b }));
  await call(d, post({ action: 'app' }, { cookie: b }));
  // Phone B verifies the same email -> becomes the same person.
  b = (await verifyEmail(d, b)).cookie;
  const idA = packs.verifyPlayerCookie(a.split('=')[1], SECRET);
  const idB = packs.verifyPlayerCookie(b.split('=')[1], SECRET);
  assert.equal(idA, idB, 'same player after merge');
  // Instagram unlock carried over; email bonus already used.
  const s = (await call(d, get('view=state', b))).body;
  assert.equal(s.bonuses.email, 'used');
  assert.equal(s.bonuses.instagram, 'unlocked');
  assert.equal(s.bonuses.app, 'unlocked', 'app tap carried over on merge');
  assert.equal((await openPack(d, b)).body.voucher.source, 'instagram');
  assert.equal((await openPack(d, b)).body.voucher.source, 'app');
  assert.equal((await openPack(d, b)).statusCode, 409, 'no 5th pack on the merged player');
  const owned = d.s.vouchers.filter((v) => v.player_id === idA);
  assert.equal(owned.length, 4);
  // Phone B's duplicate first pack was voided: 4 live codes for this email, not 5.
  const live = d.s.vouchers.filter((v) => !v.redeemed_at && v.expires_at > NOW.toISOString());
  assert.equal(live.length, 4);
});

test('email already verified -> 409', async () => {
  const d = deps();
  const c = (await verifyEmail(d, cookieOf(await openPack(d)))).cookie;
  assert.equal((await call(d, post({ action: 'email', email: 'other@example.com' }, { cookie: c }))).statusCode, 409);
});

// ─── redeem ─────────────────────────────────────────────────────────
async function oneVoucher(d) {
  const r = await openPack(d);
  return r.body.voucher.code;
}

test('redeem: wrong PIN refused, right PIN burns, second burn refused', async () => {
  const d = deps();
  const code = await oneVoucher(d);
  const bad = await call(d, post({ action: 'redeem', code, pin: '0000', store: 'lynbrook' }));
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.body.tries_left, 4);
  const ok = await call(d, post({ action: 'redeem', code: code.toLowerCase(), pin: '4821', store: 'lynbrook' }));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.voucher.redeemed_store, 'Lynbrook');
  const twice = await call(d, post({ action: 'redeem', code, pin: '4821', store: 'franklin_square' }));
  assert.equal(twice.statusCode, 409);
  assert.equal(d.s.vouchers[0].redeemed_store, 'lynbrook');
});

test('redeem: concurrent burns, only one wins', async () => {
  const d = deps();
  const code = await oneVoucher(d);
  const rs = await Promise.all([1, 2, 3].map(() => call(d, post({ action: 'redeem', code, pin: '4821', store: 'lynbrook' }))));
  assert.equal(rs.filter((r) => r.statusCode === 200).length, 1);
});

test('redeem: 5 wrong PINs lock the code', async () => {
  const d = deps();
  const code = await oneVoucher(d);
  for (let i = 0; i < 5; i++) await call(d, post({ action: 'redeem', code, pin: '1111', store: 'lynbrook' }));
  const r = await call(d, post({ action: 'redeem', code, pin: '4821', store: 'lynbrook' }));
  assert.equal(r.statusCode, 423);
  assert.equal(d.s.vouchers[0].redeemed_at, null);
});

test('redeem: expired, unknown, no store, PIN not configured', async () => {
  const d = deps();
  const code = await oneVoucher(d);
  assert.equal((await call(d, post({ action: 'redeem', code: 'ZZZZ-ZZZZ', pin: '4821', store: 'lynbrook' }))).statusCode, 404);
  assert.equal((await call(d, post({ action: 'redeem', code, pin: '4821' }))).statusCode, 400);
  const noPin = deps({ env: { APP_JWT_SECRET: SECRET } });
  assert.equal((await call(noPin, post({ action: 'redeem', code, pin: '4821', store: 'lynbrook' }))).statusCode, 503);
  d.now = () => new Date('2026-12-02T00:00:00Z');
  assert.equal((await call(d, post({ action: 'redeem', code, pin: '4821', store: 'lynbrook' }))).statusCode, 410);
});

// ─── rate limits, outages, CSRF ─────────────────────────────────────
test('rate limit: open is capped per IP', async () => {
  const r = mockRedis();
  const d = deps({ redis: () => r, randomInt }); // real codes: 60 opens must not collide
  const codes = [];
  for (let i = 0; i < 62; i++) codes.push((await openPack(d)).statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 60);
  assert.equal(codes.at(-1), 429);
  const key = Object.keys(r.ttl).find((k) => k.includes(':open:'));
  assert.equal(r.ttl[key], 600, 'counter is created with its TTL');
});

test('rate limit: magic link sends capped per address', async () => {
  const r = mockRedis();
  const d = deps({ redis: () => r });
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push((await call(d, post({ action: 'email', email: 'player@example.com' }, { headers: { 'x-forwarded-for': '198.51.100.' + i } }))).statusCode);
  }
  assert.deepEqual(out, [200, 200, 200, 429]);
});

test('rate limit: PIN guessing across codes is capped per IP', async () => {
  const r = mockRedis();
  const d = deps({ redis: () => r });
  const code = await oneVoucher(d);
  let last;
  for (let i = 0; i < 13; i++) last = await call(d, post({ action: 'redeem', code: 'ZZZZ-ZZZZ', pin: '0000', store: 'lynbrook' }));
  assert.equal(last.statusCode, 429);
  assert.ok(code);
});

test('validateOffer: game on needs a start date (limits key on it)', () => {
  assert.ok(qr.validateOffer({ headline: 'x', game: true }).errors);
  assert.ok(qr.validateOffer({ headline: 'x', game: true, starts_at: '2026-11-01' }).offer);
  assert.ok(qr.validateOffer({ headline: 'x', game: false }).offer);
});

test('redeem: wrong PINs are capped per code even across IPs', async () => {
  const r = mockRedis();
  const d = deps({ redis: () => r });
  const code = await oneVoucher(d);
  d.s.bumpPinFailures = async () => {}; // simulate lost DB writes (parallel race)
  const out = [];
  for (let i = 0; i < 7; i++) {
    out.push((await call(d, post({ action: 'redeem', code, pin: '0000', store: 'lynbrook' }, { headers: { 'x-forwarded-for': '198.51.100.' + i } }))).statusCode);
  }
  assert.deepEqual(out, [403, 403, 403, 403, 403, 423, 423]);
});

test('Redis down: first pack still opens', async () => {
  const d = deps({ redis: () => mockRedis(true) });
  assert.equal((await openPack(d)).statusCode, 200);
});

test('database down: friendly 500, no crash', async () => {
  const d = deps({ store: () => { throw new Error('Supabase env vars missing'); } });
  const r = await openPack(d);
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /counter/);
  assert.equal((await call(d, get('view=state'))).statusCode, 500);
});

test('APP_JWT_SECRET missing: 503, nothing written', async () => {
  const d = deps({ env: { PACKS_STAFF_PIN: '4821' } });
  assert.equal((await openPack(d)).statusCode, 503);
  assert.equal((await call(d, get('view=state'))).statusCode, 503);
  assert.equal(d.s.players.size, 0);
});

test('CSRF: cross-origin and non-JSON posts refused', async () => {
  const d = deps();
  assert.equal((await call(d, post({ action: 'open' }, { headers: { origin: 'https://evil.example.com' } }))).statusCode, 403);
  const noOrigin = post({ action: 'open' });
  delete noOrigin.headers.origin;
  assert.equal((await call(d, noOrigin)).statusCode, 403);
  assert.equal((await call(d, post({ action: 'open' }, { headers: { 'content-type': 'text/plain' } }))).statusCode, 415);
  assert.equal(d.s.vouchers.length, 0);
});

test('unknown action / view / method', async () => {
  const d = deps();
  assert.equal((await call(d, post({ action: 'nope' }))).statusCode, 400);
  assert.equal((await call(d, get('view=nope'))).statusCode, 400);
  assert.equal((await call(d, { method: 'DELETE', url: '/', headers: {} })).statusCode, 405);
});

// ─── operator stats ─────────────────────────────────────────────────
test('stats: operator only, counts per offer', async () => {
  const d = deps();
  const c = cookieOf(await openPack(d));
  await verifyEmail(d, c);
  const code = await oneVoucher(d);
  await call(d, post({ action: 'redeem', code, pin: '4821', store: 'lynbrook' }));
  const r = await call(d, get('view=stats'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.offer_key, 'o:2026-11-01');
  assert.deepEqual(r.body.opened, { first: 2, email: 0, instagram: 0, app: 0, total: 2 });
  assert.equal(r.body.app_taps, 0);
  assert.equal(r.body.redeemed, 1);
  assert.equal(r.body.emails_verified, 1);
  const anon = deps({ readSession: async () => null });
  assert.equal((await call(anon, get('view=stats'))).statusCode, 401);
  const baker = deps({ readSession: async () => ({ role: 'baker' }) });
  assert.equal((await call(baker, get('view=stats'))).statusCode, 403);
});

// ─── dispatcher ─────────────────────────────────────────────────────
test('leads.js routes ?resource=packs to _packs.js', async () => {
  const src = (await import('node:fs')).readFileSync(join(root, 'api', 'leads.js'), 'utf8');
  assert.match(src, /resource === 'packs'\) return require\('\.\/_packs'\)\.handle\(req, res\)/);
});
