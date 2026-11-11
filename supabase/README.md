# Supabase setup — P0

Two files to apply, three env vars to set. Everything after this is my job.

## 1. Create the project (your part, ~2 min)

1. https://supabase.com → **New project**
2. Name: `the-pretzel-cup`
3. Database password: generate, save in 1Password (I never need it)
4. Region: **East US (N. Virginia)** — matches Upstash + Vercel us-east
5. Pricing: **Free**
6. Click **Create new project**, wait ~1 min for provisioning

## 2. Run the SQL (your part, 30 sec)

Supabase dashboard → **SQL Editor** → **New query**:

1. Paste the entire contents of [`schema.sql`](schema.sql) → **Run**. Expect no errors.
2. New query again. Paste [`seed.sql`](seed.sql) → **Run**. Expect "Success. No rows returned" or similar.

Verify in **Table Editor** that `people` has 9 rows, `routes` has 3, `stops` has 33 (31 active + 2 dead).

## 3. Grab the keys (your part, 30 sec)

Dashboard → **Settings → API**. You'll see three things, I need all three:

| What | Where it shows | What it's for |
|---|---|---|
| **Project URL** | "Project URL" at the top | `SUPABASE_URL` |
| **anon public** key | under "Project API keys" | `SUPABASE_ANON_KEY` (safe to expose, we don't use it in the browser anyway) |
| **service_role** key | same section, click "Reveal" | `SUPABASE_SERVICE_ROLE_KEY` — **secret, never put in client code** |

Paste all three into chat. I'll handle `vercel env add` from there.

## 4. What's in the DB after seed

- **People:** Mike (operator), Vic/Marcos/Tony (bakers), Eric/Gary/Reetu/Julianna/Brandon (drivers)
- **PIN:** everyone starts at **0000**. Mike should rotate each PIN after the login UI ships in P1. Until then, update via SQL:
  ```sql
  update public.people set pin_hash = crypt('1234', gen_salt('bf', 10)) where name = 'Vic';
  ```
- **Routes & shifts** matching the structure you described
- **33 stops** across FSQ (9), LYN (13 + 2 dead), FBW (9) with real drop counts

## 5. What's not here yet (next phases)

- Sign-in UI (`/signin`), role-routed landing → P1
- `/baker` and `/driver` pages → P2 and P3
- Operator additions on `/ops` → P4
- Telegram + Google Sheet → P5 and P6

## 6. The ledger (p23)

`ledger_event` is the append-only system of record for every
economically significant action a member takes. Balances are always
`SUM(amount)` via the `member_balance` view — there is no mutable
balance column, no cache to go stale. Writes come from
`api/_lib/members.js`, which is invoked as a side-effect at the end of
`api/_packs.js` handlers (pack opens, verifies, honor taps, redeems)
and swallows its own errors so a ledger outage never costs a customer
their voucher. Economy amounts live in the declarative `earn_rule` and
`spend_rule` tables; edit by SQL (`update earn_rule set amount = …
where slug = …`) — no code change needed.
