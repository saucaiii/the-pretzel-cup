// Vercel Routing Middleware. Runs ONLY on /scan (see config.matcher).
//
// /scan is printed as a QR code on a vinyl window sticker, so this path
// must never change, never 404, and never be cached by the browser.
//
//   1. Read the destination from Edge Config key "scan_target".
//   2. If the store is unreachable, slow, empty, or holds a bad value,
//      fall back to /free-pretzels.
//   3. Carry the scanner's query params over to the destination. For
//      our own site, add utm_source=window_sticker&utm_medium=qr.
//   4. Answer 302 (never 301) with Cache-Control: no-store.
//   5. Log a "qr_scan" Vercel Analytics custom event in the background
//      (waitUntil), so logging can never slow down or break the redirect.
//   6. Also in the background: HINCRBY qr:scans:<YYYY-MM-DD> <placement>
//      in Upstash Redis (New York days, placement = sanitised utm_source,
//      default window_sticker). /ops/qr reads these. Fails silent.
//
// To change where the sticker goes: /ops/qr (or Vercel dashboard →
// Storage → Edge Config → "scan_target"). No redeploy needed.

import { get } from '@vercel/edge-config';
import { track } from '@vercel/analytics/server';
import { Redis } from '@upstash/redis';

export const config = { matcher: ['/scan', '/scan/'] };

export const FALLBACK_TARGET = '/free-pretzels';
export const OWN_HOSTS = new Set(['the-pretzel-cup.vercel.app']);
const EDGE_CONFIG_TIMEOUT_MS = 800;
const TIME_ZONE = 'America/New_York';
const SCAN_TTL_SECONDS = 40 * 24 * 60 * 60;

// Turns whatever is in Edge Config into a safe absolute URL.
// Accepts "/some/path" (our site) or an absolute http(s) URL.
// Anything else (empty, non-string, "//evil.com", "javascript:", over
// 2000 chars, or our own /scan, which would loop) returns null so the
// caller falls back. api/_qr.js applies the same rules on write; a
// parity test keeps the two in step.
export function parseTarget(raw, requestUrl) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2000) return null;
  let url = null;
  try {
    if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
      url = new URL(value, requestUrl);
    } else {
      const abs = new URL(value);
      if (abs.protocol === 'https:' || abs.protocol === 'http:') url = abs;
    }
  } catch {
    return null;
  }
  if (!url) return null;
  if (isOwnSite(url, requestUrl) && /^\/scan\/?$/.test(url.pathname)) return null;
  return url;
}

export function sanitizePlacement(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return /^[a-z0-9_-]{1,32}$/.test(v) ? v : 'other';
}

export function scanDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

let redisClient;
function scanRedis() {
  if (redisClient !== undefined) return redisClient;
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    redisClient = url && token ? new Redis({ url, token }) : null;
  } catch {
    redisClient = null;
  }
  return redisClient;
}

// Tests swap in a stub client (or null). Not used in production.
export function __setRedisForTests(client) {
  redisClient = client;
}

// Counts one scan. Never throws; resolves to true when counted.
export async function countScan(client, requestUrl, now = new Date()) {
  try {
    if (!client) return false;
    const raw = new URL(requestUrl).searchParams.get('utm_source');
    const placement = raw == null ? 'window_sticker' : sanitizePlacement(raw);
    const key = `qr:scans:${scanDay(now)}`;
    await client.hincrby(key, placement, 1);
    await client.expire(key, SCAN_TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

export function isOwnSite(url, requestUrl) {
  return url.host === new URL(requestUrl).host || OWN_HOSTS.has(url.host);
}

// Builds the final Location: target + scanner's query params + UTM
// tags for our own site. The scanner's params can add to the URL but
// can never change its host or path.
export function buildLocation(rawTarget, requestUrl) {
  const req = new URL(requestUrl);
  const target = parseTarget(rawTarget, requestUrl) || new URL(FALLBACK_TARGET, requestUrl);

  for (const [key, value] of req.searchParams) target.searchParams.set(key, value);

  if (isOwnSite(target, requestUrl)) {
    if (!target.searchParams.has('utm_source')) target.searchParams.set('utm_source', 'window_sticker');
    if (!target.searchParams.has('utm_medium')) target.searchParams.set('utm_medium', 'qr');
  }
  return target;
}

async function readScanTarget() {
  let timer;
  try {
    return await Promise.race([
      get('scan_target'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), EDGE_CONFIG_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null; // no EDGE_CONFIG env var, network error, bad token, etc.
  } finally {
    clearTimeout(timer);
  }
}

export default async function middleware(request, context) {
  let location;
  let usedFallback = true;
  try {
    const raw = await readScanTarget();
    usedFallback = parseTarget(raw, request.url) === null;
    location = buildLocation(raw, request.url);
  } catch {
    location = buildLocation(null, request.url);
  }

  try {
    const logging = track(
      'qr_scan',
      {
        target: isOwnSite(location, request.url) ? location.pathname : location.host,
        fallback: usedFallback,
      },
      { headers: request.headers },
    ).catch(() => {});
    if (context && typeof context.waitUntil === 'function') context.waitUntil(logging);
  } catch {
    // Logging must never break the redirect.
  }

  try {
    const counting = countScan(scanRedis(), request.url);
    if (context && typeof context.waitUntil === 'function') context.waitUntil(counting);
  } catch {
    // Counting must never break the redirect either.
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: location.toString(),
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
