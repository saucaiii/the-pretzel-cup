# Plan: pretzel-packs v3 (green theme, quest loop, golden bonus)

Draft, 2026-11-06. Not approved. Branch `agent/pretzel-packs-v3` from
main 893a774 (v1, v2 and the popup are live). v2 plan is in git history.
Needs a new `scripts/agent/approve-plan.sh` and a new scope (below)
before any code changes.

## Risk
**CRITICAL (prizes, personal data, a new migration), with HIGH parts.**
- CRITICAL: a new prize type (golden bonus) with its own voucher; a new
  migration on the live `pack_vouchers` table. Human applies the
  migration (or authorizes it in chat), sets the prize text, deploys.
- HIGH: `supabase/migrations/` is a high-risk path in this repo.
- MEDIUM: `api/_packs.js` (new `bonus` source, quest order), `api/_qr.js`
  (bonus settings), `/ops/qr` fields and stats.
- LOW: colours, layout, motion.
- Automated decisions about people: none. Outcomes are deterministic:
  every pack wins, every player who does Instagram + email gets the same
  bonus. No odds, no randomness in prizes.

## Goal
Keep people in one game loop until they collect all 4 free pretzels,
on the site's green brand, without the stacked "Want another?" forms.
Loop: quest > pack drops in > rip > win > next quest. Instagram + email
unlock a golden bonus pack between pretzel 3 and 4.

## User direction (2026-11-06, relayed from the ops/qr session)
- No black backgrounds; follow the site design and brand guidelines.
- Remove the "Want another?" section.
- Keep people in the loop until the 4 free pretzels are done.
- "We are not a gambling site."
- Email + Instagram is enough to unlock a special bonus win.

## Scope
**Scope (paths/files):** api/_packs.js api/_qr.js ops/qr/ free-pretzels/ supabase/migrations/p11_pretzel_packs_bonus.sql tests/ .agent/

Change from v2: drops `api/leads.js` (dispatch unchanged) and
`p10_pretzel_packs.sql` (applied, never edited again); adds the new
`p11_pretzel_packs_bonus.sql`. Not touched: `api/_lib/`, `vercel.json`,
`middleware.js`, `scripts/`, `.github/`, `package.json`, `brand.css`.
Function count stays 12 (still `?resource=packs`).

## Design

**1. Green theme (brand.css tokens, no new colours)**
- Game section, full-screen stage, staff redeem sheet: `--bg` green
  #0D5237; panels and the trail on `--bg-2` green-deep #083521.
