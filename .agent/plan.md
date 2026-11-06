# Plan: pretzel-packs (pack-opening minigame on /free-pretzels)

Draft, 2026-11-05. Not approved. Stacks on draft PR #26 (needs its live
offer + /ops/qr). Becomes `.agent/plan.md` in the task's own worktree once
the human runs `scripts/agent/new-task.sh` (see "Isolation").

## Risk
**CRITICAL (personal data), with HIGH parts.** Take the highest.
- CRITICAL (compliance): collects email addresses, sends a sign-in email,
  stores players. Agent writes the code; the human applies the migration,
  sets secrets, turns the game on and deploys.
- HIGH (security): new sign-in (magic link) and a redemption write path;
  new `supabase/migrations/` file (HIGH-risk path in this repo).
- MEDIUM: `api/leads.js` dispatcher, `api/_qr.js` game flag, `/ops/qr` toggle.
- LOW: game UI and the gold win animation.
- Automated decisions about people: none. Everyone gets the same prize.
- Promotion law: no chance element in the prize (every pack wins the same
  free pretzel), so this is not a sweepstakes. Extra pretzels for an email
  or an Instagram follow are a fixed reward, not a draw. Flag for the
  human to confirm with whoever reviews promos.

## Goal
Turn the free pretzel into a short, fun moment: the player picks 1 of 3
packs, tears it open, and gets a gold celebration and a voucher for a free
pretzel. Every pack wins. They can earn more pretzels by verifying an email
and by following on Instagram, each worth one more pack.

## Decisions (user)
- No rarity tiers, not even cosmetic. Every pack = one free pretzel.
- Win moment is a **golden celebration** (gold burst + shimmer).
- Opening sequence timed like the user's reference clip (table below).
- **Our logo is on the pack**, and **the real pretzel pops out** of it.
- **Rivets fall from the top** in the background during the win.

## Assets (received 2026-11-05)
- Pretzel: transparent WebP, 646x1468 (from the user).
- Logo: transparent WebP, 1864x1725 (from the user), unaltered.
- Rivets: 4 transparent PNG cutouts made by the agent from the user's
  "personality test" post (colour mask, hole fill, 1 px soft edge, green
  despill): `rivet-plain` 116x176, `rivet-salted-short` 91x123,
  `rivet-salted-long` 86x170, `rivet-pair` 220x135. Low resolution, so
  they are only used small (falling, about 40 to 70 px). Checked on black,
  green and gold-light. Replace with real cutouts later if available.
- Staging copy: the session scratchpad `rivets/` folder. They move into
  `free-pretzels/packs/` in the task worktree (inside the planned
  `free-pretzels/` scope), converted to WebP with PNG fallback.

## Defaults (confirmed by the user 2026-11-05: "Defaults OK")
1. **Redemption:** pack reveal shows a short one-time code. At the counter,
   staff enters the 4-digit store PIN on the customer's phone to burn it.
   Codes expire at the offer's end date. (Alternative: show-screen only.)
2. **Bonus packs:** email = 1 pack after clicking a magic link (verified).
   Instagram = 1 pack on an honor tap (follows cannot be verified by API).
   **Max 3 pretzels per person per offer.**
3. **Placement:** the game replaces the offer block on `/free-pretzels`,
   switched on and off from `/ops/qr`. Locations and fine print stay.
4. **Instagram handle:** not given yet. Built as a setting on the offer
   in `/ops/qr` (`instagram_handle`, validated `[A-Za-z0-9._]{1,30}`). The
   Instagram button stays hidden until it is set, so this does not block
   the build.

## Scope (proposed `.agent-control/scope.txt` for the new worktree)
- `api/leads.js` (add `?resource=packs` dispatch only)
- `api/_packs.js` (new; underscore = not a function, cap stays at 12)
- `api/_qr.js` (offer gets `game: true|false`)
- `ops/qr/index.html` (game toggle + pack stats)
- `free-pretzels/` (`index.html`, new `packs.js`, `packs.css`, pack art SVG)
- `supabase/migrations/p10_pretzel_packs.sql` (new, HIGH)
- `tests/packs.test.mjs` (new), `tests/qr-config.test.mjs` (game flag)
- `.agent/`

Not touched: `api/_lib/` (gmail.js and auth.js are used, not edited),
`vercel.json`, `middleware.js`, `scripts/`, `.github/`.

## Design
**Flow (`/free-pretzels`, game on):**
0. "Pick a pack": three sealed packs side by side (a fan on phones).
   Tapping one sends the other two off screen, and the stage goes to
   solid brand black.

