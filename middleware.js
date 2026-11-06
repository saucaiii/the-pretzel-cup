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
//
// To change where the sticker goes: Vercel dashboard → Storage → Edge
// Config store → edit "scan_target". No redeploy needed.

import { get } from '@vercel/edge-config';
import { track } from '@vercel/analytics/server';

export const config = { matcher: ['/scan', '/scan/'] };

export const FALLBACK_TARGET = '/free-pretzels';
export const OWN_HOSTS = new Set(['the-pretzel-cup.vercel.app']);
const EDGE_CONFIG_TIMEOUT_MS = 800;

// Turns whatever is in Edge Config into a safe absolute URL.
// Accepts "/some/path" (our site) or an absolute http(s) URL.
// Anything else (empty, non-string, "//evil.com", "javascript:")
// returns null so the caller falls back.
export function parseTarget(raw, requestUrl) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
      return new URL(value, requestUrl);
    }
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url;
  } catch {
    // fall through
  }
  return null;
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

  return new Response(null, {
    status: 302,
    headers: {
      Location: location.toString(),
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
