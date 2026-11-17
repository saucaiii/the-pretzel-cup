# Plan: slice 2 — consent metadata + /privacy page

Branch: `agent/consent-privacy`
Risk: **High**. Adds a new `supabase/migrations/p24_pack_consent_metadata.sql` (migrations are in HIGH_RISK_RE). The rest of the change is medium or low — a new `/privacy.html`, one removed form field + microcopy swap on `/free-pretzels/index.html`, a two-column select/insert update in `api/_packs.js`, and a one-line display update on `ops/qr/index.html`. Needs human plan-approval before any edits can land.
Scope: `supabase/migrations/` `privacy/` `free-pretzels/` `ops/qr/` `api/_packs.js`

## Goal
Lock down the user-chosen implicit-consent model ("by opening the packs you opt-in; disclosed in the privacy policy") with the audit trail CAN-SPAM wants: for every verified lead, record the moment of consent, the flow it came through, and the version of the privacy policy that was live at the time. Also surface a real `/privacy` page the operator can link from the pack and from the footer. US-only; no GDPR scope.

## Why now
- Slice 1 shipped an operator CRM that lists unmasked emails. Those addresses need a legal basis to send to. CAN-SPAM doesn't require prior opt-in but it does require honest sender identification and the ability to show, per address, what the user agreed to. The current free-pretzels page still has a "deals checkbox" and a 30-day-deletion microcopy that contradict the implicit-consent model the user locked in.
- Slice 1's Contacts tab reads a placeholder `"pack2_verify"` for the Opt-in source column. This slice supplies the real column so that value is no longer a hardcoded string.

## Steps

1. **Migration `supabase/migrations/p24_pack_consent_metadata.sql`** (transaction-wrapped, `if not exists`-guarded, rollback block at the bottom):
   - Add three columns to `pack_players`:
     - `marketing_opt_in_at timestamptz` — set to `email_verified_at` for existing verified rows via a one-shot UPDATE in the same transaction; nullable (unverified rows have no consent moment).
     - `marketing_opt_in_source text` — check constraint `(marketing_opt_in_source in ('pack2_verify','pitch_kit','manual_backfill'))`; default `'pack2_verify'` for the backfill.
     - `marketing_opt_in_version text` — check `char_length between 3 and 60`; default `'privacy_v1_2026-11'` for the backfill.
   - Keep the existing `marketing_opt_in boolean` column for backwards compatibility with any caller still reading it; mark it deprecated in the migration comment. (I will NOT drop it this slice.)
   - Add partial index `idx_pack_players_opt_in` on `(marketing_opt_in_at desc)` where `marketing_opt_in_at is not null` to keep the Contacts tab's upcoming "sort by consent date" query fast.
   - Rollback block (commented) drops the three columns and the index, reversible as long as no downstream reader has started depending on them.

