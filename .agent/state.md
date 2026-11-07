# Working memory (short-term). Keep under 60 lines.
Branch: agent/pretzel-packs-v3
Task: pretzel-packs-v3 (green theme, quest loop, golden bonus)
Status: plan written, WAITING for human scope + approve-plan.sh
Started: 2026-11-06

## Context
- Previous task (pretzel-packs v1/v2 + popup) is merged and live (main 893a774).
  Its notes are in git history of this file.
- Request relayed by the ops/qr session (local_7f43c8af) with the user's words:
  no black backgrounds, remove "Want another?", keep people in the loop to 4,
  "not a gambling site", email + Instagram unlock a special bonus.

## Progress
- Branch agent/pretzel-packs-v3 created from origin/main.
- Plan v3 written to .agent/plan.md. No code edited.
- Plan updated: golden bonus is a mystery reward revealed at the counter; internal "what staff give" field; deterministic (user decision via ops/qr session).
- Plan updated: bonus voucher is a Golden Ticket ("Golden Ticket" / "Visit the Pretzel Factory to claim your prize."), gold-palette ticket look; staff-only field kept.

## Next
- Human: set scope to the plan's Scope line, run scripts/agent/approve-plan.sh.
- Then build steps 1 to 9 of the plan.

## Carried constraints
- Deploy only from this worktree (gitignored brand fonts live here).
- Never commit font files or the brand guide PDF (public repo).
- p10 migration is applied: never edit it; new changes go in p11.
- EDGE_CONFIG_WRITE_TOKEN still unset, so /ops/qr cannot save offers yet.
