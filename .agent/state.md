# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/wholesale-submit-hardening (based on origin/main past PR #22 merge)
Task: Three coupled hardening fixes to api/wholesale/submit.js
      (C) customer-upsert overwrite, (D) server-side pickup_date,
      (E) promo-code validate + normalize.

## Progress
- Branched off origin/main (PR #22 merged) → claude/wholesale-submit-hardening.
- MEDIUM risk — no approve-plan.sh; plan fields live in the PR body.
- Implemented:
  - PICKUP_DATE_RE + 400 reject on missing/malformed pickup_date.
  - Customer upsert → `ignoreDuplicates: true` + SELECT-on-conflict
    fallback, so operator profile edits survive resubmits.
  - Promo-code normalize: trim + uppercase, look up against
    `wholesale_campaign_emails.promo_code`, store normalized when
    matched else null. Bonus stays (quantity-driven via applyBonus).
- Smoke test (mock-supabase in-memory) passes all three paths:
  missing/bad pickup_date → 400; resubmit leaves profile intact;
  known promo normalized, unknown dropped to null.
- Decision-log entries added for the three fixes.

## Review notes
- No reviewer subagent run — smoke test exercised the three fixed
  paths; CI (plan-gate, scope-check, agent-conflicts, test, CodeQL)
  still runs on the PR.

## Failures and root causes
- (none)

## Handoff — needs human
1. Review the branch; merge when CI is green. No schema change, no
   env change. Medium risk.
2. After deploy: verify in prod by resubmitting an existing e2e-test
   customer with mangled name and confirming the row stays intact.
