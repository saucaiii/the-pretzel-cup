// Tests for api/_qr.js (QR + offer control panel). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const qr = require(join(root, 'api', '_qr.js'));

const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const mwCopy = join(cacheDir, 'qr-parity-middleware.test.mjs');
copyFileSync(join(root, 'middleware.js'), mwCopy);
const mw = await import(pathToFileURL(mwCopy).href);

const REQ = 'https://the-pretzel-cup.vercel.app/api/leads?resource=qr';

// ─── target validation + parity with middleware ─────────────────────
const TARGETS = [
  ['/free-pretzels', true], ['/menu?item=cup', true], ['https://example.com/promo', true],
  ['http://example.com', true], ['  /free-pretzels  ', true],
  ['', false], ['   ', false], [null, false], [42, false], ['//evil.example.com', false],
  ['/\\evil.example.com', false], ['javascript:alert(1)', false], ['ftp://example.com/x', false],
  ['not a url', false], ['/scan', false], ['/scan/', false], ['/scan?x=1', false],
  ['https://the-pretzel-cup.vercel.app/scan', false], ['https://example.com/scan', true],
  ['/scanner', true], ['/' + 'a'.repeat(2000), false],
];
for (const [input, ok] of TARGETS) {
  test(`parseTarget ${JSON.stringify(input).slice(0, 40)} -> ${ok}`, () => {
    assert.equal(qr.parseTarget(input, REQ) !== null, ok);
  });
  test(`middleware parity ${JSON.stringify(input).slice(0, 40)}`, () => {
    assert.equal(mw.parseTarget(input, REQ) !== null, qr.parseTarget(input, REQ) !== null);
  });
}

test('sanitizePlacement', () => {
  assert.equal(qr.sanitizePlacement('door_sticker'), 'door_sticker');
  assert.equal(qr.sanitizePlacement(' Counter-Card '), 'counter-card');
  assert.equal(qr.sanitizePlacement('a b'), 'other');
  assert.equal(qr.sanitizePlacement('x'.repeat(33)), 'other');
  assert.equal(qr.sanitizePlacement(undefined), 'other');
  assert.equal(mw.sanitizePlacement('a b'), 'other');
});

// ─── offer validation ──────────────────────────────────────────────
const GOOD = {
  headline: 'Free Pretzel. On Us.', details: 'Crave it. Love it. Share it.',
  steps: ['Show this screen', 'Pick your pretzel'], fine_print: 'Limit one per guest.',
  stamp: 'This week only', accent: 'Fresh', layout: 'black', starts_at: '2026-11-01', ends_at: '2026-11-30',
};

test('valid offer passes and drops unknown keys', () => {
  const r = qr.validateOffer({ ...GOOD, evil: '<script>' });
  assert.ok(r.offer);
  assert.equal(r.offer.evil, undefined);
  assert.equal(r.offer.layout, 'black');
  assert.equal(r.offer.tagline_color, 'white');
});

test('gold-light layout locks tagline to black', () => {
  assert.equal(qr.validateOffer({ ...GOOD, layout: 'gold-light' }).offer.tagline_color, 'black');
});

for (const [name, patch] of [
  ['missing headline', { headline: '' }],
  ['headline too long', { headline: 'x'.repeat(81) }],
  ['details too long', { details: 'x'.repeat(601) }],
  ['too many steps', { steps: ['a', 'b', 'c', 'd', 'e', 'f'] }],
  ['step too long', { steps: ['x'.repeat(141)] }],
  ['fine print too long', { fine_print: 'x'.repeat(801) }],
  ['stamp too long', { stamp: 'x'.repeat(41) }],
  ['cream layout', { layout: 'cream' }],
  ['gradient layout', { layout: 'green-gold-gradient' }],
  ['bad start date', { starts_at: '11/01/2026' }],
  ['impossible date', { ends_at: '2026-02-30' }],
  ['end before start', { starts_at: '2026-12-01', ends_at: '2026-11-01' }],
  ['multi-word accent', { accent: 'so fresh' }],
]) {
  test(`offer rejected: ${name}`, () => {
    assert.ok(qr.validateOffer({ ...GOOD, ...patch }).errors);
  });
}

test('offer status by New York date', () => {
  const o = { starts_at: '2026-11-10', ends_at: '2026-11-20' };
  assert.equal(qr.offerStatus(o, new Date('2026-11-09T12:00:00Z')), 'scheduled');
  assert.equal(qr.offerStatus(o, new Date('2026-11-15T12:00:00Z')), 'live');
  assert.equal(qr.offerStatus(o, new Date('2026-11-20T23:00:00Z')), 'live'); // 6pm NY, still the 20th
  assert.equal(qr.offerStatus(o, new Date('2026-11-21T06:00:00Z')), 'ended');
  assert.equal(qr.offerStatus(null), 'none');
});

