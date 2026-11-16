# Plan: QR CRM redesign (slice 1)

Branch: `agent/qr-crm-redesign`
Risk: **Medium**. Paths are `ops/qr/index.html` (operator-only UI, session-gated) and `api/_packs.js` (session-gated endpoints). Neither is in HIGH_RISK_RE (`api/_lib/`, `api/telegram-webhook.js`, `supabase/migrations/`, `vercel.json`). No schema change, no new dependency, no deploy/auth/secret change. The new leads endpoint returns unmasked customer emails to the authenticated operator — a privacy concern addressed by the existing session gate, not a risk upgrade.
Scope: `ops/qr/` `api/_packs.js`

## Goal
Replace the current `/ops/qr` admin panel with a three-tab CRM page an operator can actually use on day 1: **Today** (scoreboard + funnel + live leads), **Contacts** (searchable, exportable), **Settings** (existing config folded underneath). No new data model — only read what we already collect.

## Steps

1. **Add three read endpoints to `api/_packs.js`**, operator-session-gated, folded under the existing `?resource=packs&view=…` router.
   - `view=funnel` → `{scan_count, pack_openings:{p1,p2,p3,p4}, verify_count, complete_count, redeem_count, window, as_of}` for the last 24h in America/New_York.
     - `scan_count` = sum of fields in Upstash `qr:scans:<YYYY-MM-DD>`.
     - `pack_openings` = counts of `ledger_event` rows with reasons `pack_opened_<src>` (p1..p4) in the 24h window.
     - `verify_count` = `pack_players` where `email_verified_at` is within the window.
     - `complete_count` = `pack_games` where `completed_all=true` and `ended_at` is within the window.
     - `redeem_count` = `pack_vouchers` where `redeemed_at` is within the window.
     - 60-second in-memory cache keyed by the NY date, so poll traffic doesn't hammer Supabase.
   - `view=leads` → paginated list with **unmasked email**, verified timestamp, completion flag, voucher code + status + redemption store, Instagram-tap flag, share flag, created-at. Query params: `q` (email substring, case-insensitive), `filter` in `{all, today, completed, ticket_outstanding, redeemed}`, `limit` (default 50, max 200), `offset` (default 0). Returns `{rows, total, as_of}`.
   - `view=export.csv` → same filter+query as `view=leads`, no pagination, streams CSV with header row, hard cap 10k rows (429 above that). Headers: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="leads-<YYYY-MM-DD>-<filter>.csv"`.

2. **Remove the `maskEmail` call in `view=completed_list`** so the operator view stops masking. The helper stays defined; only the operator-facing use is removed.

3. **Rewrite `ops/qr/index.html` to the three-tab layout from the approved mockup.**
   - Tab bar: Today (default) · Contacts · Settings.
   - Top status strip preserved (Edge Config connectivity + offer summary) and gains a "Live · N scanning" pulsing pill fed by a 15 s poll of `view=stats`.
   - **Today:** four KPI tiles (Scans / Verified / Completed / Redeemed) with vs-yesterday deltas; eight-step funnel (Scan → Pack1 → Pack2 → Verify → Pack3 → Pack4 → Complete → Redeem) with step-over-step conversion %; live leads feed showing the last 20 captures.
   - **Contacts:** search box, filter chips (All / Today / Completed / Ticket outstanding / Redeemed), table with Name (first name from email local-part), Email, Status, Voucher, Opt-in source (hardcoded `pack2_verify` until slice 2 lands the consent-metadata migration), Created. "Download CSV" button hits `view=export.csv`.
   - **Settings:** every current QR + Referral config panel (target, offer, placements, printables, referral config) moves here, grouped and collapsed by default. Every existing POST action stays wired.
   - Brand system preserved: `#0D5237` green, `#000000` black, gold `#D4B662 / #B2872F / #F2E7A4`, FatFrank / Archivo Black for display, Montserrat for body, square corners, no shadows. No new fonts.

4. **Keep every existing flow wired.** Every POST action the old page hits, the new page still hits. Every GET view the old page reads, the new page reads — plus the three new views.

5. **Validate.**
   - Boot `vercel dev` and walk the three tabs on desktop and 400px width.
   - Confirm Today renders with real Redis + Supabase numbers.
   - Confirm CSV download returns a non-empty file with the expected header row.
   - Confirm every Settings action still works (save target, publish offer, generate QR codes).
   - Confirm masked emails are gone from `view=completed_list`.
   - `scripts/agent/eval-report.sh` for the record.

6. **Propose.** Push `agent/qr-crm-redesign`; open a draft PR with the template filled in. Human merges.

## Success criteria

Quantitative:
- Files changed: `ops/qr/index.html`, `api/_packs.js`. Nothing else.
- No new dependency in `package.json`; no change to lockfile.
- No change to `.claude/*`, `.agent-policy/*`, `.agent-control/*` (beyond fixing stale scope if the human regenerates it), `.github/*`, `supabase/migrations/*`, `vercel.json`, `api/_lib/*`.
- Existing operator POST actions return 200 after the rewrite (manual walkthrough).
- `?resource=packs&view=export.csv` emits `Content-Type: text/csv; charset=utf-8` and a `Content-Disposition` attachment header.
- `view=leads` returns `rows.length <= limit` and `total` as a whole number.
- `scope-check` CI passes; `plan-gate` passes (medium risk, no high-risk paths touched).

Qualitative:
- An operator who has never seen this page can, within 30 seconds, tell you: (a) how many scans happened today, (b) how many became verified leads, (c) which step is the biggest drop-off, (d) the last five emails captured. If any of those takes longer, the redesign has failed.
- The live page and the approved mockup look substantively the same, modulo real data in place of placeholders.

## Risks and mitigations

- *Funnel endpoint over-queries Supabase and slows the page.* Mitigation: one SELECT with `COUNT(*) FILTER` per bucket, not six round trips; 60-second in-memory cache keyed by the NY date.
- *Scan count from Upstash lags the funnel numbers from Supabase.* Mitigation: label the Scans tile `as of HH:MM ET` and include `as_of` in the response; perfect sync is not possible and not needed.
- *CSV export leaks unverified emails.* Mitigation: default filter in the UI is a verified-only one (`completed` / `redeemed`); the active filter appears in the downloaded filename.
- *Rewriting the single-page JS silently breaks a save flow.* Mitigation: before merge, diff the list of `fetch(...)` calls in the old file against the new file; every POST the old page sent, the new page sends.
- *First render hits all three backends and feels slow.* Mitigation: render the shell + tabs immediately; lazy-fetch each tab's data; KPI tiles render with skeletons replaced in place.

## Rollback
- `git revert` the single merge commit; the old page returns. No data moves.
- Nothing deploys from this branch (deploys are human-only per policy).

## Out of scope (explicitly)
- Consent-metadata migration on `pack_players`. **Slice 2** — high-risk, plan-approval gate.
- `/privacy.html` page + checkbox removal from `/free-pretzels`. **Slice 2**.
- Daily Telegram digest. **Slice 3**.
- Any change to CAN-SPAM copy, unsubscribe mechanism, or email sending. Not sending email yet.
- Per-store attribution. Totals only for now.

## Review-by
2027-02-16 (3 months). Revisit whether the funnel definition still matches how packs are launched.
