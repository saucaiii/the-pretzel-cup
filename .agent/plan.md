# Plan — route-pitch

**Risk:** MEDIUM overall. Component-by-component:
- `pitch-kit/` HTML — LOW (static content, shipped)
- `vercel.json` SAMEORIGIN header — HIGH per policy (plan-first)
- `scripts/gen-pitch-pdf.mjs` — HIGH per policy (plan-first)
- `apply/` HTML — LOW
- `api/leads.js` — MEDIUM
- `supabase/migrations/p20_leads.sql` — HIGH per policy (plan-first);
  parallel-agent coordination required (see Risks)

## Goal
Two outcomes in one branch:
1. A 6-sheet printable "Route Pitch Packet" under `pitch-kit/` — the
   pre-signup leave-behind for grocery + deli prospects of Program A
   (daily route delivery, buy-back model). Matches `/onboarding-kit/`
   brand system, has a picker page, and prints via a Chrome-headless
   bundle. **Done — HTML committed on 4b4d185.**
2. A working `/apply` lead-capture flow so the QR on sheet 6 and the
   URL on sheets 1–5 actually land somewhere. Branded form, honeypot,
   rate-limit, Supabase persistence, Telegram notify.

## Scope (updated — human must mirror this in `.agent-control/scope.txt`)
- `pitch-kit/` (committed)
- `scripts/gen-pitch-pdf.mjs` (new — standalone Chrome-headless PDF
  generator for the bundle; keeps `gen-print-kits.mjs` untouched)
- `vercel.json` (SAMEORIGIN for `pitch-kit/(.*)` so iframes work)
- `apply/` (new — `index.html` form, `success.html` thank-you)
- `api/leads.js` (new — POST submit, GET list; folded no longer
  required since Vercel is on the Pro plan)
- `supabase/migrations/p20_leads.sql` (new — `leads` table + RLS)

## Steps

### Already done
1. Read reference files; confirmed brand tokens.
2. Built 6 sheets + picker + print bundle under `pitch-kit/`.
3. Visual-checked each sheet via local static server; fixed the
   Caveat-script uppercase bleed on 06-close.
4. Generated a sample PDF through Chrome headless (6 pages, letter).
5. Committed HTML as `feat(pitch-kit): add 6-sheet route-delivery
   pitch packet` (4b4d185).

### Still to do (needs scope + approval)
6. Add `pitch-kit/(.*)` SAMEORIGIN entry to `vercel.json`.
7. Write `scripts/gen-pitch-pdf.mjs` — standalone renderer: hits
   `BASE/pitch-kit/print-bundle` with Chrome headless, writes to
   `pitch-kit/pdfs/route-pitch.pdf`. Shares the Chrome-invocation
   pattern of the existing `scripts/gen-print-kits.mjs` but without
   Supabase / per-store fan-out.
8. Build `apply/index.html` — branded form matching the pitch-kit
   look (cream + green, Archivo Black headline, Caveat accent).
   Fields: business name, contact name, role, address, city, state,
   zip, phone, email, est_foot_traffic (optional), notes, honeypot
   `_hp` hidden input. Client-side validation, then POST JSON to
   `/api/leads`. On 200, redirect to `/apply/success`.
9. Build `apply/success.html` — short thank-you, repeats
   `516.517.8111 · ask for Chris`, promises a call within 24h.
10. Write `supabase/migrations/p20_leads.sql`:
    - `leads` table (id uuid pk, created_at, status enum
      new|contacted|qualified|signed|dead, business_name, contact_name,
      role, address, city, state, zip, phone, email,
      est_foot_traffic int, notes, source text default 'pitch-kit-qr',
      user_agent, ip_hash, handled_by, handled_at)
    - index on status, created_at
    - RLS enabled; no anon policies (service role only writes)
11. Write `api/leads.js`:
    - POST: honeypot reject if `_hp` set; Upstash sliding-window
      rate-limit per IP (5 req / 10 min); server-side field validation;
      Supabase insert via `SUPABASE_SERVICE_ROLE_KEY`; Telegram notify
      to Chris's group with all contact fields + inline "Mark
      Contacted" button; returns 200 `{ok:true}`.
    - GET: admin-auth gated (reuses ops cookie auth from
      `api/_lib/auth.js` — matches how `/ops/*` pages gate today).
      Lists leads newest first for a future `/ops/leads` view.
    - No new `api/_lib/` file; inlines a 30-line helper in the handler
      rather than touching the HIGH_RISK `api/_lib/` folder (and
      avoids collision with wholesale-invoice-pdf-f264f2 which owns
      `api/_lib/gmail.js`).
12. Leave coordination note in the side-session-notes folder stating
    I am taking `supabase/migrations/p20_leads.sql`.
13. Commit in three chunks:
    - `chore(vercel): expose pitch-kit for iframe print bundle`
    - `feat(pitch-kit): add standalone print-bundle PDF generator`
    - `feat(apply): lead capture form + endpoint + leads schema`
14. Push and open a DRAFT PR using the repo template. Body ends with
    the required Claude Code attribution line.

### Deferred (follow-up PR, not blocking print)
- `ops/leads/index.html` — admin list view with status filters and
  "convert to stop" action. Telegram notifications give Chris
  immediate visibility; admin view is not needed to start taking
  real leads.

## Success criteria
- `/apply` returns 200 in prod and shows a brand-matched lead form.
- Submitting the form inserts a row in `leads` (checked via Supabase)
  and fires a Telegram message to Chris's group.
- Submitting without JS or with the honeypot populated 400s cleanly.
- Repeated submissions from one IP beyond the rate limit 429.
- QR on sheet 6 (`pitch-kit/06-close.html`) resolves without 404.
- `scripts/gen-pitch-pdf.mjs` writes a 6-page PDF to
  `pitch-kit/pdfs/route-pitch.pdf` with no Supabase env required.
- `vercel.json` grants SAMEORIGIN to `pitch-kit/(.*)`.
- The word "wholesale" appears only in the unit-economics table of
  `pitch-kit/03-the-numbers.html` (grep confirms).

## Risks + mitigations
- **Migration-file collision with parallel agents.** `price-override-ga`
  worktree owns `supabase/migrations/` whole; `wholesale-stack` has
  `p14_wholesale.sql`; `wholesale-invoice-pdf-f264f2` has
  `p16_wholesale_invoice_number.sql`; `eager-einstein` had
  `p15_wholesale_order_audit.sql`. Taking `p20_` leaves a clear
  numeric gap and I'll drop a note in
  `/Users/chris/Library/Application Support/Claude/side-session-notes/
  local_5dee5459-3907-4c47-ae7e-ab35905fe9b6/` naming the number I'm
  taking so the other agents don't pick it.
- **`api/_lib/` collision.** `wholesale-invoice-pdf-f264f2` owns
  `api/_lib/gmail.js`; `wholesale-stack` owns `api/_lib/{gmail,md,
  promo}.js`. I avoid `api/_lib/` entirely — any helper I need goes
  inline in `api/leads.js`.
- **Spam.** Honeypot + Upstash per-IP rate-limit. If spam still gets
  through after launch, add Turnstile in a follow-up.
- **No admin UI yet.** Telegram notifications cover the "I got a
  lead" case for day one; admin UI is a separate PR.

## Rollback / escalation
Revert on `agent/route-pitch` via `git revert`. Migration rollback is
`DROP TABLE leads;` (no data loss risk pre-launch). No production
surface changes until the draft PR is reviewed and merged.
