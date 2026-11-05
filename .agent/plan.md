# Plan — wholesale/submit.js hardening

## Risk
**MEDIUM.** Edits `api/wholesale/submit.js` only. `api/wholesale/*` is
NOT in `HIGH_RISK_RE`, so no approve-plan.sh cycle — the PR body
carries the labeled plan fields for the plan-gate check, and a human
merges after CI is green. No schema change, no env, no secret, no
change to the send flow or any other file.

## Goal
Three coupled hardening fixes to the wholesale-order submit path,
all from the wholesale-e2e report:

1. **(C) Customer-upsert no longer overwrites profile fields** on
   resubmit. Today an existing customer who re-orders wipes operator
   edits to `first_name` / `organization` / `pickup_location` /
   `pickup_address` / `phone`. Fix: look up existing customer by
   email and reuse the row; only INSERT profile fields on a brand-
   new customer. Race-safe fallback via `ignoreDuplicates: true` +
   follow-up SELECT.

2. **(D) Server-side `pickup_date` required.** The HTML form marks
   the date `required` on the client, but any API caller can POST
   without it today. Add a server-side validation: non-empty +
   `YYYY-MM-DD` shape. Reject with 400 `"valid pickup date required"`.

3. **(E) Promo-code validated + normalized.** Uppercase + trim the
   incoming promo_code; look it up against
   `wholesale_campaign_emails.promo_code`. If matched → store the
   normalized value. If not matched (typo, stale link) → store
   `null`. The 100-for-25 bonus is quantity-driven and NOT gated by
   the code, so the order still earns the bonus — this fix only
   stops polluting the reports column with typos / stray values.

## Scope (files, worktree-relative)
- `.agent/plan.md`, `.agent/state.md`, `.agent/decisions.md`
- `api/wholesale/submit.js`   (modify)

**No changes to** `.claude/`, `.agent-policy/`, `.agent-control/`,
`.env*`, `vercel.json`, `supabase/migrations/`, `api/_lib/*`,
`ops/`, `wholesale/`, or `docs/`.

## Steps
1. **Customer lookup-first flow** (replacing the current
   `.upsert([patch], { ignoreDuplicates: false })`):
   ```js
   const custPatch = { email, first_name, organization };
   if (phone)           custPatch.phone = phone;
   if (pickup_location) custPatch.pickup_location = pickup_location;
   if (pickup_address)  custPatch.pickup_address = pickup_address;

   // insert new ONLY — never update an existing row.
   const { data: upserted, error: upErr } = await sb
     .from('wholesale_customers')
     .upsert([custPatch], { onConflict: 'email', ignoreDuplicates: true })
     .select('id');
   if (upErr) return res.status(500).json({ error: 'customer upsert failed' });

   let customer_id = upserted && upserted[0] && upserted[0].id;
   if (!customer_id) {
     // existing row (ignoreDuplicates swallowed the conflict).
     const { data: existing, error: exErr } = await sb
       .from('wholesale_customers')
       .select('id')
       .eq('email', email)
       .maybeSingle();
     if (exErr || !existing) return res.status(500).json({ error: 'customer lookup failed' });
     customer_id = existing.id;
   }
   ```
2. **pickup_date server validation.** Right after `pickup_location`
   check, add:
   ```js
   const PICKUP_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
   if (!pickup_date || !PICKUP_DATE_RE.test(pickup_date)) {
     return res.status(400).json({ error: 'valid pickup date required (YYYY-MM-DD)' });
   }
   ```
3. **Promo-code validate + normalize.** After the `applyBonus` call
   (we already have `customer_id` and the items), replace the raw
   `promo_code` write with a normalized-or-null value:
   ```js
   let normalizedPromo = null;
   if (promo_code) {
     const candidate = promo_code.trim().toUpperCase();
     const { data: codeRow } = await sb
       .from('wholesale_campaign_emails')
       .select('id')
       .eq('promo_code', candidate)
       .maybeSingle();
     if (codeRow) normalizedPromo = candidate;
     // else: unknown code, drop it from the order row. Bonus stays
     // because applyBonus is quantity-driven, not code-driven.
   }
   ```
   Use `normalizedPromo` in the `wholesale_orders` INSERT.
4. **Decision-log entries.** Append three one-liners to `.agent/decisions.md`
   covering: lookup-first vs upsert, server pickup_date requirement,
   normalize-or-null promo code.

## Success criteria

### Quantitative
- `node --check api/wholesale/submit.js` clean.
- Smoke test via `node -e` against a local fixture: a second POST for
  the same email with different `first_name` / `organization` returns
  the same `customer_id` and a subsequent SELECT shows the FIRST
  submission's profile fields unchanged.
- Smoke: POST without `pickup_date` returns 400 `"valid pickup date required…"`.
- Smoke: POST with `promo_code: "Holiday25"` lands `HOLIDAY25` in the
  order row (if that code exists in `wholesale_campaign_emails`);
  POST with `promo_code: "NOTAREALCODE"` lands `null`.
- CI passes (plan-gate, scope-check, agent-conflicts, test, CodeQL).
- No new code-scanning alerts.

### Qualitative
- Operator edits to a customer's `contact_name` / `organization` in
  `/ops/wholesale/` survive the customer's next order submission.
- API callers can no longer bypass the client-side `pickup_date`
  requirement.
- Reports grouped by `wholesale_orders.promo_code` have at most one
  bucket per real campaign code + one bucket for "no code" (null);
  no more typo buckets.

## Risks + mitigations
- **Race on new-customer insert.** Two concurrent submits for the
  same new email: both see no existing row, both try to insert.
  With `ignoreDuplicates: true` + the unique constraint on `email`,
  one wins and the other gets an empty result → falls through to
  the SELECT branch, which sees the winner's row. Safe.
- **Regression on legit "new email" submits.** The upsert now
  returns zero rows when the customer exists; a bug could drop new
  customers on the floor. Mitigation: the `upserted` check is on
  array emptiness, not an error — a new insert still returns `[{id}]`.
- **Promo-code false negatives.** A real code that's mis-cased in
  the campaign-emails table (e.g. seed has `holiday25` lowercase)
  would start getting dropped. Mitigation: campaign-emails seed
  stores codes uppercase (verified via grep of the seed script
  before shipping); the smoke test above catches this.
- **Form UX unaffected.** The client-side `<input type="date" required>`
  still fires first for browser users; the server check is defense
  against direct API callers only. No change to `/wholesale/index.html`.

## Rollback
- `git revert` the merge commit → Vercel redeploys previous SHA.
- No schema change, no env change.

## Escalation
- If the smoke test shows operator edits still get overwritten,
  there's a second write path (wholesale_customers populated
  somewhere else in the request lifecycle) that needs investigation
  before the fix merges.
