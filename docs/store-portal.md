# Store Portal — design doc

A client-facing portal for the 7-Eleven store managers / franchisees that
Pretzel Cup delivers to. Each store signs in and sees its own delivery
history + totals, can report issues, request a drop change, download a
monthly invoice, and tap-to-call/text the operator.

---

## Scope (locked)

| Decision | Choice |
| --- | --- |
| Login unit | **Per-stop.** One login per 7-Eleven location. Franchisees with multiple stores get multiple logins. |
| Auth | **PIN flow.** Same shape as operator/baker/driver (stop picker + 4–6 digit PIN, bcrypt-hashed in Postgres, HS256 app JWT in `ppf_session` cookie). |
| Primary view | **Full delivery history + totals.** Scrollable log + weekly / monthly rollups. |
| Actions | **Call / Text, Report issue, Request drop change, Download monthly invoice (PDF).** |
| Hosting | **Same Vercel project.** One new function (`/api/store.js`) consolidating every store endpoint; one existing tiny function (`signout.js`) folded into `me.js` to stay under the 12-fn Hobby cap. Net: 12 → 12. |

Not in scope v1:
- Franchise-group logins (one account seeing multiple stores). Can be
  added later with a `franchise_groups` table + join; v1 is per-stop.
- Email magic-link auth, SMS 2FA.
- ~~Payments / card-on-file. Invoices are reference only.~~
  **Superseded by [payment-flow.md](./payment-flow.md).** Payments are in
  v1 as of p11: Stripe ACH Debit via Plaid Link, operator-reviewed drafts
  with batch approval, PPF-controlled pulls on weekly/monthly cadence.
- Store-side chat with the operator — Call/Text covers it.

---

## Hosting + function budget

The project is at Vercel Hobby's 12-serverless-function cap. The adopted
pattern (see the comment at the top of [api/schedule.js](../api/schedule.js))
is to fold multiple logical endpoints into one function with a `?resource=`
or method switch. We do that here too.

**Before:** 12 functions.
**Change:**
- Delete `/api/auth/signout.js` (13 lines). Fold its clear-cookie behavior
  into `/api/auth/me.js` as the `POST` handler. All existing callers
  (`fetch('/api/auth/signout', { method: 'POST' })`) hit `me.js` instead —
  the route moves but the method and body are the same from the frontend's
  point of view. Actually no — callers hit `/api/auth/signout` by URL. So
  `me.js` can't catch them. Correct approach: keep `signout` route but have
  `me.js` export a thin dispatcher? That's not possible with Vercel's
  file-based routing. **Decision:** keep both URLs; move the `signout`
  implementation into `me.js` **and** rewrite `signout.js` into a 2-line
  re-export: `module.exports = require('./me');`. Vercel still counts it
  as a function. ❌ no gain.

  Clean approach: **update the 7 frontend callers** of
  `/api/auth/signout` to POST `/api/auth/me` instead. The POST handler on
  `me.js` clears the cookie. Then `signout.js` can be deleted and the
  function budget drops to 11.
- Add `/api/store.js` → 12.

Final: 12 functions, same cap.

---

## Schema diff — `supabase/migrations/p6_store_portal.sql`

### Alter `stops`

```sql
alter table public.stops
  add column if not exists store_pin_hash     text,
  add column if not exists store_display_name text,
  add column if not exists contact_phone      text;
```

- `store_pin_hash` — bcrypt hash via pgcrypto, same shape as `people.pin_hash`.
  `NULL` means "this stop can't log in yet". Operator sets it from
  `/ops/stops` (follow-up).
- `store_display_name` — e.g. `7-Eleven – Lynbrook (123 Peninsula Blvd)`.
  Falls back to `name + town + address` if unset.
- `contact_phone` — store contact; reserved for future SMS use. Not
  required for v1.

### New table — `stop_issues`

```sql
create type stop_issue_kind as enum
  ('short_count','long_count','missed','damage','other');
create type stop_issue_status as enum ('open','acknowledged','resolved');

create table if not exists public.stop_issues (
  id          uuid primary key default gen_random_uuid(),
  stop_id     uuid not null references public.stops(id) on delete cascade,
  for_date    date,                            -- which day's drop (nullable; "other" issues)
  kind        stop_issue_kind not null,
  note        text not null,
  status      stop_issue_status not null default 'open',
  resolved_by uuid references public.people(id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists stop_issues_stop_idx on public.stop_issues(stop_id, created_at desc);
create index if not exists stop_issues_open_idx on public.stop_issues(status) where status <> 'resolved';
```

