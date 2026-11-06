// Tests for /scan (middleware.js). Run: node --test tests/
//
// package.json has no "type": "module" (api/ is CommonJS), so we copy
// middleware.js to an .mjs file under node_modules/.cache, where bare
// imports still resolve to this repo's node_modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const copy = join(cacheDir, 'scan-middleware.test.mjs');
copyFileSync(join(root, 'middleware.js'), copy);

delete process.env.EDGE_CONFIG; // force the "store unreachable" path
const mw = await import(pathToFileURL(copy).href);

const REQ = 'https://the-pretzel-cup.vercel.app/scan';

test('matcher is limited to /scan', () => {
  assert.deepEqual(mw.config.matcher, ['/scan', '/scan/']);
});

test('no Edge Config → 302 to /free-pretzels with UTM, no-store', async () => {
  const res = await mw.default(new Request(REQ), { waitUntil() {} });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0');
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.pathname, '/free-pretzels');
  assert.equal(loc.searchParams.get('utm_source'), 'window_sticker');
  assert.equal(loc.searchParams.get('utm_medium'), 'qr');
});

test('works with no context object at all', async () => {
  const res = await mw.default(new Request(REQ));
  assert.equal(res.status, 302);
});

for (const bad of [null, undefined, '', '   ', 42, {}, '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', 'ftp://example.com/x', 'not a url']) {
  test(`bad target ${JSON.stringify(bad)} falls back`, () => {
    const loc = mw.buildLocation(bad, REQ);
    assert.equal(loc.host, 'the-pretzel-cup.vercel.app');
    assert.equal(loc.pathname, '/free-pretzels');
  });
}

test('own-site path target gets UTM and keeps its own params', () => {
  const loc = mw.buildLocation('/menu?item=cup', REQ);
  assert.equal(loc.pathname, '/menu');
  assert.equal(loc.searchParams.get('item'), 'cup');
  assert.equal(loc.searchParams.get('utm_source'), 'window_sticker');
  assert.equal(loc.searchParams.get('utm_medium'), 'qr');
});

test('own-site absolute URL counts as own site', () => {
  const loc = mw.buildLocation('https://the-pretzel-cup.vercel.app/free-pretzels', REQ);
  assert.equal(loc.searchParams.get('utm_medium'), 'qr');
});

test('external target gets no UTM', () => {
  const loc = mw.buildLocation('https://example.com/promo', REQ);
  assert.equal(loc.host, 'example.com');
  assert.equal(loc.searchParams.has('utm_source'), false);
});

test('scanner query params pass through, cannot change host or path', () => {
  const loc = mw.buildLocation('https://example.com/promo', `${REQ}?store=lynbrook&next=https://evil.example.com`);
  assert.equal(loc.host, 'example.com');
  assert.equal(loc.pathname, '/promo');
  assert.equal(loc.searchParams.get('store'), 'lynbrook');
});

test('incoming utm_source is kept, not overwritten', () => {
  const loc = mw.buildLocation('/free-pretzels', `${REQ}?utm_source=door_sticker`);
  assert.equal(loc.searchParams.get('utm_source'), 'door_sticker');
  assert.equal(loc.searchParams.get('utm_medium'), 'qr');
});

test('preview deployment host counts as own site', () => {
  const loc = mw.buildLocation('/free-pretzels', 'https://the-pretzel-cup-git-x.vercel.app/scan');
  assert.equal(loc.host, 'the-pretzel-cup-git-x.vercel.app');
  assert.equal(loc.searchParams.get('utm_source'), 'window_sticker');
});

// ─── self-loop guard + scan counters ───────────────────────────────

test('target pointing back at /scan falls back (no redirect loop)', () => {
  for (const t of ['/scan', '/scan/', 'https://the-pretzel-cup.vercel.app/scan']) {
    assert.equal(mw.buildLocation(t, REQ).pathname, '/free-pretzels');
  }
});

function stubRedis(opts = {}) {
  const calls = [];
  return {
    calls,
    async hincrby(k, f, n) { calls.push(['hincrby', k, f, n]); if (opts.throws) throw new Error('down'); },
    async expire(k, s) { calls.push(['expire', k, s]); },
  };
}

test('countScan: default placement window_sticker, New York day key, 40d TTL', async () => {
  const r = stubRedis();
  const ok = await mw.countScan(r, REQ, new Date('2026-11-06T03:00:00Z')); // 10pm Nov 5 in NY
  assert.equal(ok, true);
  assert.deepEqual(r.calls[0], ['hincrby', 'qr:scans:2026-11-05', 'window_sticker', 1]);
  assert.deepEqual(r.calls[1], ['expire', 'qr:scans:2026-11-05', 40 * 24 * 60 * 60]);
});

test('countScan: utm_source is sanitised into the placement', async () => {
  const r = stubRedis();
  await mw.countScan(r, `${REQ}?utm_source=Door_Sticker`);
  assert.equal(r.calls[0][2], 'door_sticker');
  const r2 = stubRedis();
  await mw.countScan(r2, `${REQ}?utm_source=${'x'.repeat(50)}`);
  assert.equal(r2.calls[0][2], 'other');
});

test('countScan: never throws (redis error or no client)', async () => {
  assert.equal(await mw.countScan(stubRedis({ throws: true }), REQ), false);
  assert.equal(await mw.countScan(null, REQ), false);
});

test('redis throwing does not change the 302', async () => {
  const r = stubRedis({ throws: true });
  mw.__setRedisForTests(r);
  const pending = [];
  const res = await mw.default(new Request(`${REQ}?utm_source=door`), { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')).pathname, '/free-pretzels');
  assert.equal(r.calls[0][2], 'door');
  mw.__setRedisForTests(null);
});

test('redis client that throws synchronously does not change the 302', async () => {
  mw.__setRedisForTests({ hincrby() { throw new Error('boom'); }, expire() {} });
  const res = await mw.default(new Request(REQ), { waitUntil() {} });
  assert.equal(res.status, 302);
  mw.__setRedisForTests(null);
});
