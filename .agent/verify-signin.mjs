// Verify-only harness for the dual-role sign-in handler.
// No DB, no Supabase, no Vercel. Monkey-patches ../_lib/auth to stub
// supabase() and signSession() so we can exercise every branch of
// api/auth/signin.js and assert the responses.
//
// Run: node .agent/verify-signin.mjs
// Exits non-zero on first failed assertion.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Intercept the auth module BEFORE the handler loads it.
const authPath = path.join(repoRoot, 'api/_lib/auth.js');

// Stubs the handler is allowed to see.
let rpcRows = [];                 // what verify_pin returns next
let rpcError = null;
let peopleRows = [];              // what GET roster sees
let peopleError = null;
let setCookieCalled = false;
let signedPayload = null;

const stub = {
  supabase: () => ({
    rpc: async (name, args) => {
      if (name !== 'verify_pin') throw new Error(`unexpected rpc ${name}`);
      return { data: rpcError ? null : rpcRows, error: rpcError };
    },
    from: (table) => ({
      select: (cols) => ({
        order: (col, opts) => Promise.resolve({
          data: peopleError ? null : peopleRows,
          error: peopleError,
        }),
      }),
    }),
  }),
  signSession: async (payload) => {
    signedPayload = payload;
    return 'fake.jwt.token';
  },
  setSessionCookie: (res, token) => {
    setCookieCalled = true;
    res._setCookieToken = token;
  },
};
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: stub,
};

const handler = require(path.join(repoRoot, 'api/auth/signin.js'));

// Minimal req/res mocks.
function mkRes() {
  return {
    _status: 200, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(o)  { this._json = o;  return this; },
    setHeader(k, v) { this._headers[k] = v; },
  };
}
function req(method, body, headers = {}) {
  return { method, body, headers };
}

function reset() {
  rpcRows = []; rpcError = null;
  peopleRows = []; peopleError = null;
  setCookieCalled = false; signedPayload = null;
}