### New table — `stop_change_requests`

```sql
create type stop_change_kind as enum ('double','skip','custom');
create type stop_change_status as enum ('pending','approved','denied','applied');

create table if not exists public.stop_change_requests (
  id             uuid primary key default gen_random_uuid(),
  stop_id        uuid not null references public.stops(id) on delete cascade,
  effective_date date not null,
  kind           stop_change_kind not null,
  singles_delta  int,   -- signed int override for 'custom' (null for double/skip)
  doubles_delta  int,
  note           text,
  status         stop_change_status not null default 'pending',
  decided_by     uuid references public.people(id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists stop_change_stop_idx on public.stop_change_requests(stop_id, effective_date);
create index if not exists stop_change_pending_idx on public.stop_change_requests(status) where status = 'pending';
```

### RPC — `verify_stop_pin`

```sql
create or replace function public.verify_stop_pin(p_stop_id uuid, p_pin text)
returns table(id uuid, name text, town text)
language plpgsql security definer set search_path = public, extensions
as $$
begin
  return query
    select s.id, s.name, s.town
    from public.stops s
    where s.id = p_stop_id
      and s.active
      and s.store_pin_hash is not null
      and s.store_pin_hash = crypt(p_pin, s.store_pin_hash)
    limit 1;
end
$$;
revoke all on function public.verify_stop_pin(uuid, text) from public, anon, authenticated;
```

### RLS

Enable deny-all on both new tables. All API access uses the service role.

---

## Auth model

A store session is a JWT in the same `ppf_session` cookie as staff, with
one new role value:

```json
{ "sub": "<stops.id>", "role": "store", "name": "<store display name>" }
```

Why reuse the cookie: so a single `requireRole(['store'])` in `/api/store.js`
plugs into the existing `_lib/auth.js` without any change to the helper.
The server never trusts the `role` from the body; it comes from the signed
JWT.

The `user_role` Postgres enum is **not** altered — `store` is only a JWT
role, not a `people` row. There is no `people` row for a store manager.

Risk: a staff member and a store share the same cookie slot. If a baker
signs in on the shop iPad, then a store manager wants to sign in on the
same iPad, the second signin overwrites the cookie — fine, that's the
desired behavior.

---

## API — all under `/api/store.js`

One serverless function, routed by `req.method` + `?resource=`:

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET  | `/api/store?resource=stops`          | public | List active stops with `store_pin_hash is not null`, for the signin picker. Returns `{ id, display_name }` only. |
| POST | `/api/store?resource=signin`         | public | `{ stop_id, pin }` → verify via `verify_stop_pin`, set `ppf_session` cookie with `role=store`. |
| GET  | `/api/store?resource=me`             | store  | Returns `{ stop_id, name, town, display_name }`. Store's own `/api/auth/me`. |
| POST | `/api/store?resource=signout`        | store  | Clears cookie. |
| GET  | `/api/store?resource=dashboard`      | store  | Returns the main payload: current week totals, month-to-date totals, next scheduled drop, recent deliveries, open issues, pending change requests. See payload below. |
| GET  | `/api/store?resource=history&from=…&to=…` | store | Paginated day-by-day history. Default last 60 days. |
| POST | `/api/store?resource=issue`          | store  | `{ kind, for_date?, note }` → insert into `stop_issues`. |
| POST | `/api/store?resource=change-request` | store  | `{ effective_date, kind, singles_delta?, doubles_delta?, note }` → insert into `stop_change_requests`. |
| GET  | `/api/store?resource=invoice&month=YYYY-MM` | store | Returns JSON for the printable invoice page. Rendering is client-side (print-to-PDF). No PDF lib on the server. |

### Dashboard payload shape

```ts
{
  stop: { id, name, town, address, display_name, basket, note, singles_drop, doubles_drop, route_key, route_label },
  totals: {
    this_week:   { gross_cents, singles_sold, doubles_sold, deliveries },
    this_month:  { ... },
    last_month:  { ... },
    all_time:    { ... },
  },
  recent: [ // last 14 days
    { for_date, singles_drop, doubles_drop, sold_singles, sold_doubles, sold_cents, submitted_at, submitted_by_name }
  ],
  issues:         [ { id, kind, note, status, for_date, created_at } ], // open only
  change_requests:[ { id, kind, effective_date, singles_delta, doubles_delta, note, status, created_at } ], // pending only
  operator_phone: "+1XXXXXXXXXX" // from OPERATOR_PHONE env var; empty string if unset
}
```

