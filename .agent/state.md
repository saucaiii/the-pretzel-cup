# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/eager-einstein-93e3e9
Task: Wholesale operator control surface (status transitions, invoice send,
      campaign send controls, email history) — follow-up to merged PR #14.
Status: Phase 0 — scope.txt updated, plan written, waiting on
        scripts/agent/approve-plan.sh to bind the plan hash.

## Progress
- Worktree fast-forwarded to `origin/main` (9f67ea3, PR #14 merged) so the
  wholesale code is here.
- Audited the shipped stack: order.js (public GET), campaigns/send.js
  (Bearer CRON_SECRET), ops/wholesale/index.html, auth.js (JWT cookie,
  `sess.sub = people.id`), gmail.js, md.js, p14_wholesale.sql.
- Vercel function-count: only ONE new function this task
  (`api/wholesale/invoice.js`). PATCH goes on existing `order.js`;
  operator-auth branch added inline to `campaigns/send.js`.
- Risk: HIGH — writes `wholesale_orders` state, drives live-email path
  (still env-gated by `EMAIL_SEND_LIVE_ENABLED=true`).
- Plan written to `.agent/plan.md` with six phases, one commit each.
- scope.txt reset by the human to this worktree's paths.

## Failures and root causes
- (none yet)

## Review notes
- Awaiting human `scripts/agent/approve-plan.sh` to bind the plan hash.

## Handoff — needs human
- Run `scripts/agent/approve-plan.sh` from the main-repo root to bind the
  current plan hash to `.agent-control/approval`. Any later edit to
  plan.md voids approval.

After approval, Phase 1 (p15 migration) starts.