const results = [];
async function it(name, fn) {
  reset();
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ──────────────────────────────────────────────────────────────
// GET /api/auth/signin — roster endpoint
// ──────────────────────────────────────────────────────────────
await it('GET returns name+role only, sorted operator→baker→driver', async () => {
  peopleRows = [
    { name: 'Vic',   role: 'baker',    created_at: '2025-10-19T00:00:00Z' },
    { name: 'Mike',  role: 'operator', created_at: '2025-10-19T00:00:00Z' },
    { name: 'Eric',  role: 'driver',   created_at: '2025-10-20T00:00:00Z' },
    { name: 'Chris', role: 'operator', created_at: '2025-11-01T00:00:00Z' },
  ];
  const res = mkRes();
  await handler(req('GET'), res);
  eq(res._status, 200, 'status');
  eq(res._headers['Cache-Control'], 'no-store', 'cache header');
  // Expect operator(s) first by created_at, then baker, then driver.
  eq(res._json.people, [
    { name: 'Mike',  role: 'operator' },
    { name: 'Chris', role: 'operator' },
    { name: 'Vic',   role: 'baker'    },
    { name: 'Eric',  role: 'driver'   },
  ], 'roster order');
  // No PII leaks.
  for (const p of res._json.people) {
    const keys = Object.keys(p).sort();
    eq(keys, ['name', 'role'], 'only name+role fields');
  }
});

await it('GET handles DB error with 500', async () => {
  peopleError = { message: 'boom' };
  const res = mkRes();
  await handler(req('GET'), res);
  eq(res._status, 500, 'status');
  eq(res._json.error, 'server error', 'error msg');
});

// ──────────────────────────────────────────────────────────────
// POST — single-role (no secondary_role)
// ──────────────────────────────────────────────────────────────
await it('POST single-role signs cookie, returns role', async () => {
  rpcRows = [{ id: 'u1', name: 'Mike', role: 'operator', secondary_role: null }];
  const res = mkRes();
  await handler(req('POST', { name: 'Mike', pin: '1234' }), res);
  eq(res._status, 200, 'status');
  eq(res._json, { ok: true, name: 'Mike', role: 'operator', mustChangePin: false }, 'payload');
  assert(setCookieCalled, 'cookie set');
  eq(signedPayload, { sub: 'u1', name: 'Mike', role: 'operator' }, 'jwt payload');
});

await it('POST wrong PIN returns 401 without cookie', async () => {
  rpcRows = []; // verify_pin returns no row
  const res = mkRes();
  await handler(req('POST', { name: 'Mike', pin: '9999' }), res);
  eq(res._status, 401, 'status');
  eq(res._json.error, 'wrong name or PIN', 'error');
  assert(!setCookieCalled, 'no cookie set');
});

await it('POST missing fields returns 400', async () => {
  const res = mkRes();
  await handler(req('POST', { name: '', pin: '12' }), res);
  eq(res._status, 400, 'status');
});

// ──────────────────────────────────────────────────────────────
// POST — dual-role (Vic: baker + driver)
// ──────────────────────────────────────────────────────────────
await it('POST dual-role returns chooser WITHOUT cookie', async () => {
  rpcRows = [{ id: 'u2', name: 'Vic', role: 'baker', secondary_role: 'driver' }];
  const res = mkRes();
  await handler(req('POST', { name: 'Vic', pin: '1234' }), res);
  eq(res._status, 200, 'status');
  eq(res._json, { ok: true, choose: true, name: 'Vic', roles: ['baker', 'driver'] }, 'chooser payload');
  assert(!setCookieCalled, 'NO cookie yet (critical)');
  assert(signedPayload === null, 'NO jwt yet');
});

await it('POST dual-role + chosen_role=driver signs JWT with driver', async () => {
  rpcRows = [{ id: 'u2', name: 'Vic', role: 'baker', secondary_role: 'driver' }];
  const res = mkRes();
  await handler(req('POST', { name: 'Vic', pin: '1234', chosen_role: 'driver' }), res);
  eq(res._status, 200, 'status');
  eq(res._json, { ok: true, name: 'Vic', role: 'driver', mustChangePin: false }, 'payload');
  eq(signedPayload.role, 'driver', 'jwt role = driver');
  assert(setCookieCalled, 'cookie set');
});

await it('POST dual-role + chosen_role=baker signs JWT with baker', async () => {
  rpcRows = [{ id: 'u2', name: 'Vic', role: 'baker', secondary_role: 'driver' }];
  const res = mkRes();
  await handler(req('POST', { name: 'Vic', pin: '1234', chosen_role: 'baker' }), res);
  eq(res._json.role, 'baker', 'role returned = baker');
  eq(signedPayload.role, 'baker', 'jwt role = baker');
});

await it('POST dual-role + chosen_role=operator (not their role) returns 400', async () => {
  rpcRows = [{ id: 'u2', name: 'Vic', role: 'baker', secondary_role: 'driver' }];
  const res = mkRes();
  await handler(req('POST', { name: 'Vic', pin: '1234', chosen_role: 'operator' }), res);
  eq(res._status, 400, 'status');
  eq(res._json.error, 'invalid role for this user', 'error');
  assert(!setCookieCalled, 'no cookie');
});

await it('POST single-role + chosen_role=matching still works', async () => {
  rpcRows = [{ id: 'u1', name: 'Mike', role: 'operator', secondary_role: null }];
  const res = mkRes();
  await handler(req('POST', { name: 'Mike', pin: '1234', chosen_role: 'operator' }), res);
  eq(res._status, 200, 'status');
  eq(signedPayload.role, 'operator', 'jwt role');
});

await it('POST single-role + chosen_role=different returns 400', async () => {
  rpcRows = [{ id: 'u1', name: 'Mike', role: 'operator', secondary_role: null }];
  const res = mkRes();
  await handler(req('POST', { name: 'Mike', pin: '1234', chosen_role: 'driver' }), res);
  eq(res._status, 400, 'status');
});

// ──────────────────────────────────────────────────────────────
// First-login path (PIN=0000) must SKIP the chooser
// ──────────────────────────────────────────────────────────────
await it('First-login dual-role with 0000 signs cookie with primary, skips chooser', async () => {
  rpcRows = [{ id: 'u2', name: 'Vic', role: 'baker', secondary_role: 'driver' }];
  const res = mkRes();
  await handler(req('POST', { name: 'Vic', pin: '0000' }), res);
  eq(res._status, 200, 'status');
  eq(res._json, { ok: true, name: 'Vic', role: 'baker', mustChangePin: true }, 'payload');
  eq(signedPayload.role, 'baker', 'jwt role = primary');
  assert(setCookieCalled, 'cookie set so change-pin works');
  assert(!res._json.choose, 'no chooser');
});

// ──────────────────────────────────────────────────────────────
// Edge: secondary_role === role (duplicate) should NOT fire chooser
// ──────────────────────────────────────────────────────────────
await it('secondary_role identical to primary does not trigger chooser', async () => {
  rpcRows = [{ id: 'u3', name: 'X', role: 'baker', secondary_role: 'baker' }];
  const res = mkRes();
  await handler(req('POST', { name: 'X', pin: '1234' }), res);
  assert(setCookieCalled, 'cookie set directly');
  eq(signedPayload.role, 'baker', 'role');
  assert(!res._json.choose, 'no chooser');
});

// ──────────────────────────────────────────────────────────────
// Method guard
// ──────────────────────────────────────────────────────────────
await it('PUT returns 405 with Allow: GET, POST', async () => {
  const res = mkRes();
  await handler(req('PUT', {}), res);
  eq(res._status, 405, 'status');
  eq(res._headers.Allow, 'GET, POST', 'allow header');
});

// ──────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`\x1b[32mPASS\x1b[0m ${r.name}`);
  else { failed++; console.log(`\x1b[31mFAIL\x1b[0m ${r.name}\n   ${r.err && r.err.message}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
