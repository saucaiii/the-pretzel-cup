# Working memory (short-term). Keep under 60 lines.
Branch: agent/photo-anchor-fix
Task: photo-anchor-fix
Status: plan drafted, awaiting human to widen scope + approve
Started: 2026-11-27

## Plan
- Full plan at .agent/plan.md. Risk: medium.
- Fix anchor 2026-12-05 (Saturday) → 2026-12-04 (Friday) in submit.js
  and driver/index.html. First real photo day was shipping on a
  Saturday; user caught it.

## Progress
- Branch created.
- Plan written.
- Edit attempt blocked by scope guard (expected — scope.txt still
  carries the previous signin-dual-role files).

## Awaiting human
1. Update `.agent-control/scope.txt` to:
   ```
   api/driver/submit.js
   driver/index.html
   ```
2. Run `scripts/agent/approve-plan.sh` to record this plan's hash.

## After approval
- Two one-line edits, smoke test, commit, push, PR.
