# Working memory (short-term). Keep under 60 lines.
Branch: agent/signin-dual-role
Task: signin-dual-role
Status: ready to commit
Started: 2026-11-27

## Plan
- Full plan at .agent/plan.md. Risk: high (plan approved).
- Ship uncommitted signin dual-role + DB roster that keeps getting
  deferred (stash@{4} from 2026-11-02, Nov 27 rewrite that forgot the
  DB migration).

## Progress
- Stashed unrelated CRM Today work (api/_packs.js, .env.example) on
  main as "wip: CRM Today window toggle (_packs + env.example)".
- Branch agent/signin-dual-role carries signin.html + api/auth/signin.js
  (pre-existing uncommitted work, no logic changes).
- Wrote supabase/migrations/p26_secondary_role.sql (ALTER TABLE +
  verify_pin returning secondary_role + Vic seed, transactional,
  idempotent).
- Mirrored both definition changes into supabase/schema.sql.
- Verified server-side logic with .agent/verify-signin.mjs: 14/14
  pass (GET roster shape, POST single-role, POST dual-role chooser
  without cookie, chosen_role branches incl. invalid, first-login
  0000 skips chooser, duplicate secondary_role no-op, 405 method
  guard).
- Scope check passes against the plan.
- Test-suite baseline: `npm test` reports 75/77 pass. The two
  failures (qr-config, scan-redirect) are pre-existing on main
  (`@vercel/edge-config` import from .cache fixture), unrelated to
  signin.

## Handoffs
- none (single session)

## Deploy
- Human applies p26 in Supabase (SQL editor), merges PR, runs
  `npm run deploy`. Smoke: Mike → `/ops`. Vic → chooser → picks
  driver → `/driver`. Same Vic → picks baker → `/baker`.
