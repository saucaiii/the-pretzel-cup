# Working memory (short-term). Keep under 60 lines.
Branch: agent/route-pitch
Task: route-pitch
Status: ready to commit + push + draft PR
Started: 2026-11-04T13:39Z

## Progress
- Pitch-kit HTML committed earlier (4b4d185): 6 sheets + index +
  print-bundle. Fixed Caveat-script uppercase bleed on 06-close
  afterward (in working tree, included in next commit).
- Sample PDF (6 pages, letter) generated via Chrome headless and
  delivered to user from scratchpad.
- Plan rewritten to cover full scope; scope.txt widened and plan
  approved by the user (hash matches b7ce3e9d8300…).
- Added `pitch-kit/(.*)` SAMEORIGIN to vercel.json.
- Wrote scripts/gen-pitch-pdf.mjs (standalone PDF renderer).
- Wrote supabase/migrations/p20_leads.sql (leads table, RLS on,
  dedupe + status indexes). p20_ clears p14/p15/p16 claimed by the
  wholesale worktrees.
- Wrote apply/index.html (branded form, honeypot, client-side
  validation) + apply/success.html (thank-you).
- Wrote api/leads.js (POST public: honeypot, Upstash rate-limit,
  dedupe, Supabase insert, Telegram notify; GET operator-gated).
- Visual-checked /apply + /apply/success — both render cleanly in
  the local preview server.
- Node syntax-check passed on api/leads.js and
  scripts/gen-pitch-pdf.mjs.

## Next
- Commit in three chunks:
  * chore(vercel): expose pitch-kit for iframe print bundle
  * feat(pitch-kit): add standalone print-bundle PDF generator
    (also includes the 06-close script CSS fix)
  * feat(apply): lead capture form + endpoint + leads schema
- Push and open DRAFT PR.

## Handoffs
- (agent -> agent: input, output, result)