- Gold (#D4B662 / #F2E7A4) for CTAs, highlights, trail nodes, codes.
  Black only as text on gold. White text on green.
- `.btn-dark` replaced by the gold solid button on green.
- 3D studio environment: deep green with gold-light softboxes (was
  black), so foil reflections read on-brand. Checked side by side.
- Popup stays as approved (semi-transparent grey card, solid contents).
- Brand rules kept: solid colours, gold-to-gold shimmer only, no
  shadows, no emojis, no em dashes in copy.

**2. Pretzel trail (persistent, top of the game)**
- 4 pretzel slots + a gold BONUS node between slot 3 and 4:
  `[1 free] [2 Instagram] [3 email] [BONUS] [4 app]`.
- Slot 1 fills after the first pull, so they start at "1 of 4".
- Locked slots show the action they need (icon-free text: "Follow",
  "Email", "Download"); filled slots show a gold pretzel; the current
  quest's slot is outlined. Label: "3 of 4 collected".
- Line under the trail: "Every pack wins." (honest, not chance).
- BONUS node hidden when the bonus is off; app slot hidden when no
  App Store link is set (trail shows only what can be earned).

**3. One quest at a time (replaces "Want another?")**
- After a win settles, the voucher stacks into the set and the next
  quest card slides in where the voucher settled, with one CTA:
  - Quest 2 Instagram: "Follow @handle" (opens Instagram, unlocks on
    return, as today).
  - Quest 3 Email: the existing email form (magic link, POST verify).
    Card copy says to check their inbox; the link resumes here.
  - Golden bonus: no action, unlocked by Instagram + email. "Your
    golden bonus pack is ready."
  - Quest 4 App: "Download the app" (honour tap, as today).
- When a quest is done, the next pack drops into the centre of the
  carousel with a glow; tap to rip. The 5-pack carousel stays for the
  first pick only; later packs drop in one at a time.
- "Skip for now" under each quest card: closes the card, keeps every
  voucher, and the trail stays so they can resume. No nagging, no
  re-prompt on the same visit.
- Set view: collected vouchers as a stack ("3 of 4 collected"), tap to
  expand any code for the counter. Full set: "Set complete. 4 of 4."

**4. Golden bonus pack**
- Own sequence: polished mirror-gold finish (v1 to v4 packs become a
  satin gold so the bonus clearly differs), gold-deep crimps, a "BONUS"
  foil band, longer rivet rain, a "BONUS" stamp, its own voucher card
  showing the prize text. Beats: regular timing table unchanged; bonus
  adds about 1.5 s to the rain and stamp (ends near 7.5 s).
- Prize is a setting in `/ops/qr`: on/off + prize text (max 60
  chars, e.g. "Free dip with any pretzel" as the input placeholder).
  Off by default. It cannot be turned on with empty text, so a
  placeholder can never reach a customer or the counter.
- The prize text is copied onto the voucher when opened, so staff see
  what was promised even if the setting changes later.

**5. Gentle escalation (collect-the-set, not slot machine)**
- Each win a little bigger: more rivets and a slightly longer shimmer
  per pack number; the bonus is the biggest; pack 4 adds a set-complete
  stamp.
- Kept from bonus-game UX: anticipation (tear, rip), a progress meter,
  a bonus round, celebration, set completion.
- Not used: near-misses, fake odds, countdown timers, loss framing
  ("don't lose your..."), autoplay of the next pack, streaks.

**6. Persistence**
- Truth stays on the server (cookie player + vouchers), as today.
- localStorage (`ppf_packs_ui`, try/catch, no personal data): skipped
  flag per offer and the last settled count, so a reload resumes at the
  right quest card without replaying a win.
- Email magic link lands on `/free-pretzels#pack_verify=...`, verifies,
  then opens straight to the golden bonus pack (or the next quest).

## API and data changes
- `p11_pretzel_packs_bonus.sql` (new): `pack_vouchers.source` check adds
  `'bonus'`; new nullable column `prize text` (check length <= 60).
  Existing rows untouched; reversible (`down` noted in the file).
- `api/_packs.js`:
  - Opening order: first, instagram, email, bonus, app.
  - `bonus` unlocks when `email_verified_at` and `instagram_at` are set
    and the offer's bonus is on with text. It does not count toward the
    4 pretzels (`MAX_PACKS` stays 4); the unique
    (player_id, offer_key, source) still caps it at 1.
  - Opening a bonus voucher snapshots `prize`.
  - State gains `trail` (ordered nodes with state locked / ready /
    done / off), `next_quest`, `bonus` (`{on, prize}`), `collected`.
  - Redeem shows the prize text for bonus codes. Stats add bonus
    opened / redeemed.
- `api/_qr.js`: offer gains `bonus_on` (boolean) and `bonus_prize`
  (trimmed, 1 to 60 chars, required when on).
- `/ops/qr`: bonus toggle + prize field in the offer form; stats rows.
- Merge on email verify (existing rule): the bonus slot follows the
  same void-duplicate rule as the other slots.

## Steps
1. Migration `p11_pretzel_packs_bonus.sql` (not applied by the agent).
2. `_packs.js` + `_qr.js`: order, bonus source, prize snapshot, state
   shape, settings validation, stats.
3. Tests: order, bonus unlock only with IG + email + setting on, bonus
   not counted in 4, once per player, prize snapshot, cannot enable
   with empty text, merge voids a duplicate bonus, redeem shows prize.
4. Green theme: `packs.css`, `index.html` inline styles, pack3d studio.
5. Trail + quest cards + skip + set stack (`index.html`, `packs.js`,
   `packs.css`); remove the "Want another?" block.
6. Golden pack finish and bonus sequence (`pack3d.js`, `packs.js`).
7. `/ops/qr` bonus fields and stats.
8. Validate: `npm test`, `tests/guardrails.sh`, `eval-report.sh`,
   reviewer subagent, visual check on the local mock at 375 px and
   desktop (full loop 1 > 4 with bonus, bonus off, app link unset,
   skip and resume, reload mid-loop, email link resume, reduced
   motion, no WebGL, game off).
9. Record in `.agent/`, commit, push, draft PR (screenshots, IG and app
   are honour-system and cannot be verified, migration as a human step).

## Success criteria
- Quantitative: all tests pass; only scoped files change; 12 functions;
  no new dependencies; no `var(--black)` backgrounds left in the game,
  stage or sheet (grep); at most 4 pretzel vouchers + 1 bonus per
  player per offer.
- Qualitative: on a phone the game reads as the green Pretzel Cup site;
  after each win exactly one next step is shown; a player can go
  1 > IG > email > bonus > app without scrolling to find the next
  action; skipping keeps every code; no copy implies chance, scarcity
  or loss; the bonus never shows placeholder text to a customer.

## Risks + mitigations
- **Gambling perception:** deterministic outcomes, "Every pack wins",
  no odds, timers or near-misses; the bonus is earned, not drawn.
- **Honour-system bonuses (Instagram, app):** cannot be verified; once
  per player, capped; stated in the PR.
- **Migration on a live table:** additive only (wider check, nullable
  column); human applies; rollback statement in the file.
- **Bonus prize promise:** off until a human sets real text; text
  snapshotted on the voucher.
- **Green reflections dull the foil:** compare screenshots; fall back
  to the black studio for the pack only if gold looks muddy (no black
  page surfaces either way).
- **Order change mid-campaign:** players who already used email before
  Instagram keep their codes; the next quest is computed from what is
  missing, not from a fixed index.

## Rollback / escalation
- Turn the game or the bonus off in `/ops/qr` (no deploy).
- Code: `git revert` of the v3 commits returns to v2 + popup.
- Migration: drop the `prize` column and restore the old check (only
  if no bonus rows exist).
- Escalate on any need for a new function, `vercel.json`, `api/_lib/`,
  `brand.css`, or an npm dependency.

## Human steps (CRITICAL, prepare only)
- Set the task scope to the Scope line above, then run
  `scripts/agent/approve-plan.sh`.
- Pick the bonus prize text and turn it on in `/ops/qr` (needs
  `EDGE_CONFIG_WRITE_TOKEN`, still unset) or tell the agent the text.
- Apply `p11_pretzel_packs_bonus.sql` (or authorize the agent in chat).
- Review the draft PR screenshots on a phone, merge, deploy from the
  worktree (`npm run deploy`).
