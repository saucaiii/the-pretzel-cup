# Plan: pretzel-packs v3 (green theme, quest loop, Golden Ticket)

Draft, 2026-11-06. Not approved. Branch `agent/pretzel-packs-v3` from
main 893a774 (v1, v2 and the popup are live). v2 plan is in git history.
Needs a new `scripts/agent/approve-plan.sh` and a new scope (below)
before any code changes.

## Risk
**CRITICAL (prizes, personal data, a new migration), with HIGH parts.**
- CRITICAL: a new prize (Golden Ticket) with its own voucher; a new
  migration on live pack tables plus a new per-player game record.
  Human applies the migration (or authorizes it in chat), sets what
  staff give, deploys.
- HIGH: `supabase/migrations/` is a high-risk path in this repo.
- MEDIUM: `api/_packs.js` (new `bonus` source, quest order, stop action,
  game record), `api/_qr.js` (bonus settings), `/ops/qr` fields and stats.
- LOW: colours, layout, motion.
- Automated decisions about people: none. Outcomes are deterministic:
  every pack wins; everyone who completes all 4 gets the same Golden
  Ticket. No odds, no randomness in prizes.
- Personal data: no new personal fields. The game record stores only a
  score, an end state and timestamps against the existing player id.

## Goal
Keep people in one game loop through 4 free pretzels on the site's
green brand, without the stacked "Want another?" forms. Loop: quest >
pack drops in > rip > win > next quest. Completing all 4 earns a Golden
Ticket. A player can end at 3 with "I don't need another app", and we
record how every game ended.

## User direction (2026-11-06, relayed from the ops/qr session)
- No black backgrounds; follow the site design and brand guidelines.
- Remove the "Want another?" section.
- Keep people in the loop until the 4 free pretzels are done.
- "We are not a gambling site."
- Golden bonus prize: "Find out in store" (mystery reward, revealed at
  the counter). Shown as a "Golden Ticket".
- "Maybe the golden is if they do all 4. if they do 3 (initial free,
  insta, email) give them an 'i dont need another app' button so we
  can clock who stops at 3 and who pushes all 4." Choosing it ends the
  game and records a score of 3. "Acknowledge in our ledger who
  completes all 4."

## Assumptions (not stated by the user; confirm in review)
- A player who stops at 3 keeps their 3 pretzels and gets no Golden
  Ticket. Stopping is final for that offer (the app quest goes away).
- "Ledger" = the new per-player game record plus a "Completed all 4"
  list in `/ops/qr` and a badge on the staff redeem sheet. Not the
  Pretzel Cup leaderboard.
- The Golden Ticket needs the App Store link to be set. If the game is
  on without it, the trail ends at 3, no ticket or stop button shows,
  and `/ops/qr` warns that the Golden Ticket cannot be earned.
- "Left without finishing" is not a separate event (people just close
  the tab): it is any game record with no end, reported at its last
  score.

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
- 4 pretzel slots, then a gold Golden Ticket node at the end:
  `[1 free] [2 Instagram] [3 email] [4 app] [GOLDEN TICKET]`.
- Slot 1 fills after the first pull, so they start at "1 of 4".
- Locked slots show the action they need ("Follow", "Email",
  "Download"); filled slots show a gold pretzel; the current quest's
  slot is outlined. Label: "3 of 4 collected".
- Line under the trail: "Every pack wins." (honest, not chance).
- Golden Ticket node hidden when the bonus is off or no App Store link
  is set (trail shows only what can be earned).

**3. One quest at a time (replaces "Want another?")**
- After a win settles, the voucher stacks into the set and the next
  quest card slides in where the voucher settled, with one CTA:
  - Quest 2 Instagram: "Follow @handle" (opens Instagram, unlocks on
    return, as today).
  - Quest 3 Email: the existing email form (magic link, POST verify).
    Card copy says to check their inbox; the link resumes here.
  - Quest 4 App: "Download the app" (honour tap, as today), plus a
    secondary button "I don't need another app" (see 4).
  - After 4 of 4: "Your Golden Ticket pack is ready." No action needed.
- When a quest is done, the next pack drops into the centre of the
  carousel with a glow; tap to rip. The 5-pack carousel stays for the
  first pick only; later packs drop in one at a time.
- "Skip for now" under the Instagram and email cards: closes the card,
  keeps every voucher, the trail stays so they can resume. The game is
  not ended. No re-prompt on the same visit.
- Set view: collected vouchers as a stack ("3 of 4 collected"), tap to
  expand any code for the counter.

**4. Ending the game**
- **Stop at 3:** "I don't need another app" shows only on the app card,
  when first, Instagram and email are done and the app pack is not.
  One plain confirm ("End your game? You keep your 3 pretzels.") then
  the end screen. No loss framing, no "are you sure you want to miss
  out".
