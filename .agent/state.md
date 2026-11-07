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

## Retries
- 1: shell `wc -l *` in the mock folder failed (zsh glob no match on *.js).
  Root cause: tool misuse. Change: read the file with the Read tool instead.

## Next
- /ops/qr bonus settings + stats, visual checks on a local mock, guardrails,
  eval-report, reviewer, draft PR.

## Carried constraints
- Deploy only from this worktree (gitignored brand fonts live here).
- Never commit font files or the brand guide PDF (public repo).
- p10 migration is applied: never edit it; new changes go in p11.
- EDGE_CONFIG_WRITE_TOKEN still unset, so /ops/qr cannot save offers yet.
- Deploying v3 before p11 is applied: pretzels still open (game record fails
  soft), but the Golden Ticket and stop button would error. Apply p11 first.
