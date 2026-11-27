# Driver bi-weekly box photos

## Risk
**High.** Touches Telegram (`api/_lib/telegram.js` is a HIGH-risk path per CLAUDE.md), adds a new Supabase migration, introduces Google Drive write auth. Human reviews and merges; no CI deploy.

## Goal
Every other Friday, drivers photograph each box on their route and submit the batch together with the normal daily route sales. Photos land in a dated Google Drive folder, and a single Telegram message tells the group the batch is ready, with a link to that folder. No photos in the group chat itself.

## Scope
`api/driver/submit.js`, `api/_lib/drive.js`, `api/_lib/sheet.js`, `driver/index.html`, `supabase/migrations/p25_route_photo_submissions.sql`

**New env var (agent can't edit `.env*` — user adds by hand):**
`GOOGLE_DRIVE_PARENT_ID=1VSJJOlCsVds2LOyS_vwVUa1MvNzb4gQx`

## Design

### Bi-weekly anchor
- Anchor: **Friday 2026-12-05**. A day is a photo day when `floor((date - 2026-12-05) / 14 days) >= 0` and `((date - 2026-12-05) % 14 days) === 0`.
- Pure function in `api/driver/submit.js` and mirrored in the driver HTML (so the client can decide to show the popup without a round-trip). Both read the same constant `PHOTO_ANCHOR_ISO = '2026-12-05'`.

### Drive layout
Parent folder: `1VSJJOlCsVds2LOyS_vwVUa1MvNzb4gQx` (user supplies as `GOOGLE_DRIVE_PARENT_ID`).
```
<parent>/
  FSQ/
    20261205 - Chris/
      01-StopName.jpg
      02-OtherStop.jpg
    20261205 - Mike/
  LYN/
  FBW/
```
Route folder and dated-driver folder are both **created on demand** by `api/_lib/drive.js` using `drive.files.list` (`q=` by name+parent+mimeType) then `drive.files.create` when missing. Idempotent: re-upload of the same stop overwrites via `drive.files.update` on the matching filename (no duplicate files).

Service account (reused from `GOOGLE_SHEET_KEY_B64`, extended to `https://www.googleapis.com/auth/drive` scope) must be invited to the parent folder as Editor — user is handling that separately. No new env var required.

### DB — `p25_route_photo_submissions.sql`
```sql
create table public.route_photo_submissions (
  id uuid primary key default gen_random_uuid(),
  for_date date not null,
  route_key text not null references public.routes(key),
  driver_id uuid not null references public.people(id),
  drive_folder_id text not null,
  drive_folder_link text not null,
  photos_count int not null default 0,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (for_date, route_key, driver_id)
);
alter table public.route_photo_submissions enable row level security;
-- RLS is deny-all; service role bypasses (same convention as returns/people).
```

### Sheet — mirror in the existing Daily Delivery Sales Report
New tab **Box Photos** in `GOOGLE_SHEET_ID` (auto-created if missing). Columns:
`Timestamp | Date | Weekday | Route | Driver | Photos | Folder Link | Submitted At`
Upsert by `(Date, Route, Driver)` — re-submit updates the row, no duplicates. Best-effort: Sheet failure is logged as `sheet_error` in the submit response but never blocks the route save. Supabase stays the source of truth for enforcement; the Sheet is a human-readable log.

### API — fold into `api/driver/submit.js` with `?action=`
`submit.js` becomes a dispatcher:

- `POST /api/driver/submit` (default; `?action=route` for clarity) — existing behavior. **New final step:** if today is a photo day for `routeKey` and `driver_id`, look up `route_photo_submissions` for `(for_date, route_key, driver_id)`; require `photos_count === stops.length` before accepting the route submit (return `409 { error: 'box photos required', missing_count }`). After the normal submit success, if the matching photo row has no `telegram_message_id`, post one Telegram message with the folder link and persist the returned `message_id`.
- `POST /api/driver/submit?action=photo` — multipart (field `file`, field `stopId`, field `forDate`, field `routeKey`). Validates the stop belongs to the route and the driver. Resizes/validates server-side only if client sent oversize (hard-cap request body at 4.5 MB; client resizes to ~1600px JPEG first). Uploads to Drive at `<parent>/<routeKey>/<YYYYMMDD> - <driverName>/<NN>-<stop.name>.jpg`. Upserts the `route_photo_submissions` row and increments `photos_count` only when a new file was created (not on overwrite). Returns `{ ok, folder_link, photos_count, stops_total }`.
- `GET /api/driver/submit?action=photo-status&forDate=…&routeKey=…` — returns `{ required: boolean, photos_count, stops_total, folder_link? }` so the UI can refresh the enforcement state after a page reload.

Keep Hobby 12-fn cap: still one serverless function (`api/driver/submit.js`).

### `api/_lib/drive.js` (new)
- `getDrive()` — lazy, mirrors `getSheets()`, same `GOOGLE_SHEET_KEY_B64`, scope `drive`.
- `ensureFolder(parentId, name)` — list-or-create; returns `{ id, webViewLink }`.
- `ensureRouteDriverFolder({ routeKey, forDate, driverName })` → `<parent>/<routeKey>/<YYYYMMDD> - <driverName>/`.
- `uploadPhoto({ folderId, filename, buffer, mimeType })` — list by name in folder; if match, `files.update(media)`; else `files.create`. Returns `{ id, webViewLink, created: boolean }`.

### Driver page — `driver/index.html`
- **Popup**: on page load, if today is a photo day and the active route needs photos (via `?action=photo-status`), show a `<dialog>` with the reminder copy, one checkbox ("I understand I must photograph each box today"), one Close button that is disabled until the box is ticked. Ack flag stored in `localStorage['photo-ack:<YYYY-MM-DD>:<routeKey>']` so it does not re-appear on refresh.
- **Per-stop photo button**: on photo days only, each stop row gets a camera button (`<input type="file" accept="image/*" capture="environment">`). After pick, resize to max 1600px (canvas), re-encode as JPEG q=0.8, POST as multipart to `?action=photo`. Row shows a green check after a successful upload; re-tapping overwrites.
- **Submit button**: on photo days, disabled until `photos_count === stops.length` (driven by `/api/driver/submit?action=photo-status` response, refreshed after each upload). Tooltip on hover explains why.

### Telegram message copy
```
📸 Bi-weekly box photos · <Route label> · <Driver name>
<date, Weekday>
<N> boxes documented.

<Drive folder link>
```
Plain `sendMessage` (no Markdown escaping surprises); link is unformatted so Telegram renders a preview card.

## Steps
1. Migration `p25_route_photo_submissions.sql` — apply locally via Supabase; verify constraint names.
2. `api/_lib/drive.js` — write + unit-smoke by stubbing `googleapis` in a node `--test`.
3. `api/driver/submit.js` — refactor into a tiny dispatcher; add `handleRoute`, `handlePhoto`, `handlePhotoStatus`. Keep `handleRoute` byte-identical to today's behavior except for the new enforcement tail.
4. Document new env var in the PR body (user adds to `.env.example` by hand; agent is blocked from `.env*`).
5. `driver/index.html` — modal + per-stop photo row + submit gate. Isolate new JS in a `PhotoDay` object so the diff stays reviewable.
6. Manual test on the local dev server (Vercel dev): simulate a photo day by temporarily anchoring to yesterday; upload a dummy photo; confirm Drive folder structure; confirm Telegram post hits the group once. Revert the anchor before committing.

## Success criteria
### Quantitative
- CI `scope-check` passes — every changed file is inside Scope.
- `node --test` passes (existing suite unchanged).
- No new code-scanning alerts on the PR.
- `grep -E 'TELEGRAM_BOT_TOKEN|GOOGLE_SHEET_KEY_B64' driver/index.html` returns nothing (no secrets in client).
- Drive uploads land in `<parent>/<routeKey>/<YYYYMMDD> - <driverName>/`; re-upload overwrites in place (verified with a dev account).
- Telegram posts **once** per `(for_date, route, driver)`; a re-submit does not duplicate (verified by `telegram_message_id not null` guard).

### Qualitative
- On a photo day, a driver cannot submit the route without a photo per stop. On a non-photo day the flow is byte-identical to today.
- The Telegram group gets one preview-card message linking to a browsable Drive folder — no photo flood.
- A new driver on a route gets their own dated folder, not someone else's.

## Risks + mitigations
- **4.5 MB Vercel request cap** — client resizes to ~1600px JPEG (≈300–500 KB typical) before upload. Hard-reject server-side at 4 MB with a clear message.
- **Service-account permissions** — if the service account isn't an Editor of the parent folder, every upload fails with a 403 Drive error. Catch the first such error, surface `{ error: 'Drive not shared with service account — see .env.example' }` in the submit response, and do not block route submit (soft-degrade: route still saves, photo enforcement is skipped and the operator sees the error in the UI banner). This is the single most likely setup foot-gun.
- **Idempotency** — re-upload for the same stop overwrites via `files.update`; the DB row's `photos_count` increments only on `created === true`. Re-submitting the route re-posts to Telegram only when `telegram_message_id IS NULL`.
- **Anchor drift** — single `PHOTO_ANCHOR_ISO` constant, same in server and client; CI test asserts `isPhotoDay('2026-12-05') === true`, `'2026-12-12' === false`, `'2026-12-19' === true`, `'2027-01-02' === true`.
- **Clock skew on client** — enforcement is driven by the server response, not the client's date. The client only uses its clock to decide whether to *show* the popup; the submit gate is server-enforced.
- **PII** — photos are of pretzel boxes in public retail aisles. No new PII category; existing CLAUDE.md privacy rules unchanged. Drive folder is a private share.
- **Hobby fn count** — zero net change (still `submit.js`).

## Rollback / escalation
- Revert the single feature commit on `agent/driver-photos`.
- Drop the table: `drop table public.route_photo_submissions;` (no FK dependents added).
- No Drive data needs to be deleted to roll back code; existing folders stay harmless.
- Escalate (per CLAUDE.md) on: Drive 403 after service-account invite is confirmed; Telegram post errors not covered by `tgCall`'s retry; any scope-check failure.