// ─── brand voice lint ──────────────────────────────────────────────
const rules = (o) => qr.lintCopy(o).map((x) => x.rule);
test('lint: clean copy has no flags', () => assert.deepEqual(rules(GOOD), []));
test('lint: em dash', () => assert.ok(rules({ ...GOOD, details: 'Fresh — hot' }).includes('dash')));
test('lint: en dash', () => assert.ok(rules({ ...GOOD, headline: 'Mon–Fri' }).includes('dash')));
test('lint: emoji', () => assert.ok(rules({ ...GOOD, steps: ['Show this \u{1F968}'] }).includes('emoji')));
test('lint: stacked !!', () => assert.ok(rules({ ...GOOD, headline: 'Free!!' }).includes('stacked')));
test('lint: stacked ?!', () => assert.ok(rules({ ...GOOD, stamp: 'Hungry?!' }).includes('stacked')));
test('lint: long headline', () => assert.ok(rules({ ...GOOD, headline: 'x'.repeat(49) }).includes('long')));
test('lint: second tagline in headline', () => assert.ok(rules({ ...GOOD, headline: 'Made to Crave' }).includes('tagline')));
test('lint: crave line in stamp', () => assert.ok(rules({ ...GOOD, stamp: 'Crave big' }).includes('tagline')));
test('lint: crave in details is fine', () => assert.deepEqual(rules({ ...GOOD, details: 'Crave big, snack bigger.' }), []));
test('lint: off-palette layout', () => assert.ok(rules({ ...GOOD, layout: 'cream' }).includes('palette')));

// ─── HTTP handler ──────────────────────────────────────────────────
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function mockRedis() {
  const lists = {}; const hashes = {};
  return {
    lists, hashes,
    async lpush(k, v) { (lists[k] ||= []).unshift(v); },
    async ltrim(k, a, b) { lists[k] = (lists[k] || []).slice(a, b + 1); },
    async lrange(k, a, b) { return (lists[k] || []).slice(a, b + 1); },
    async hgetall(k) { return hashes[k] || null; },
  };
}
function deps(over = {}) {
  const r = mockRedis();
  const calls = [];
  return {
    calls, r,
    readSession: async () => ({ sub: 'u1', name: 'Op', role: 'operator' }),
    edgeGet: async () => undefined,
    redis: () => r,
    fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '' }; },
    env: { EDGE_CONFIG_ID: 'ecfg_test', EDGE_CONFIG_WRITE_TOKEN: 'test-token', EDGE_CONFIG: 'x' },
    now: () => new Date('2026-11-05T15:00:00Z'),
    ...over,
  };
}
const HOST = 'the-pretzel-cup.vercel.app';
function post(body, headers = {}) {
  return {
    method: 'POST', url: '/api/leads?resource=qr', body,
    headers: { host: HOST, origin: `https://${HOST}`, 'content-type': 'application/json', ...headers },
  };
}
function get(view) {
  return { method: 'GET', url: `/api/leads?resource=qr&view=${view}`, headers: { host: HOST } };
}

