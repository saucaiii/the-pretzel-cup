# Working memory (short-term). Keep under 60 lines.
Branch: agent/pretzel-packs-v3
Task: pretzel-packs-v3 (green theme, quest loop, Golden Ticket, stop at 3)
Status: building (plan approved)
Started: 2026-11-06

## Context
- Previous task (pretzel-packs v1/v2 + popup) is merged and live (main 893a774).
  Its notes are in git history of this file.
- Requests relayed by the ops/qr session (local_7f43c8af) with the user's words.
- Plan v3 approved by the human 2026-11-07T00:15Z (approval hash = sha256 of
  .agent/plan.md at 460a2ec, checked by the agent). scope.txt matches the plan.

## Progress
- Step 1 p11 migration written (a279064). APPLIED 2026-11-07 to Supabase
  the-pretzel-cup (ivwjhfndltkngefjozrj, the only project; p10 already there) after
  the user said "Yes, apply p11" in this session. Verified: source check has 'bonus',
  prize_* columns added, pack_games exists with RLS on, existing 26 vouchers untouched.
- Step 2+3 _packs.js / _qr.js + tests (ff5db4e): quest order, bonus source,
  pack_games record, stop action, staff text only after PIN, stats. npm test 180/180.
- Steps 4 to 7 done (a4a7f90, ops commit): green theme, trail, quest cards, stop, end screen,
  Golden Ticket finish + ticket voucher (packs.css, packs.js, index.html, pack3d.js).

## Deviation from approved plan (user-directed, plan.md not edited)
- "What staff give" optional: empty -> redeem sheet "Prize not set yet. Ask a manager.",
  /ops/qr warns instead of blocking. Golden Ticket needs only bonus_on + App Store link.

## Review round (reviewer subagent @ 48476b9): not ready -> fixed
- Root causes: reasoning error (fail-soft not applied to stop/stats; ticket missing the
  Instagram precondition; no server-side quest order); governance (relayed approval).
- Fixed: gameOk gate on stop + ticket, handleStop 503 when record unreadable, stats game
  counts fail soft, bonusOn needs instagram_handle (+ lint), app tap needs first+IG+email,
  redeem falls back to current staff item, no drop-in replay on load, stop error focus,
  studio background exactly #083521. npm test 185/185.
- Not fixed (noted in PR): stop racing a parallel app open can leave score 4 + stopped.
- Migration: user confirmed directly here ("Yes, apply p11"). Deploy: ask the user here.

## Keep-or-trade deal (user, directly, 2026-11-07; deviation from plan v3, plan.md not edited)
- After all 4: keep 4 pretzels or trade all 4 for the Golden Ticket (always wins).
  Ticket = any one product (default bonus_staff); redeem also burns and hands back the
  unused pretzels (staff-only "Surprise" line). Traded pretzel codes hidden and refused
  on their own. Visual: deal card, trade > ticket > end, keep > end (survives reload),
  staff sheet with surprise line. npm test 187/187.

## Retries
- 1: shell `wc -l *` in the mock folder failed (zsh glob no match on *.js).
  Root cause: tool misuse. Change: read the file with the Read tool instead.

## Visual checks (local mock, real handlers, 375 px + desktop)
- Full loop 1 > IG > email link > app > Golden Ticket, stop at 3, skip + resume after
  reload, redeem sheet (badge + Give), reduced motion, game off, public offer has no
  staff text. Beats 0/0.9/2.0/2.5/3.3/6.0 s; Golden Ticket settles at ~7.7 s.
- Browser pane was hidden (rAF stalls): final states checked by DOM and stepped frames.
  Not checked on a real phone. No-WebGL path not re-run in v3.

## Next
- Push, draft PR, user merges, deploy (ask the user), check live at phone size.

## Carried constraints
- Deploy only from this worktree (gitignored brand fonts live here).
- Never commit font files or the brand guide PDF (public repo).
- p10 migration is applied: never edit it; new changes go in p11.
- EDGE_CONFIG_WRITE_TOKEN still unset, so /ops/qr cannot save offers yet.
- Deploying v3 before p11 is applied: pretzels still open (game record fails
  soft), but the Golden Ticket and stop button would error. Apply p11 first.