Everything on the dashboard is read from `stops`, `returns`,
`stop_issues`, `stop_change_requests` scoped to `stop_id = sess.sub`. The
service role bypasses RLS; the scoping is enforced in SQL via `.eq('stop_id', sess.sub)`.

### Call / Text action

Pure frontend: `<a href="tel:${phone}">Call</a>` and
`<a href="sms:${phone}">Text</a>`. `phone` comes from the dashboard
payload (`OPERATOR_PHONE` env var). Zero backend work.

### Invoice "PDF"

The invoice page is a printable HTML view. The user hits ⌘P → Save as
PDF in the browser. Server returns JSON only; no PDF library added. If
true server-rendered PDFs are needed later (email delivery, direct
download link), we can add `@react-pdf/renderer` or shell out to a
headless browser; both bloat the function.

---

## Frontend

New routes under the same Vercel project:

```
/store                      → signin.html (stop picker + PIN)
/store/dashboard            → index.html (main view)
/store/history              → history.html (date range)
/store/issue                → issue.html (form)
/store/request              → request.html (drop change form)
/store/invoice/[month]      → invoice.html (printable; reads ?month=YYYY-MM)
```

File layout:

```
/store/
  signin.html
  index.html        (dashboard)
  history.html
  issue.html
  request.html
  invoice.html
```

Static HTML with the same inline-vanilla pattern as `/driver`, `/baker`,
`/ops`. Reuses `brand.css`.

### Boot gate pattern

Every protected page starts with:

```js
const r = await fetch('/api/store?resource=me', { credentials: 'same-origin', cache: 'no-store' });
if (!r.ok) { location.href = '/store'; return; }
```

Mirrors how staff pages gate on `/api/auth/me`.

### Signin flow

1. On load, `/store/signin.html` fetches `/api/store?resource=stops` (public).
2. Renders a `<select>` grouped by route (`FSQ`, `LYN`, `FBW`).
3. User picks their stop and taps their PIN on the number pad (reuse the
   number-pad component from `signin.html`).
4. POST `/api/store?resource=signin` with `{ stop_id, pin }`. On 200,
   `location.href = '/store/dashboard'`.

### Dashboard sections

- **Hero card:** store display name, today's drop label (`4 / 2`), basket
  type, note, and the two Call / Text buttons.
- **Totals strip:** This week / This month / Last month (gross dollars,
  deliveries count).
- **Recent deliveries table:** last 14 days — date, singles/doubles
  dropped, sold, cash collected, who delivered.
- **Open issues** (if any) — list with status chips.
- **Pending requests** (if any) — list with status chips.
- **Footer links:** View full history, Report issue, Request change,
  Download invoice (opens `invoice.html` for the current month).

---

## Operator-side (not in this session; stub for day 2)

The operator needs to:
- Set / rotate a store's PIN on `/ops/stops` (one new column on the stops
  table, one row of UI).
- See the open issues + pending change requests queue (one new page or
  side-panel on `/ops`).
- Approve / deny / apply change requests. "Apply" means the operator
  mutates the stops row (`singles_drop_wknd`, etc) or the right day's
  drop. For v1, "apply" is manual — the status just moves to `applied`
  and operator does the mutation themselves on `/ops/stops`.

Those endpoints will fold into `/api/schedule.js` under existing
`?resource=stops` or a new `?resource=issues` branch, so no new function
count.

---

## Open questions (defaults chosen, confirm later)

1. **Default PIN rotation on first signin?** Staff pages treat `0000` as
   "must change". We'll do the same — operator seeds a store with PIN
   `0000`, the store must rotate on first signin. Reuses `change-pin.js`?
   Not directly — `change-pin.js` reads the session's `sub` and updates
   `people.pin_hash`. We'd need a store variant. **Decision:** fold
   change-pin into `/api/store?resource=change-pin` to avoid adding
   another function.
2. **Issue → operator notification?** Nice-to-have: Telegram ping to
   Chris when an issue is filed. We already have `_lib/telegram.js`. Add
   a `maybeNotifyOperator(issue)` call. **Decision:** yes, best-effort,
   do not fail the request if telegram errors.
3. **Rate limit on issue + change-request POST?** A hostile store could
   spam. For v1, skip — it's a closed invitation group and the operator
   sees it immediately.
4. **How does the store find out their PIN?** Operator writes it on the
   first delivery slip or texts it. Not in software.