2. **New `/privacy.html`** at the repo root (served statically via Vercel's default `public/` routing — same as `/free-pretzels/index.html`). Content:
   - Plain brand design, matches the style of `/free-pretzels` (green ground, gold accents, FatFrank display, Gotham body).
   - Version slug visible on the page: `privacy_v1_2026-11` (so when the copy changes, we bump the slug and store the new value in `marketing_opt_in_version` for consents captured after the bump).
   - Sections (no legalese for its own sake, written for the actual customer): What we collect (email on pack 2, Instagram tap flag, voucher redemptions), How we use it (send the magic link; keep one set of packs per person; send pretzel news and offers until you unsubscribe), When we delete it, How to opt out (reply to any email with "stop" or email a listed address), Who runs this (PPF Lynbrook + Franklin Square, with the mcaiazzoppffs@gmail.com sender identity already used by the magic-link flow), Last updated `2026-11-17` and `privacy_v1_2026-11`.
   - Noindex meta (same as `/free-pretzels/index.html`'s operator-adjacent pages).

3. **`/free-pretzels/index.html` edits:**
   - Delete the `<label class="check"><input type="checkbox" id="email-optin">…` block at line 529 and any JS reading `#email-optin`.
   - Replace the microcopy at line 530 with implicit-consent language: `"We use your email to send this link and to keep packs to one set per person. By entering it you agree to our privacy policy; you can unsubscribe from any email."` — with "privacy policy" linking to `/privacy`.
   - Add a small `/privacy` link to the page footer (same place the fine print lives).

4. **`api/_packs.js` edits:**
   - `handleVerify`: on the UPDATE that sets `email_verified_at`, also set `marketing_opt_in_at = email_verified_at`, `marketing_opt_in_source = 'pack2_verify'`, `marketing_opt_in_version = 'privacy_v1_2026-11'`. Leave `marketing_opt_in` writing as it is (true), so the deprecated column stays consistent.
   - `queryLeads` select list: add `marketing_opt_in_source`. The mapping stage sets `opt_in_source: pl.marketing_opt_in_source || null` on the row.
   - `createPlayer`: no change — the insert still creates an unverified row with no consent columns set.
   - **Note on `api/_lib/members.js`:** no change needed for slice 2. That file writes ledger rows; it doesn't touch pack_players.marketing_*. Keeping it out keeps the diff off the high-risk `api/_lib/` path and shrinks the review surface.

5. **`ops/qr/index.html` edits:** one line. In the Contacts table rendering, replace the hardcoded `r.email_verified_at ? 'pack2_verify' : '-'` with `r.opt_in_source || (r.email_verified_at ? 'pack2_verify' : '-')`. The fallback keeps old rows (pre-migration) displaying correctly.

6. **Validate:**
   - `npm test` — same baseline (my changes should not regress tests).
   - Local Supabase (if available) or a staging/preview DB: `supabase db push` to apply p24, then verify `select count(*) from pack_players where email_verified_at is not null and marketing_opt_in_at is not null` equals the pre-migration count of verified rows (backfill correct).
   - Boot `vercel dev`, walk pack 2's email step: confirm the checkbox is gone, submit, verify the link, hit `select marketing_opt_in_source, marketing_opt_in_version from pack_players where email = …` and confirm the write landed.
   - Load `/ops/qr#contacts`, confirm the Opt-in source column reads from the new column for new verifies and still shows `pack2_verify` for backfilled rows.
   - Load `/privacy`, confirm it renders and link from `/free-pretzels` works.

7. **Propose:** push `agent/consent-privacy`, open draft PR with the template filled in.

## Success criteria

Quantitative:
- Files changed: `supabase/migrations/p24_pack_consent_metadata.sql` (new), `privacy.html` (new), `free-pretzels/index.html`, `ops/qr/index.html`, `api/_packs.js`. Nothing else.
- No dependency change.
- No touch to `api/_lib/`, `api/telegram-webhook.js`, `.github/`, `.claude/`, `.agent-policy/`, `.agent-control/`, `vercel.json`.
- Post-migration: `select count(*) from pack_players where email_verified_at is not null and (marketing_opt_in_at is null or marketing_opt_in_source is null or marketing_opt_in_version is null)` returns `0`.
- `npm test` same baseline (75 pass / 2 pre-existing fails).
- `scope-check` CI passes; `plan-gate` CI passes (high-risk, with approval hash on this plan).

Qualitative:
- An operator can click a verified email in Contacts and tell instantly that the consent was captured via `pack2_verify` under `privacy_v1_2026-11`.
- The copy a customer sees at pack 2 matches the model we actually run: no deals checkbox, no "30-day delete without the box", one honest sentence that links to a real page.
- If a lawyer or a mail-sending vendor ever asks "where's your consent record", the answer is: the three columns on `pack_players`, cross-referenced against the versioned privacy page in git.

## Risks + mitigations

- *Migration backfills incorrect values.* Mitigation: the UPDATE is bounded by `email_verified_at is not null`; defaults on `marketing_opt_in_source` and `marketing_opt_in_version` are the right values for every backfilled row (there's only one flow and one policy version in effect today).
- *Downstream code reads the deprecated `marketing_opt_in` boolean.* Mitigation: not dropping that column this slice; `handleVerify` still writes `marketing_opt_in: true`. Any caller still reading it keeps working.
- *Privacy copy is legally insufficient.* Mitigation: this is a founder-run business and the user has already decided the model; the page codifies what's already agreed. Future legal review can bump `privacy_v2_*` and the three columns will faithfully record who agreed under which version.
- *Pack 2 form JS still reads `#email-optin`.* Mitigation: step 3's JS sweep removes any such read; the submit handler will send the email without the opt-in flag, and the backend treats the implicit model as opt-in=true.

## Rollback
- `git revert` the merge commit; UI stops reading the new columns. The columns themselves remain on the DB (harmless), and can be dropped via the migration's rollback block if truly needed.
- If the migration itself needs rolling back after merge but before the UI deploys: the rollback block at the bottom of p24 drops the three columns + index in a reversible way.

## Out of scope (next slices / later)
- **Slice 3:** daily Telegram digest of yesterday's funnel numbers via the existing `api/schedule.js` cron and `api/_lib/telegram.js`. Also high-risk because it edits `vercel.json`'s cron list.
- Unsubscribe mechanism (no sends yet — not needed until slice 4).
- Dropping the deprecated `marketing_opt_in` boolean (one release after we're sure nothing reads it).
- Sort/filter Contacts by consent date (fast-path index is here; UI wire is a follow-up).
- Any CAN-SPAM header work on the magic-link email itself (cosmetic — the mcaiazzoppffs@gmail.com sender identity is already honest).

## Review-by
2027-02-17 (3 months). Re-check whether the three columns match whatever consent-recording model we're on then (likely more sources once pitch-kit is folded in).