**Opening sequence.** The beat timing follows the user's reference clip
(an 8.5 s pack-rip video, observed 2026-11-05). We copy only its timing
and staging: no artwork, icons, card or slab frames, wording or colours
from it (it uses another company's characters).

| Beat | Time | Reference clip | Ours |
| --- | --- | --- | --- |
| 1 Spin-in | 0 to 0.9 s | Pack spins in on its vertical axis from edge-on to face-front, foil glint | Chosen pack spins in from edge-on, one gold glint sweeps across the foil |
| 2 Charge | 0.9 to 2.0 s | Pack holds; a bright horizontal line draws across its middle | Pack holds and breathes slightly; a gold tear line draws across the middle and brightens. The player **swipes along the line** (tap or Enter also works) |
| 3 Rip | 2.0 to 2.5 s | Pack splits on the line: top flies up and away, bottom drops; card rises; rays start behind | Same split: top half flies up and off; bottom half (with the logo) drops straight down, no rotation. **The real pretzel pops up out of the pack.** Gold-light rays fan out behind it |
| 4 Land | 2.5 to 3.3 s | Card settles centre, rays slowly turn, sparkles | The pretzel overshoots slightly, then settles centre; rays turn slowly; gold sparkles start |
| 5 Payoff | 3.3 to 6 s | Big headline slams in above the card, a number counts up, a multiplier badge stamps on | **Golden win**: "YOU WON" slams in above, then **FREE PRETZEL**; a gold shard burst and one gold shimmer pass over the pretzel; a round gold **FREE** stamp hits beside it; **pretzel rivets rain down from the top in the background** behind the rays |
| 6 Settle | 6 s on | Fades out and loops | No loop. Rivets stop spawning and fall away; the pretzel shrinks up into the voucher view: code, expiry, "Show this at the counter" |

- "Skip" is always visible from beat 1 and jumps to beat 6.
- `prefers-reduced-motion`: no spin, rip or burst; a single crossfade to
  the gold card.
- Rays are solid gold-light wedges at low opacity, not a gradient.
  Shimmer is gold to gold. No green and gold gradient anywhere.
- **Logo on the pack (user decision, 2026-11-05).** The brand guide says
  never tilt, crop or recolour the logo, and the pack spins, so:
  - the logo is not shown while the pack spins in (beat 1); it fades in
    flat and upright once the pack faces front, then stays still;
  - it sits on the **lower half**, below the tear line, with clear space
    of at least one "P" height, so the rip never cuts through it;
  - the lower half drops straight down in beat 3 with no rotation;
  - unaltered artwork, no outline, glow or ring.
  Rest of the pack art: diamond plate foil, gold "FREE PRETZEL" in Archivo
  Black above the tear line, a plain gold tear strip. No tagline on the
  pack. The page header keeps the logo with "Made to Crave®".
- **Pretzel:** the user's transparent pretzel photo (646x1468 WebP with
  alpha) is the prize, served as WebP plus a PNG fallback, about 300 px wide
  on phones. Never recoloured; the gold shimmer passes over it as a light
  sweep only.
- **Rivets:** 3 to 4 transparent pretzel-rivet cutouts, each falling with
  random x, size, spin and speed on the canvas, about 40 at once on phones
  and fewer with low battery or low frame rate. Behind the rays, so they
  never cover the pretzel or the code.
- Built with CSS 3D transforms plus one `<canvas>` for shards and
  sparkles. No library. Target 60 fps on a mid-range phone; the canvas
  stops when the sequence ends.

7. Under the voucher: "Want another?" with **Verify email (+1)** and
   **Follow on Instagram (+1)**, each greyed out once used, then a
   "3 of 3 used" state. A bonus pack replays beats 0 to 6.

**Brand:** solid brand colours. Gold-to-gold shimmer only (no green+gold
gradient). Logo printed flat and upright on the pack, never tilted,
cropped, recoloured or animated. Tagline "Made to Crave®" stays under the
page logo only, not on the packs. Pack wrapper uses the diamond plate
pattern. Archivo Black / Montserrat stand-ins. No emojis, no em dashes.
Original pack design. Nothing borrowed from any existing trading card game
(no ball icons, card frames, energy symbols or similar trade dress).

**Identity and limits:**
- First pack needs nothing. The player gets a signed, httpOnly
  `ppf_player` cookie (random id, HMAC with `APP_JWT_SECRET`, which already
  exists).
- Email: player types email + optional separate marketing opt-in box
  (unticked). We send a magic link via `api/_lib/gmail.js` `sendEmail`.
  Clicking it verifies the email, merges the cookie player into the email
  player and unlocks +1. Same email on a new device = same player, so the
  limit follows the person, not the phone.
- Instagram: tap opens the profile in a new tab and unlocks +1 on return
  (honor system, once per player).
- Hard cap 3 per player per offer, enforced server-side. Per-IP hashed
  rate limit on pack opens and magic-link sends (same pattern as leads.js).
  Clearing cookies can still get a stranger one extra first pack; accepted
  (it is one pretzel, and codes are burned at the counter).