test('qr: no session -> 401', async () => {
  const res = mockRes();
  await qr.handle(get('config'), res, 'qr', deps({ readSession: async () => null }));
  assert.equal(res.statusCode, 401);
});
test('qr: wrong role -> 403', async () => {
  const res = mockRes();
  await qr.handle(get('config'), res, 'qr', deps({ readSession: async () => ({ role: 'baker' }) }));
  assert.equal(res.statusCode, 403);
});
test('qr: session read throwing -> 401', async () => {
  const res = mockRes();
  await qr.handle(get('config'), res, 'qr', deps({ readSession: async () => { throw new Error('no secret'); } }));
  assert.equal(res.statusCode, 401);
});
test('qr POST: bad origin -> 403, nothing written', async () => {
  const d = deps(); const res = mockRes();
  await qr.handle(post({ action: 'set_target', scan_target: '/' }, { origin: 'https://evil.example.com' }), res, 'qr', d);
  assert.equal(res.statusCode, 403);
  assert.equal(d.calls.length, 0);
});
test('qr POST: missing origin -> 403', async () => {
  const d = deps(); const res = mockRes();
  const req = post({ action: 'set_target', scan_target: '/' });
  delete req.headers.origin;
  await qr.handle(req, res, 'qr', d);
  assert.equal(res.statusCode, 403);
});
test('qr POST: form content type -> 415', async () => {
  const d = deps(); const res = mockRes();
  await qr.handle(post({ action: 'reset_target' }, { 'content-type': 'application/x-www-form-urlencoded' }), res, 'qr', d);
  assert.equal(res.statusCode, 415);
  assert.equal(d.calls.length, 0);
});
test('qr POST: set_target writes Edge Config + history', async () => {
  const d = deps(); const res = mockRes();
  await qr.handle(post({ action: 'set_target', scan_target: '/products' }), res, 'qr', d);
  assert.equal(res.statusCode, 200);
  assert.equal(d.calls.length, 1);
  assert.match(d.calls[0].url, /\/v1\/edge-config\/ecfg_test\/items$/);
  assert.equal(d.calls[0].opts.method, 'PATCH');
  assert.equal(d.calls[0].opts.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(d.calls[0].opts.body), { items: [{ operation: 'upsert', key: 'scan_target', value: '/products' }] });
  const h = JSON.parse(d.r.lists['qr:history'][0]);
  assert.equal(h.kind, 'scan_target');
  assert.equal(h.by_name, 'Op');
});
test('qr POST: self-loop target rejected', async () => {
  const d = deps(); const res = mockRes();
  await qr.handle(post({ action: 'set_target', scan_target: '/scan' }), res, 'qr', d);
  assert.equal(res.statusCode, 400);
  assert.equal(d.calls.length, 0);
});
test('qr POST: missing write env -> 503 not configured', async () => {
  const d = deps({ env: {} }); const res = mockRes();
  await qr.handle(post({ action: 'reset_target' }), res, 'qr', d);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /not configured/);
});
test('qr POST: Edge Config API error -> 502, no history entry', async () => {
  const d = deps({ fetch: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }) });
  const res = mockRes();
  await qr.handle(post({ action: 'reset_target' }), res, 'qr', d);
  assert.equal(res.statusCode, 502);
  assert.equal(d.r.lists['qr:history'], undefined);
});
test('qr POST: invalid offer -> 400', async () => {
  const d = deps(); const res = mockRes();
  await qr.handle(post({ action: 'publish_offer', offer: { ...GOOD, layout: 'cream' } }), res, 'qr', d);
  assert.equal(res.statusCode, 400);
  assert.equal(d.calls.length, 0);
});
test('qr POST: publish then restore', async () => {
  const d = deps(); let res = mockRes();
  await qr.handle(post({ action: 'publish_offer', offer: GOOD }), res, 'qr', d);
  assert.equal(res.statusCode, 200);
  const ts = JSON.parse(d.r.lists['qr:history'][0]).ts;
  res = mockRes();
  await qr.handle(post({ action: 'restore', ts }), res, 'qr', d);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.offer.headline, GOOD.headline);
  assert.equal(d.calls.length, 2);
  assert.equal(JSON.parse(d.r.lists['qr:history'][0]).restored_from, ts);
});
test('qr POST: history trimmed to 20', async () => {
  const d = deps();
  for (let i = 0; i < 25; i++) await qr.handle(post({ action: 'reset_target' }), mockRes(), 'qr', d);
  assert.equal(d.r.lists['qr:history'].length, 20);
});
test('qr GET stats sums today / 7d / 30d', async () => {
  const d = deps();
  d.r.hashes['qr:scans:2026-11-05'] = { window_sticker: '3', door: '1' };
  d.r.hashes['qr:scans:2026-11-01'] = { window_sticker: '2' };
  d.r.hashes['qr:scans:2026-10-15'] = { door: '5' };
  const res = mockRes();
  await qr.handle(get('stats'), res, 'qr', d);
  assert.deepEqual(res.body.today, { window_sticker: 3, door: 1 });
  assert.deepEqual(res.body.d7, { window_sticker: 5, door: 1 });
  assert.deepEqual(res.body.d30, { window_sticker: 5, door: 6 });
});
test('qr GET config reports writable/readable', async () => {
  const res = mockRes();
  await qr.handle(get('config'), res, 'qr', deps({ env: {} }));
  assert.equal(res.body.writable, false);
  assert.equal(res.body.readable, false);
  assert.equal(res.body.fallback, '/free-pretzels');
  assert.deepEqual(res.body.layouts, ['green', 'black', 'gold-light']);
});

test('offer GET: public, cached, status computed', async () => {
  const res = mockRes();
  await qr.handle({ method: 'GET', url: '/api/leads?resource=offer', headers: {} }, res, 'offer',
    deps({ readSession: async () => null, edgeGet: async (k) => (k === 'offer' ? GOOD : undefined) }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.match(res.headers['vercel-cdn-cache-control'], /max-age=30/);
  assert.equal(res.body.status, 'live');
  assert.equal(res.body.offer.headline, GOOD.headline);
});
test('offer GET: Edge Config error -> offer null, still 200', async () => {
  const res = mockRes();
  await qr.handle({ method: 'GET', url: '/', headers: {} }, res, 'offer', deps({ edgeGet: async () => { throw new Error('down'); } }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.offer, null);
});
test('offer GET: invalid stored offer is not served', async () => {
  const res = mockRes();
  await qr.handle({ method: 'GET', url: '/', headers: {} }, res, 'offer', deps({ edgeGet: async () => ({ layout: 'cream' }) }));
  assert.equal(res.body.offer, null);
});
test('offer POST -> 405', async () => {
  const res = mockRes();
  await qr.handle({ method: 'POST', url: '/', headers: {} }, res, 'offer', deps());
  assert.equal(res.statusCode, 405);
});

// ─── leads.js dispatch ─────────────────────────────────────────────
test('leads.js routes ?resource=offer to _qr and leaves other paths alone', async () => {
  const src = (await import('node:fs')).readFileSync(join(root, 'api', 'leads.js'), 'utf8');
  assert.match(src, /resource === 'offer' \|\| resource === 'qr'/);
  assert.match(src, /require\('\.\/_qr'\)\.handle\(req, res, resource\)/);
});
