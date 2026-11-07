# Plan: pretzel 4 = "Share with your group chat" (task pretzel-share)

Risk: **High** (`supabase/migrations/` is in HIGH_RISK_RE; server game rules change).
Applying the migrations to production is **Critical**: prepared only, a human applies them
(or confirms directly in the agent's session first).
No fairness flag: no new automated decisions about people beyond the existing honor-system unlock.

## Goal
Pretzel 4 on /free-pretzels changes from "Download the app" to "Share with your group chat".
The button opens the phone's share sheet (`navigator.share`) with
"I just won free pretzels from Philly Pretzel Factory 🥨 Rip a pack and win yours:" plus the page link.
No Web Share (desktop): an `sms:` link with the same body prefilled, plus a "Copy link" button.
Pack 4 unlocks on the honor system after the share. Completing the share opens the Golden Ticket
(keep-or-spin) exactly as the app step does today.

## User decisions (2026-11-07, directly in session pretzel-share)
- Rename the source to `share` everywhere, DB included (not keep `app`).
- "Completing the share opens the door to play for the Golden Ticket": the share step is always on
  (no App Store link); the Golden Ticket needs `bonus_on` + the Instagram handle only.
- Stop button text: "No thanks, I hate delicious and free pretzels." Same behaviour (ends at 3).
- Message wording: "Won mine, your turn" (above).

## Scope (set by the human in the task's control folder)
free-pretzels/  api/_packs.js  api/_qr.js  ops/qr/  tests/  supabase/migrations/  .agent/
No new serverless function. `api/_lib/`, `vercel.json` untouched.

## Steps
1. Migration `p21_pretzel_share.sql` (expand, safe with the live code): `pack_players` add
   `share_at timestamptz`; `pack_vouchers_source_check` allows
   ('first','email','instagram','app','share','bonus'). Commented rollback.
2. Migration `p22_pretzel_share_backfill.sql` (contract, run only AFTER the new code is deployed):
   vouchers 'app' -> 'share', `share_at = coalesce(share_at, app_at)`, check drops 'app'.
   `app_at` column kept for rollback (drop in a later cleanup). Commented rollback.
   Why two: renaming 'app' rows while the old code is live would let a mid-game player open a 2nd pretzel 4.
3. `api/_packs.js`: PRETZELS `[first, instagram, email, share]`; one helper normalizes legacy
   'app' vouchers / `app_at` to share until p22 runs; `avail.share` always true;
   `bonusOn` = bonus_on && instagram_handle; `canStop` drops the App Store link check;
   honor action `share` (same quest-order check, same per-IP limit); `action:'app'` kept as an alias
   for one release so open tabs keep working; state drops `app_store_url`, has `bonuses.share`;
   stats `opened.share` / `share_taps` (count legacy 'app' too until p22).
4. `api/_qr.js` + `ops/qr/index.html`: remove the App Store link field, its hint text and the
   "Golden Ticket needs the App Store link" warning (old stored value accepted, ignored);
   stats rows "4. Share packs", "Share taps"; stopped-at-3 label uses the new button text.
5. `free-pretzels/packs.js` + `index.html`: `#q-share` block with the share button;
   Web Share -> unlock on success (cancel does nothing); fallback `sms:` link + "Copy link", each
   unlocks on tap; QUEST/SLOT copy "Share with your group chat"; App Store badge code removed;
   stop button text changed in the step and the binder.
6. `tests/packs.test.mjs`: app -> share; new cases: share on without an App Store link; Golden Ticket
   on without it; legacy 'app' voucher / `app_at` counts as pretzel 4; `action:'app'` alias;
   stop works without the link.
7. Validate: `npm test`, `tests/guardrails.sh`, `scripts/agent/eval-report.sh`, mock-server loop at
   375 px (share button, fallback, unlock, keep-or-spin, stop text), reviewer subagent.
8. Record state/decisions, push `agent/pretzel-share`, draft PR with the deploy order:
   apply p21 -> merge -> `npm run deploy` -> apply p22.

## Success criteria
- Quantitative: npm test green; guardrails pass; only scope files change; no new file in api/ root.
- Qualitative: at 375 px step 4 reads "Share with your group chat"; tapping it opens the share sheet
  (or the sms/copy fallback); after it pack 4 opens and keep-or-spin appears with no App Store link set.
  Players mid-game on the old app step lose nothing.

## Risks + mitigations
- Rename while live: expand/contract migrations + legacy read fallback (steps 1-3).
- Web Share: iOS resolves when sent and rejects on cancel; some browsers resolve on open. Honor
  system either way, like Instagram.
- `sms:` body syntax differs (iOS `&body=`, Android `?body=`): use `sms:?&body=`, which both accept.
- Abuse: same honor-system risk as today; the per-IP rate limit covers `share`.

## Rollback / escalation
Revert the PR and redeploy the previous commit. Before p22: nothing to undo (p21 is additive).
After p22: run its commented rollback (share -> app) before redeploying old code.
Escalate on a failing migration check, any scope need outside the list, or 2 failed retries.