**API (`/api/leads?resource=packs`, logic in `api/_packs.js`):**
- `GET  &view=state` player state: offer live?, packs used/allowed,
  unlocked bonuses, active vouchers.
- `POST {action:'open'}` opens a pack if allowance remains, returns voucher.
- `POST {action:'email', email, marketing_opt_in}` sends magic link.
- `GET  &verify=<token>` verifies email, redirects to `/free-pretzels`.
- `POST {action:'instagram'}` unlocks the IG pack (once).
- `POST {action:'redeem', code, pin}` burns a voucher with the store PIN.
- Operator `GET &view=stats` (opened, redeemed, emails verified, IG taps).
- CSRF same as `/ops/qr`: JSON only + Origin check. Every error answers
  with a friendly message; the free first pack must never be blocked by an
  email or Redis outage.

**Data (Supabase, RLS deny-all like the rest of the schema):**
- `pack_players(id, email unique null, email_verified_at, marketing_opt_in,
  instagram_at, created_at)`.
- `pack_vouchers(code unique, player_id, offer_key, source
  ('first'|'email'|'instagram'), created_at, expires_at, redeemed_at,
  redeemed_store)`.
- `pack_magic_links(token_hash, player_id, email, expires_at, used_at)`.
- Retention: emails without marketing opt-in are deleted 30 days after the
  offer ends (documented, run by a scheduled job later; noted as a
  follow-up, not built here).

**`/ops/qr`:** "Pack game" on/off on the offer, plus stats tiles.

## Steps
1. Migration `p10_pretzel_packs.sql` (tables, indexes, RLS deny-all).
2. `api/_packs.js` pure helpers (code gen, allowance math, email check,
   token hash, PIN check) + handlers with injectable deps; dispatch in
   `api/leads.js`.
3. `api/_qr.js` + `/ops/qr`: `game` flag and stats.
4. `free-pretzels/`: pack picker, open animation, gold celebration,
   voucher, bonus buttons, redeem sheet, reduced-motion path; static
   fallback when the API fails or the game is off.
5. Magic-link email (plain, branded, no emojis), sent with `sendEmail`.
6. Tests: allowance + cap, double-open race, merge on verify, expired or
   used tokens, voucher burn with wrong or right PIN, rate limits, game off,
   API down = static page.
7. Validate: `npm test`, `tests/guardrails.sh`, `eval-report.sh`, reviewer
   subagent, visual check at 375px and desktop with a mocked API, motion
   check with reduced motion on.
8. Record in `.agent/`, commit, push, draft PR stacked on #26.

## Success criteria
- Quantitative: all tests pass; only scoped files change; function count
  unchanged; no new npm dependencies; no new CodeQL alerts.
- Qualitative: on a phone, scan to gold celebration in under 10 seconds;
  the six beats land at the times in the table (within about 0.2 s) and
  feel like the reference clip side by side; Skip and reduced motion work;
  every pack wins; a 4th pretzel is impossible for the same email; a burned
  code cannot be used twice; with email or Redis down, the first pack still
  works; with the game off, the page is exactly today's offer page.

## Risks + mitigations
- **Personal data:** collect email only; marketing opt-in separate and off
  by default; short privacy note next to the field; retention rule above;
  emails never logged (hash in logs).
- **Gmail sending:** the existing sender needs Workspace delegation or
  OAuth; if it fails, the email spin shows "try again later" and the
  first pack is unaffected. Human confirms the sender works before launch.
- **Instagram can't be verified:** honor system, capped at one pack.
- **Staff PIN on a customer phone:** 4 digits, rate-limited (5 tries per
  code), rotatable env var `PACKS_STAFF_PIN` set by the human.
- **Motion sickness / accessibility:** reduced-motion path, full keyboard
  support, the result and code announced to screen readers.
- **Brand drift:** lint the pack copy with the existing brand lint; logo
  never animated.

## Rollback / escalation
- Turn the game off in `/ops/qr` (no deploy): `/free-pretzels` is the plain
  offer page again.
- Code: `git revert`. Data: the migration only adds tables; dropping them is
  a human step.
- Escalate on any need to edit `api/_lib/`, `vercel.json`, or add a function.

## Isolation
This branch (`agent/qr-scan-redirect`) holds draft PR #26 and its approved
plan, so this work needs its own branch. The human runs:
`scripts/agent/new-task.sh pretzel-packs <scope paths above>`
(branch `agent/pretzel-packs` cut from `agent/qr-scan-redirect`), copies
this file to `.agent/plan.md` there, and runs `approve-plan.sh` in it.

## Human steps (CRITICAL, prepare only)
- Apply `p10_pretzel_packs.sql` to Supabase.
- Set `PACKS_STAFF_PIN` (Preview + Production) and confirm Gmail sending.
- Give the Instagram handle.
- Deploy preview, play it on a phone, turn the game on in `/ops/qr`, deploy.
