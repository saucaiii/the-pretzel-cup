# Working memory (short-term). Keep under 60 lines.
Branch: agent/pretzel-share
Task: pretzel-share (pretzel 4 = "Share with your group chat")
Status: review fixes done; draft PR next. Human applies p21, merges, deploys, then applies p22.
Started: 2026-11-07T09:05Z (plan approved by the user with approve-plan.sh, same day)

## Context
- Started from session local_826e80eb. User decisions (directly in this session): rename source to
  `share` incl. DB; share step always on, completing it opens the Golden Ticket (no App Store link);
  stop text "No thanks, I hate delicious and free pretzels."; message "Won mine, your turn".
- Scope: free-pretzels/ api/_packs.js api/_qr.js ops/qr/ tests/ supabase/migrations/ .agent/

## Progress
- p21_pretzel_share.sql (expand: share_at column, check allows app+share) and
  p22_pretzel_share_backfill.sql (contract: app -> share, after deploy). Not applied anywhere.
- api/_packs.js: PRETZELS uses share; withLegacy() reads 'app'/app_at as share until p22;
  action 'app' = alias; bonusOn/canStop no longer need app_store_url; stats share/share_taps.
- api/_qr.js + ops/qr: App Store field, hint and golden warning removed; stats relabelled.
- free-pretzels: #q-share (Web Share button, or sms: link + Copy link), copy + stop text;
  index.html.ids regenerated (119 ids, no dups, every $('id') in packs.js exists).
- tests: app -> share; new: share without App Store link, 'app' alias, legacy app_at/app voucher.

## Validation
- npm test 191/191; guardrails 106/0. eval-report: Tests pass, Scope match FAIL ("No scope declared
  in the plan": scope-check.sh wants a "Scope: a, b" line; plan.md has a heading). Not fixed in
  plan.md (an edit voids the approval); the PR body carries the Scope line CI reads. All changed
  files are inside the task's scope.txt (checked by the reviewer). Earlier "eval-report pass" here
  was wrong: I read only the test tail.
- Mock loop (scratchpad mock-server.cjs, real handle(), in-memory store) at 375 px:
  no Web Share -> "Text your group chat" + "Copy link" (sms body + link correct); copy fallback
  unlocked pack 4; pack 4 opened as 'share'; keep-or-spin shown with no App Store link; binder
  "Share" slot won. Web Share (stubbed navigator.share) -> one button, sheet gets text + url, unlocks.
- After fixes (stubbed): share error -> text + copy fallback stays after re-render; copy failure
  shows the text and unlocks after ~8 s.
- Not verified: a real iPhone/Android share sheet, the AbortError (cancel) path in a browser (code
  only), /ops/qr page in a browser (needs operator login), migrations on a real DB.

## Handoffs
- implementer (this session) -> reviewer subagent: diff vs plan. Result: not ready, 8 findings.
  Fixed: p22 duplicate pre-check (was: would abort on the check), p21 in a transaction, rollback
  note in p21, moveVouchers treats app/share as one slot (+test), legacy redeem/burn test, client
  fallback sticks after a share error, one pending sms unlock, copy-failure text stays readable,
  old-tab comment made honest. Not fixed, in PR: old open tabs need a reload (TRAIL.share missing
  in old JS); code rollback needs p22's rollback first; Golden Ticket goes live at deploy for
  offers with bonus_on + Instagram. Re-checked in browser at 375 px after the fixes.

## Retries
- mock-server write step exit 1: tool misuse (trailing `cat` of a missing .claude/launch.json; the script itself was written). Change: no launch.json, run the mock with Bash in the background.
- second mock exit 1: context/environment issue (port 4318 already used by another local node process). Change: port 4329.
