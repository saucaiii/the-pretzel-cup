# Plan: referral-CRM + loyalty-ledger foundation (member, referral_code, ledger_event, earn_rule, spend_rule)

Branch: `agent/referral-crm-foundation`
Risk: **High** (adds a new `supabase/migrations/pNN_*.sql` file and edits the game backend; `supabase/migrations/` and `api/_lib/` are both in the policy's `HIGH_RISK_RE`)
Scope: `supabase/migrations/p23_ledger_foundation.sql, api/_lib/members.js, api/_packs.js, supabase/README.md`

## Goal

Product goal. Pretzel Cup is building its own referral-CRM + loyalty stack rather than wiring up Friendbuy, Rewardful, Smile.io, Yotpo L&R, Mention Me, or Talon.One. The `/free-pretzels` pack game is the acquisition funnel UX and will stay as-is; the future games suite (buy pretzels → earn currency → spend currency on games → win voucher) will sit on top of the same layer. This plan ships only the data substrate and its first-write hook, so later product work can be built without a schema migration every time.

Architectural goal. Lay down an append-only ledger (`ledger_event`) anchored to a stable `member` row keyed on verified email, with a unique `referral_code` per member and declarative `earn_rule` / `spend_rule` tables that later product code reads instead of hard-coding amounts. The existing `pack_players` / `pack_vouchers` / `pack_games` rows stay untouched; the ledger is a parallel mirror of economically significant events, written as a side-effect at the end of the existing pack-game handlers. Balances are always `SUM(amount)` over the ledger — no mutable balance column, no cache to go stale.

## Data model

### New tables

`public.member`. One row per person. Verified email is the natural key when present; `id` is the FK target everywhere else because pack-game events fire before verify.
```
id                uuid primary key default gen_random_uuid()
email             citext unique
email_verified_at timestamptz
display_name      text
pack_player_id    uuid unique references public.pack_players(id) on delete set null
referred_by       uuid references public.member(id) on delete set null
joined_source     text not null default 'pack_game'
                    check (joined_source in ('pack_game','pitch_kit','wholesale','manual','referral'))
created_at        timestamptz not null default now()
check ((email is null) = (email_verified_at is null))
check (email is null or email = lower(email::text)::citext)
```
Indexes: `member_referred_by_idx` on `(referred_by)` where not null; the `email` and `pack_player_id` columns are already unique. `pack_player_id` is nullable so a wholesale customer or a lead can become a member before (or without) ever opening a pack. `referred_by` is nullable (default null) and set only when the referred member verifies through a code; self-referral is blocked at write time in the helper, not at the CHECK level (an operator-created record may legitimately reference itself).

`public.referral_code`. One row per member.
```
id          uuid primary key default gen_random_uuid()
member_id   uuid not null unique references public.member(id) on delete cascade
code        text not null unique check (code ~ '^[A-Z0-9]{6,10}$')
created_at  timestamptz not null default now()
revoked_at  timestamptz
```
`code` reuses the ASCII-safe alphabet pattern already in `api/_packs.js` (no 0/O/1/I/L). `revoked_at` is nullable; a non-null value means the code no longer attributes new referrals but historical `referred_by` pointers stay valid. `member_id` is unique so one member cannot hold two live codes.

`public.ledger_event`. Append-only.
```
id             uuid primary key default gen_random_uuid()
member_id      uuid not null references public.member(id) on delete restrict
event_type     ledger_event_type not null
currency       ledger_currency not null
amount         integer not null
reason         text not null check (char_length(reason) between 3 and 60)
ref            text not null check (char_length(ref) between 1 and 120)
reverses_id    uuid references public.ledger_event(id) on delete restrict
metadata       jsonb not null default '{}'::jsonb
occurred_at    timestamptz not null default now()
created_at     timestamptz not null default now()
check (
  (event_type in ('earned','granted') and amount > 0) or
  (event_type in ('spent','expired')  and amount < 0) or
  (event_type = 'reversed'            and reverses_id is not null)
)
check ((event_type = 'reversed') = (reverses_id is not null))
```
Signed `amount` is the clean form — `SUM(amount)` is the balance, no CASE in the view. `on delete restrict` on `member_id` is deliberate: deleting a member must first zero out and archive their ledger. `reverses_id` on a `reversed` row stores the negation of the row it points to, so the sum still collapses to zero after a reversal.

Indexes:
- `ledger_event_member_currency_idx` on `(member_id, currency)` — the balance view's group key.
- `ledger_event_reason_ref_uq` as a **UNIQUE** index on `(member_id, reason, ref)` — this is the idempotency guarantee. Same reason + same external ref from the same member can only land once; a retry of `handleOpen` or `handleVerify` is a no-op at the storage layer.
- `ledger_event_occurred_idx` on `(occurred_at desc)` — operator queries ("conversions last week").

`public.earn_rule`. Declarative; seeded by this migration, edited later by SQL.
```
id             uuid primary key default gen_random_uuid()
slug           text not null unique check (slug ~ '^[a-z][a-z0-9_]{2,40}$')
event_source   text not null check (event_source in ('pack_game','referral','wholesale','games_suite','manual'))
currency       ledger_currency not null
amount         integer not null check (amount >= 0)
active         boolean not null default true
notes          text
created_at     timestamptz not null default now()
```

`public.spend_rule`. Declarative; seeded with placeholders for the games suite.
```
id              uuid primary key default gen_random_uuid()
slug            text not null unique check (slug ~ '^[a-z][a-z0-9_]{2,40}$')
event_source    text not null check (event_source in ('games_suite','redemption','manual'))
cost_currency   ledger_currency not null
cost_amount     integer not null check (cost_amount > 0)
grants_currency ledger_currency
grants_amount   integer check (grants_amount is null or grants_amount > 0)
active          boolean not null default true
notes           text
created_at      timestamptz not null default now()
check ((grants_currency is null) = (grants_amount is null))
```

RLS: every new table is `enable row level security` with no policies, matching the deny-all pattern used by `pack_players`, `leads`, and the wholesale tables. All reads and writes go through the service-role key.

### New enums

`ledger_event_type` — `earned`, `granted`, `spent`, `expired`, `reversed`. Used by `ledger_event.event_type`.

`ledger_currency` — `points`, `pretzel_voucher`, `golden_ticket`. Used by `ledger_event.currency`, `earn_rule.currency`, `spend_rule.cost_currency`, and `spend_rule.grants_currency`. `points` is the in-game currency the games suite will spend; `pretzel_voucher` and `golden_ticket` mirror the existing `pack_vouchers` rows so the ledger reconciles 1:1 against the pack-game table.

### Views

```
create or replace view public.member_balance as
  select member_id, currency, sum(amount)::bigint as balance
    from public.ledger_event
   group by member_id, currency;
```
A view beats a cached column here because the ledger is append-only and small (one row per economic event, not per view/scroll); the view is always correct by construction, there is nothing to invalidate, and if this ever gets hot a materialised view can replace it without changing any call site.

## Rules tables and seed data

The migration ships the following `earn_rule` rows. Amounts are **placeholders** — the human sets the real economy by `update earn_rule set amount = … where slug = …` after merge.

| slug                     | event_source | currency       | amount |
|--------------------------|--------------|----------------|--------|
| pack_opened_first        | pack_game    | points         | 10     |
| pack_opened_instagram    | pack_game    | points         | 10     |
| pack_opened_email        | pack_game    | points         | 10     |
| pack_opened_share        | pack_game    | points         | 10     |
| pack_opened_bonus        | pack_game    | points         | 50     |
| pretzel_voucher_granted  | pack_game    | pretzel_voucher| 1      |
| golden_ticket_granted    | pack_game    | golden_ticket  | 1      |
| email_verified           | pack_game    | points         | 20     |
| instagram_tap            | pack_game    | points         | 5      |
| share_tap                | pack_game    | points         | 5      |
| referral_converted       | referral     | points         | 100    |
| wholesale_order_paid     | wholesale    | points         | 1      |

`pretzel_voucher_granted` and `golden_ticket_granted` are the currency-mirror rules — their `amount` is the voucher count granted per pack-game open, not a points value. This is how the ledger stays in sync with `pack_vouchers` without a background job.

The migration seeds the following `spend_rule` rows as placeholders for the games suite (not yet wired by any handler):

| slug                   | event_source | cost_currency   | cost_amount | grants_currency | grants_amount |
|------------------------|--------------|-----------------|-------------|-----------------|---------------|
| play_mini_game         | games_suite  | points          | 20          | pretzel_voucher | 1             |
| voucher_redemption     | redemption   | pretzel_voucher | 1           | (null)          | (null)        |
| golden_ticket_redeemed | redemption   | golden_ticket   | 1           | (null)          | (null)        |

## API wiring

A new read helper `api/_lib/members.js` exports two functions:
- `ensureMember(sb, { packPlayerId, email })` — upsert a `member` row for a `pack_players.id`, returning the member id. Creates `referral_code` on first write. Never updates `email`: the verify path calls a sibling `linkMemberEmail(sb, memberId, email)` that both populates `email`/`email_verified_at` and handles the pack-player-merge case (owner's existing member wins).
- `writeLedgerEvent(sb, { memberId, slug, ref, metadata })` — looks up the `earn_rule` or `spend_rule` by slug, computes the signed `amount` for the type, and inserts. On the unique-violation of `(member_id, reason, ref)` it swallows the error and returns `{ deduped: true }`. Never throws for business reasons; only throws if the DB is down.

Every call below writes **at the end of the existing happy path**, after the pack-game write has already succeeded. If the ledger write throws, it is logged and swallowed (same posture as `touchGame` already has in `handleOpen`) so a ledger outage never costs a customer their voucher.

| Handler | Trigger | Ledger writes |
|---|---|---|
| `handleOpen` (pretzel sources: `first`, `instagram`, `email`, `share`) | `insertVoucher` returned `{ ok, voucher }` | `earned points` via slug `pack_opened_<source>`, `reason='pack_opened_<source>'`, `ref=voucher.id`; then `granted pretzel_voucher` via slug `pretzel_voucher_granted`, `reason='pretzel_voucher_granted'`, `ref=voucher.id` |
| `handleOpen` (source `bonus`) | Golden Ticket row inserted | `earned points` via slug `pack_opened_bonus`, `ref=voucher.id`; then `granted golden_ticket` via slug `golden_ticket_granted`, `ref=voucher.id` |
| `handleVerify` | `finalId` resolved, `email_verified_at` set for the first time (detected by the pre-update read showing it null) | `earned points` via slug `email_verified`, `reason='email_verified'`, `ref='verify:' + player.id + ':' + offer_key`; if `member.referred_by` is set and this is the first conversion event for this member, write `earned points` for the referrer via slug `referral_converted`, `reason='referral_converted'`, `ref='convert:' + member.id` |
| `handleHonor('instagram')` | `instagram_at` just set (i.e. was previously null) | `earned points` via slug `instagram_tap`, `reason='instagram_tap'`, `ref=player.id + ':' + offer_key` |
| `handleHonor('share')` | `share_at` just set | `earned points` via slug `share_tap`, `ref=player.id + ':' + offer_key` |
| `handleStop` | `endGame('stopped_at_3')` returned a row | **No ledger write.** Stopping is lifecycle, not economy — recorded in `pack_games`. Documented in the handler comment. |
| `handleRedeem` | `burnVoucher` returned a row | `spent pretzel_voucher` via slug `voucher_redemption`, `reason='voucher_redemption'`, `ref=voucher.id` (for pretzel sources); or `spent golden_ticket` via `golden_ticket_redeemed`, `ref=voucher.id` (for bonus). For a Golden Ticket, the `burnPretzels` call already in place cascades: for each returned voucher id, write a `spent pretzel_voucher` with `ref=<that voucher id>`. |

The `reason + ref` composite is the idempotency anchor. Because `ref` is a UUID (voucher id) or a stable composite (`player.id + offer_key` for honor taps, `verify:…`), a retry — a Vercel invocation retry, a duplicate tap racing the first — hits the unique index, the helper returns `{ deduped: true }`, and the handler proceeds exactly as today. No existing writes are removed or altered; the ledger write is strictly additive.

## Idempotency and fraud model

The unique index `(member_id, reason, ref)` on `ledger_event` is the single source of dedup. Every handler listed above computes a `ref` that is stable for the same economic event: the pack voucher's UUID for pack opens and redemptions, `verify:<player>:<offer>` for email verification (which `pack_magic_links.used_at` already single-uses), and `<player>:<offer>` for Instagram and share taps (where `pack_players.instagram_at` / `share_at` already enforce once-per-player at the pack layer). The ledger helper swallows the 23505 and returns a deduped flag; callers log the dedup but do not escalate.

"Reward on redemption, not on signup" is preserved. The ledger does **not** credit `email_verified` points speculatively at magic-link request time; the credit lands only after the token is consumed, the player row is updated, and the merge is resolved. Referral credit lands only on the referred member's first verified email — not on code-share, not on first visit, not on the referred member opening a pack. Both events have a strict ordering: ledger write runs after the state change it describes.

Fraud posture, built now: the existing IP-salt (`LEAD_IP_SALT`), per-IP sliding-window rate limits in `api/_packs.js`, per-email rate limits on magic-link requests, honeypot on `/apply`, and now the ledger unique index that stops duplicate credit on retry or replay. Deferred: device fingerprinting, velocity scoring across member graph (parent-of-referrer-of-referrer ring detection), chargeback-style reversal flows (the `reversed` event type is in the schema but no handler writes one yet), and per-member daily earn caps. The games-suite work will need these; this plan does not.

## Migrations

One new file: `supabase/migrations/p23_ledger_foundation.sql` (p22 is the last existing migration). Wrapped in a single `begin; … commit;` transaction so a mid-file failure leaves nothing partial. DDL order inside the file, each step `if not exists` / `do $$ … exception when duplicate_object` for idempotent re-run on dev:

1. `create extension if not exists pgcrypto;` and `create extension if not exists citext;` (both are already enabled by `p14_wholesale.sql` but declared again defensively).
2. `create type ledger_event_type as enum (…)` and `create type ledger_currency as enum (…)`, guarded by the `do $$ … duplicate_object` pattern used in `p14_wholesale.sql`.
3. `create table public.member (…)` with its CHECKs and indexes.
4. `create table public.referral_code (…)`.
5. `create table public.ledger_event (…)`, then the three indexes including the unique `(member_id, reason, ref)` one.
6. `create table public.earn_rule (…)` and `create table public.spend_rule (…)`.
7. `create or replace view public.member_balance as …`.
8. `alter table … enable row level security` on all five new tables. No policies.
9. `insert into public.earn_rule (slug, event_source, currency, amount, notes) values …` and the same for `spend_rule`, both with `on conflict (slug) do nothing` so re-runs on dev are safe.

The migration adds **no new columns** to `pack_players`, `pack_vouchers`, `pack_games`, `pack_magic_links`, or `leads`. The existing pack tables and the leads table stay byte-for-byte identical; wiring to them lives in `api/_lib/members.js` and the edits to `api/_packs.js`.

A trailing commented-out rollback block mirrors the one in `p11_pretzel_packs_bonus.sql`: the exact `drop view / drop table / drop type` sequence to undo the migration, with a `select count(*) from public.ledger_event` guard the operator is told to run first. The `drop table` order is: `ledger_event`, `spend_rule`, `earn_rule`, `referral_code`, `member`; then `drop view member_balance`; then `drop type ledger_currency`, `drop type ledger_event_type`. All DDL in this migration is reversible as long as no third-party code has started reading the ledger — which it will not, in this PR.

`supabase/README.md` gets a single new paragraph documenting the ledger (what it is, why no cached balance, who writes). No other repo doc is touched.

## Success criteria

Quantitative.
- Migration applies cleanly against a fresh Supabase (operator runs it by hand, as the migration headers already specify).
- Re-running the migration against a database that already has it is a no-op (the `if not exists`, `do $$ … duplicate_object` and `on conflict do nothing` guards hold).
- The project's scope-check passes: only the four files listed in Scope are modified.
- Fixture test: given a scripted session that opens all 4 pretzel packs, verifies email, taps Instagram, taps share, opens the Golden Ticket, and redeems the ticket at the counter, `select sum(amount) from ledger_event where member_id = … and currency = 'pretzel_voucher'` returns `0` (4 granted + 4 spent-via-ticket − 0 net), and `select count(*) from ledger_event` returns exactly `(4 pack opens × 2 writes) + 1 bonus points + 1 bonus grant + 1 email_verified + 1 instagram_tap + 1 share_tap + 1 golden_ticket_redeemed + 4 pretzel-voucher-spends-via-ticket = 18` rows.
- Every handler listed in the API wiring table writes exactly **one** ledger event per economic action per retry: a duplicate POST to `handleOpen` with the same player/source does not produce a second points row.
- The existing pack-game suite still works unchanged: every test in the current `_packs.js` fixture set passes with the ledger write in place (the repo has no unit tests committed today, so the operator confirms this by walking through the `/free-pretzels` flow in a preview deploy).

Qualitative.
- An operator can answer "how many referral conversions last week" with one SQL query: `select count(*) from ledger_event where reason = 'referral_converted' and occurred_at >= now() - interval '7 days';`.
- An operator can edit the pack-game economy without a code change: `update earn_rule set amount = 25 where slug = 'pack_opened_first';` takes effect on the next `handleOpen`.
- The ledger is the obvious place to add the next earn/spend surface. When the games suite ships, it reads `spend_rule` by slug, debits `points`, and grants `pretzel_voucher`; no further schema change is required.

## Risks + mitigations

Double-write races. Two near-simultaneous retries of the same handler could both reach the ledger insert. The `(member_id, reason, ref)` unique index makes the second one fail at the DB with 23505; the helper catches and returns `deduped=true`. No application-level lock needed.

Migration-rollback path. Because the pack tables are untouched, rolling back this PR is `drop view member_balance; drop table ledger_event, spend_rule, earn_rule, referral_code, member; drop type ledger_currency, ledger_event_type;` plus `git revert`. The rollback block is committed in the migration file alongside the forward DDL. No `pack_*` data is harmed.

Pack-game regression surface. The ledger write is inside hot paths that today serve every pack opener. Mitigation: the ledger helper swallows its own errors (same posture as `touchGame` in `handleOpen`), the DB write is a single `INSERT` with no joins, the unique index is covered by `(member_id, reason, ref)` which is selective enough that writes stay sub-millisecond, and the `on delete restrict` on `member_id` cannot be hit during normal operation. A code review step before merge compares the diff of `api/_packs.js` to confirm no existing write was removed or reordered.

Fraud-model deferrals. Device fingerprinting, velocity scoring, and per-member daily caps are not in this PR. Risk: a determined attacker with multiple emails could earn referral credit at scale. Mitigation now: points have no cash value until the games suite spends them, which is a later and separately plannable PR; the human gate on the games-suite plan is the right place to require the fraud model before any pretzel can be won by paid-currency.

Referrer-pays-attacker pattern. If `member.referred_by` is set by a URL parameter the attacker can inject, they can credit themselves by self-referring. Mitigation: the helper rejects `referred_by == member.id`, and the attribution-setting code (not in this PR) must only trust a `referred_by` captured on first-ever visit before the referring member exists — enforced in the follow-up plan.

Email as `citext` on `member` vs `text` on `pack_players`. `pack_players.email` uses `text` with a lowercase CHECK; `member.email` uses `citext`. Both canonicalise to the same lowercased value, so a FK-less linkage by email is unambiguous. Flagged so a reviewer does not read this as a bug.

## Rollback / escalation

Revert path:
1. `git revert <merge commit>` on `main`; redeploy with `npm run deploy`.
2. In Supabase SQL editor, run (in this order): `drop view if exists public.member_balance;` then `drop table if exists public.ledger_event;` then `drop table if exists public.spend_rule;` then `drop table if exists public.earn_rule;` then `drop table if exists public.referral_code;` then `drop table if exists public.member;` then `drop type if exists public.ledger_currency;` then `drop type if exists public.ledger_event_type;`.
3. The pack-game tables are untouched by this plan; no pack-game rollback is required.

Escalate to a human if: the `ledger_event_reason_ref_uq` index creation fails on the live DB (indicates a seed data collision no one caught), the `supabaseStore` helpers in `api/_packs.js` are refactored by another agent concurrently (the Agent Conflicts workflow should catch this), or any new failure mode in `/free-pretzels` appears in Vercel logs within 24 hours of deploy.

## Approval checklist (for the human)

- Widen the human-owned scope file to include the four paths listed in Scope at the top of this plan: `supabase/migrations/p23_ledger_foundation.sql`, `api/_lib/members.js`, `api/_packs.js`, `supabase/README.md`.
- Read this plan end-to-end.
- Run the `approve-plan.sh` helper under `scripts/agent/` — it records the plan's SHA in the human-owned approval record and unlocks the HIGH-risk edits for the next implementer run. Any later edit to this file voids the approval.
- After implementation, the migration is applied by hand in Supabase (the pattern already in use for `p10`…`p22`); the code owner reviews the PR before merge.

## Discovery notes

- `pack_players.email` is `text` with a lowercase CHECK, not `citext`. `wholesale_customers.email` is `citext`. I spec `member.email` as `citext` to match the wholesale table and to make case-insensitive joins possible across the three sources (pack, wholesale, leads). Flagged because it is a deliberate inconsistency with `pack_players`.
- `public.people` (in `supabase/schema.sql`) is the employee table used by `leads.handled_by`. It is **not** the right table for the new `member`; `member` is a customer-facing record. Named here only to prevent future confusion.
- `leads.source` already accepts `'referral'` as a value but there is currently no column or helper that populates it from a code; the referral attribution flow (URL `?ref=…` → cookie → verify → set `member.referred_by`) is **out of scope** for this plan and will need its own. The `referral_converted` earn rule is seeded now so the follow-up plan can wire attribution without another migration.
- The share hook (`handleHonor('share')`) today still accepts the legacy `app` action alias and reads `pack_players.app_at` through `withLegacy`. The ledger write for share uses `reason='share_tap'` regardless of which alias triggered the handler, so legacy taps and new taps share one idempotency key.
- `api/_lib/` already contains `auth.js`, `gmail.js`, `invoice-pdf.js`, `invoice-template.js`, `md.js`, `promo.js`, `sheet.js`, `stripe.js`, `telegram.js`, `updates.js`. Adding `members.js` fits the naming convention and keeps the new helpers out of `api/_packs.js`, which is already 1100+ lines.
- Explicitly out of scope, with a line each on why:
  - Ops UI / dashboard for the ledger — needs operator UX work and admin auth plumbing, which is a separate medium-risk plan.
  - The games suite itself — depends on this foundation existing first; no surface should spend currency until the ledger is in place.
  - Tier / VIP mechanics — product has not decided the tier curve; premature to encode.
  - Rules-engine UI for editing earn/spend rules — SQL is enough while the operator is one person; a UI is only valuable once more people edit rules.
  - Rewards catalog beyond Golden Ticket + free-pretzel — no catalog table yet because nothing in the current game emits a new reward type.
  - Migration of historical pack-game rows into the ledger — the ledger is the system of record for the games suite going forward; backfill is cheap later if needed, and risk-free to skip now.
