# Plan — route-pitch

**Risk:** LOW (static HTML content work, print leave-behind only)

## Goal
Build a 6-sheet printable "Route Pitch Packet" under `pitch-kit/` — the
pre-signup leave-behind for grocery + deli prospects of Program A (daily
route delivery, buy-back model). Match the `/onboarding-kit/` brand
system and page conventions exactly, plus a picker page and a Chrome-
headless print bundle. Wire the print bundle into the existing print
generator so a single generic `route-pitch.pdf` is produced.

## Scope
Allowed paths (match `.agent-control/scope.txt`):
- `pitch-kit/` (all new HTML sheets, index.html, print-bundle.html)
- `scripts/gen-print-kits.mjs` (append pitch-kit generation OR create a
  small standalone `scripts/gen-pitch-pdf.mjs` — whichever is cleaner)
- `vercel.json` (add `pitch-kit/(.*)` to SAMEORIGIN headers)

Everything else off-limits.

## Steps
1. Read reference files (done — `onboarding-kit/assets/kit.css`,
   `01-welcome-letter.html`, `03-contact-card.html`, `09-portal-pitch.html`,
   `08-pricing-card.html`, `index.html`, `print-bundle.html`,
   `scripts/gen-print-kits.mjs`, `vercel.json`).
2. Build the six 8.5×11 sheets (`01-cover`, `02-the-deal`,
   `03-the-numbers`, `04-portal-preview`, `05-payment`, `06-close`)
   using the shared tokens from `onboarding-kit/assets/kit.css`, each
   with its own inline @page style block and `<base href="/onboarding-kit/">`.
3. Build `pitch-kit/index.html` as a static picker — list the six
   sheets with Open and Print PDF links (no stores API).
4. Build `pitch-kit/print-bundle.html` — iframes stacking all six
   sheets for a single Chrome-headless → PDF render.
5. Add `pitch-kit/(.*)` SAMEORIGIN header entry in `vercel.json`.
6. Add a small standalone `scripts/gen-pitch-pdf.mjs` that renders
   `pitch-kit/print-bundle.html` to `pitch-kit/pdfs/route-pitch.pdf`
   (standalone keeps `gen-print-kits.mjs` focused on per-store fan-out
   — same Chrome-headless pattern, zero Supabase coupling).
7. Visual check: open `pitch-kit/index.html` via a quick local file
   fetch and spot-check for broken layout.
8. Commit in two chunks (packet files, then vercel+script) on
   `agent/route-pitch` with Co-Authored-By trailer.
9. Push and open a DRAFT PR using the repo template, body ending with
   the required Claude Code attribution line.

## Success criteria
- Six 8.5×11 HTML sheets exist, each uses
  `<base href="/onboarding-kit/">` + `assets/kit.css`, each has its own
  @page sizing, and each uses only tokens already in kit.css
  (`--ppf-green`, `--ppf-green-deep`, `--ppf-gold`, `--ppf-gold-deep`,
  `--ppf-cream`, `--font-display`, `--font-body`, `--font-script`,
  `--diamond-pattern`).
- Copy appears exactly as supplied in the task brief (no new wording
  invented — the operator chose these words).
- The word "wholesale" never appears in prospect-facing body copy. It
  is only used inside the unit-economics table as "Our wholesale $X" —
  which is the same way the existing `09-portal-pitch.html` uses it.
  (That is unit-economics terminology, not the Program B product name.)
- `pitch-kit/index.html` loads without a stores API call and surfaces
  Open + Print PDF links for all six sheets.
- `pitch-kit/print-bundle.html` stacks the six iframes (sized
  816×1056 like the existing bundle) with correct per-sheet page
  breaks.
- `vercel.json` grants SAMEORIGIN to `pitch-kit/(.*)` so the bundle's
  iframes render in prod.
- `scripts/gen-pitch-pdf.mjs` runs Chrome headless and writes a single
  generic PDF; no Supabase required.

## Risks + mitigations
- **CSS token mismatch** — all tokens pulled directly from
  `onboarding-kit/assets/kit.css` via `<base>` import; no new tokens
  introduced.
- **Word "wholesale" leakage into prospect copy** — grep the pitch-kit
  directory before commit to confirm the only occurrence is the
  margin-table "Our wholesale $X" line.
- **Vercel Hobby 12-serverless-function cap** — no new API routes;
  only static HTML + an optional offline script, so unaffected.

## Rollback / escalation
Revert the agent/route-pitch branch commits via `git revert`. No
production surface changes until the draft PR is reviewed and merged
by a human, and no deploy is run from this worktree.