- **End screen** (stop at 3 or after the Golden Ticket): the vouchers
  they won, a short closing message ("Thanks for playing. Show a code
  at the counter."; after 4: "Set complete. 4 of 4 and a Golden
  Ticket."), and no more quests.
- **Complete 4:** the 4th pretzel is opened, the Golden Ticket pack
  drops in, they rip it, the game ends as completed.
- Server records every end (section API).

**5. Golden Ticket pack**
- Unlocks only after all 4 pretzels (first, Instagram, email, app).
- Own sequence: polished mirror-gold finish (pretzel packs become satin
  gold so the ticket pack clearly differs), gold-deep crimps, a
  "GOLDEN TICKET" foil band, longer rivet rain, a stamp, its own
  voucher. Beats: regular timing table unchanged; this one adds about
  1.5 s to the rain and stamp (ends near 7.5 s).
- **Mystery reward, revealed at the counter.** The voucher never names
  the prize.
- **Golden Ticket voucher.** Default title "Golden Ticket", default
  line "Visit the Pretzel Factory to claim your prize." Look: a ticket
  shape (notched ends, perforation before the code stub) in solid brand
  golds: gold-light #F2E7A4 body, gold #D4B662 border and stub,
  gold-deep #B2872F perforation and accents, black text on gold. One
  gold-to-gold shimmer on reveal; no other gradients, no shadows.
- **Deterministic, not a sweepstakes:** one fixed item per offer, set
  in `/ops/qr`. Everyone who completes all 4 in an offer gets the same
  thing. No random draw, no prize pool, no odds. "Mystery" only means
  the name is hidden until the counter.
- Settings in `/ops/qr`: on/off; title (max 40, default "Golden
  Ticket"); line (max 120, default above); **"What staff give"**
  (internal only, max 60, e.g. "Free dip with any pretzel"). Off by
  default; cannot be turned on while "What staff give" is empty.
- "What staff give" never reaches the public page, the public offer GET
  or the player API. Shown only in `/ops/qr` (operator session) and on
  the redeem sheet after a correct staff PIN.
- All three texts are copied onto the voucher when it opens.

**6. Gentle escalation (collect-the-set, not slot machine)**
- Each win a little bigger: more rivets and a slightly longer shimmer
  per pack number; the Golden Ticket is the biggest.
- Kept: anticipation (tear, rip), a progress meter, a bonus round,
  celebration, set completion.
- Not used: near-misses, fake odds, countdown timers, loss framing,
  autoplay of the next pack, streaks.

**7. Persistence**
- Truth stays on the server (cookie player + vouchers + game record).
- localStorage (`ppf_packs_ui`, try/catch, no personal data): skipped
  flag per offer and the last settled count, so a reload resumes at the
  right quest card without replaying a win.
- Email magic link lands on `/free-pretzels#pack_verify=...`, verifies,
  then shows the next quest (the email pretzel pack).

## API and data changes
- `p11_pretzel_packs_bonus.sql` (new, additive):
  - `pack_vouchers.source` check adds `'bonus'`; nullable columns
    `prize_title` (<= 40), `prize_public` (<= 120), `prize_staff`
    (<= 60).
  - New table `pack_games`: `player_id` (fk pack_players), `offer_key`,
    `score` int 0 to 4, `ended` text null or in
    (`'completed'`, `'stopped_at_3'`), `completed_all` boolean default
    false, `started_at`, `last_at`, `ended_at`; unique
    (player_id, offer_key); RLS on, deny-all. No email, IP or device
    data.
  - `down` statements noted in the file.
- `api/_packs.js`:
  - Opening order: first, instagram, email, app, then bonus.
  - `bonus` unlocks only when first, instagram, email and app vouchers
    exist for this offer and the bonus is on. Does not count toward the
    4 pretzels (`MAX_PACKS` stays 4); unique (player_id, offer_key,
    source) caps it at 1.
  - Every open upserts `pack_games` (score = pretzel vouchers, last_at).
    Opening the 4th sets `completed_all` true and `ended='completed'`
    with `ended_at`. The Golden Ticket opens even after `ended`
    is completed.
  - New `{action:'stop'}`: allowed only at score 3 with first,
    instagram and email used, app not used, game not ended. Sets
    `ended='stopped_at_3'`, `ended_at`. Rate-limited. After it, open
    and the app honour tap refuse with a clear message.
  - State gains `trail`, `next_quest`, `ended`, `score`, `can_stop`,
    `bonus` (`{on, title, text}`, public only). `publicVoucher` never
    includes `prize_staff`.
  - Redeem: after a correct PIN, the response includes `prize_staff`
    for Golden Ticket codes and `completed_all` for the player, so the
    sheet shows "Give: ..." and a "Completed all 4" badge.
  - Operator stats: players by end (completed 4 / stopped at 3 / not
    finished, by last score 1 to 4), counts per step (pulled 1,
    Instagram, email, app, Golden Ticket opened, redeemed), and a
    "Completed all 4" list: Golden Ticket code, completed date, redeemed
    or not, email masked (`j***@example.com`). Head counts as today.
  - Merge on email verify: `pack_games` rows follow the existing merge
    rule (keep the higher score; an end state is kept).
- `api/_qr.js`: offer gains `bonus_on`, `bonus_title`, `bonus_text`
  (Golden Ticket defaults) and `bonus_staff` (1 to 60 chars, required
  when on). The public offer GET strips `bonus_staff`. Warn (not block)
  when the bonus is on and no App Store link is set.
- `/ops/qr`: Golden Ticket toggle, title, line, "What staff give"
  (marked internal); end-state and per-step stats; Completed all 4 list.

## Steps
1. Migration `p11_pretzel_packs_bonus.sql` (not applied by the agent).
2. `_packs.js` + `_qr.js`: order, bonus source, texts, game record,
   stop action, state shape, settings validation, stats, redeem badge.
3. Tests: order; bonus needs all 4 and the setting; not counted in 4;
   once per player; texts snapshotted; defaults; cannot enable without
   staff text; stop only at exactly 3 (not 2, not after app, not
   twice); stop blocks app and further opens; score and end states
   recorded; completed_all set on 4th; merge keeps higher score;
   staff text and completed list absent from every public response;
   staff text only after a correct PIN.
4. Green theme: `packs.css`, `index.html` inline styles, pack3d studio.
5. Trail + quest cards + stop button + end screen + skip + set stack;
   remove the "Want another?" block.
6. Golden Ticket pack finish, sequence and ticket voucher.
7. `/ops/qr` settings, stats and Completed all 4 list.
8. Validate: `npm test`, `tests/guardrails.sh`, `eval-report.sh`,
   reviewer subagent, visual check on the local mock at 375 px and
   desktop (full loop 1 > 4 > Golden Ticket, stop at 3, bonus off, app
   link unset, skip and resume, reload mid-loop, email link resume,
   reduced motion, no WebGL, game off, ops stats).
9. Record in `.agent/`, commit, push, draft PR (screenshots, honour
   system note for Instagram and app, migration as a human step,
   assumptions listed).

## Success criteria
- Quantitative: all tests pass; only scoped files change; 12 functions;
  no new dependencies; no `var(--black)` backgrounds left in the game,
  stage or sheet (grep); at most 4 pretzels + 1 Golden Ticket per
  player per offer; every player with a voucher has one game record.
- Qualitative: on a phone the game reads as the green Pretzel Cup site;
  after each win exactly one next step is shown; at 3 of 4 the player
  can finish or end with one tap; `/ops/qr` shows stopped at 3 vs
  completed 4 and who completed all 4; no copy implies chance,
  scarcity or loss; the ticket never names the prize; staff text never
  appears in a public response.

## Risks + mitigations
- **Gambling perception:** deterministic outcomes, "Every pack wins",
  no odds, timers or near-misses; the ticket is earned, not drawn;
  copy says "claim your prize", never "chance" or "could win".
- **Stop button as pressure:** neutral wording, one plain confirm, keeps
  every code; no "you'll miss out".
- **Honour-system steps (Instagram, app):** cannot be verified; once per
  player, capped; stated in the PR. This also means "completed all 4"
  counts taps, not real follows or installs.
- **Staff text leaking:** kept out of `publicVoucher`, the public offer
  GET and state; tests assert it.
- **Personal data:** game record holds no new personal fields; the
  operator list masks emails.
- **Migration on live tables:** additive only; human applies; rollback
  in the file.
- **Green reflections dull the foil:** compare screenshots; fall back
  to the black studio for the pack only if gold looks muddy.
- **Order change mid-campaign:** existing codes kept; next quest
  computed from what is missing; game records backfilled lazily on the
  next state read for players who already have vouchers.

## Rollback / escalation
- Turn the game or the Golden Ticket off in `/ops/qr` (no deploy).
- Code: `git revert` of the v3 commits returns to v2 + popup.
- Migration: drop `pack_games` and the three `prize_*` columns, restore
  the old source check (only if no bonus rows exist).
- Escalate on any need for a new function, `vercel.json`, `api/_lib/`,
  `brand.css`, or an npm dependency.

## Human steps (CRITICAL, prepare only)
- Set the task scope to the Scope line above, then run
  `scripts/agent/approve-plan.sh`.
- Confirm the four assumptions above.
- Decide what staff give for the Golden Ticket, enter it in `/ops/qr`
  and turn it on (needs `EDGE_CONFIG_WRITE_TOKEN`, still unset), or
  tell the agent. Brief counter staff that it is a fixed item.
- Apply `p11_pretzel_packs_bonus.sql` (or authorize the agent in chat).
- Review the draft PR screenshots on a phone, merge, deploy from the
  worktree (`npm run deploy`).
