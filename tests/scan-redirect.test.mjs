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
