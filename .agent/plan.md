# /ops/corkboard — Notion-backed project cork board with Claude assistant

Branch: `claude/ops-corkboard-notion` (off `main`)
Risk: Medium — one new frontend page, one new Notion helper at
`api/_notion.js` (matches `api/_qr.js` / `api/_packs.js` — stays out of
HIGH-risk `api/_lib/`), and a new `?resource=corkboard` fold inside
`api/plan-state.js`. No touch to `api/_lib/*`, no vercel.json edits, no
migrations, no scripts/, no workflows, no agent policy files, no secrets
authored by the agent (operator adds the env vars by hand). No new
dependency — Notion wrapper uses `fetch`.
Scope: `ops/corkboard/index.html`, `api/_notion.js`, `api/plan-state.js`,
`ops/index.html` (add tool tile), `.agent/plan.md`, `.agent/state.md`,
`.agent/decisions.md`, `docs/corkboard.md`.

## Goal

Give the operator one page under `/ops/corkboard` that functions like a cork
board for Pretzel Cup dev work. Each card is a row in the Notion `Pretzel
Cup — Builds` database (data source id lives in `NOTION_BUILDS_DS_ID`). The
operator can filter by status / area / priority, flag stuck cards, click a
card to edit it, add new cards — and, when the mini bridge is online, ask
Claude about the board (chat sidebar, NL card ops, auto-updates sweep,
per-card assistant).

Deprecated `/ops/plan.html` stays reachable at its existing URL.

## Why this split

- Notion is the source of truth. The ops page is a nicer skin on top. Any
  operator can also edit directly in Notion and the board picks it up on
  next load.
- Claude features live on the mini (`claude -p` under the user's
  subscription) via a tiny Tailscale bridge. Vercel proxies to it. If the
  mini is offline, the board still works — Claude features show an
  "offline" chip.
- The 12-function cap is respected: corkboard folds into `api/plan-state.js`
  (the existing ops-page state endpoint) via `?resource=corkboard`.

## Pieces

### 1. Notion schema (already created)

`Pretzel Cup — Builds` — data source `collection://e717957f-4722-4e3e-b669-02f466c1bcb4`.
Properties: Name, Status (Idea/Active/In PR/Blocked/Paused/Shipped), Area
(Ops/Wholesale/Participant/Prospecting/People/Loyalty/Routes/Payments/Infra),
Priority (P0/P1/P2), Next Action, Blocker, PR, PR State, Session Link, Repo
Link, Last Touched, Build ID (auto). Seeded with 17 rows pulled from the
`Pretzels` sidebar group (11 active, 4 shipped, 1 paused, 1 self-reference).

### 2. `api/_notion.js`

Underscore-prefixed sibling of `api/_qr.js` / `api/_packs.js`; not
deployed as a function and not in HIGH-risk `api/_lib/`. Wraps the
Notion REST API over `fetch` (no SDK dependency so we don't bump the
bundle). Exports:
- `listBuilds({ ds, token })` — returns `[{ id, name, status, area,
  priority, nextAction, blocker, pr, prState, sessionLink, repoLink,
  lastTouched }]`, newest first.
- `createBuild({ ds, token, patch })` — new row.
- `updateBuild({ ds, token, id, patch })` — patch a row.
- `archiveBuild({ ds, token, id })` — archived=true (soft delete).

Shape mirrors the SQLite columns so the frontend can talk in plain-English
property names, not Notion UUIDs.

### 3. `api/plan-state.js` — fold `?resource=corkboard`

Existing default behaviour (Upstash hash state for the `/ops/plan` page) is
unchanged. New branch when `req.query.resource === 'corkboard'`:
- `GET` → `listBuilds`, 30s CDN cache.
- `POST` (JSON body) → `createBuild`.
- `PATCH /?id=…` → `updateBuild`.
- `DELETE /?id=…` → `archiveBuild`.
- `POST /?resource=corkboard&action=ask` → proxy to `MINI_BRIDGE_URL/ask`
  with bearer; graceful 503 if the bridge is offline.

Auth: same `x-ops-password` as the rest of plan-state.

### 4. `ops/corkboard/index.html`

- Gate (shared `/ops` pattern, Mike / pretzels velvet rope).
- Top strip: filter row (Area, Status, Priority, "Stuck only" toggle) +
  search + "Add card" button + "Ask Claude" toggle.
- Cards laid out on a cork texture background. Each card is an index card
  with a slight random rotation (deterministic from id), coloured strip
  down the left by Status, PR badge top-right, Area tag, Next Action
  body, Blocker shows a red strip at the bottom if present.
- Click a card → modal with form (save = PATCH, trash = DELETE).
- "Add card" → modal pre-filled with sensible defaults.
- Claude sidebar (right dock). Messages render streamed. Four modes selected
  by a chip row: `Chat`, `Add`, `Sweep`, `Card`. `Card` mode becomes
  available once a card is selected. Sidebar shows an "offline" chip if the
  mini bridge is down.
- Card position persisted in `localStorage` per operator (not shared), so
  dragging is per-user.

### 5. Mini bridge (follow-up PR)

Not part of this PR. Will live outside the repo at
`~/pretzel-corkboard-bridge/` on the mini. This PR ships the client code
that calls it and shows the offline state gracefully. A `docs/corkboard.md`
note gives the install recipe.

### 6. `ops/index.html` — tool tile

Add a tile next to the existing "Announcements" tool linking to
`/ops/corkboard`. Keep `/ops/plan.html` tile as-is (deprecated but
reachable).

## Env vars (operator adds these — agent does not write secrets)

- `NOTION_TOKEN` — Notion internal integration token. Share the `Pretzel
  Cup — Builds` database with the integration.
- `NOTION_BUILDS_DS_ID` — `e717957f-4722-4e3e-b669-02f466c1bcb4`.
- `MINI_BRIDGE_URL` — e.g. `http://100.x.y.z:7878`.
- `MINI_BRIDGE_TOKEN` — shared secret.

## Success criteria

- `/ops/corkboard` renders the 17 seeded cards after Mike/pretzels login.
- Filters work. Edit via modal persists to Notion and shows on reload.
- Add card persists to Notion. Archive card soft-deletes.
- Claude sidebar shows "offline" cleanly when `MINI_BRIDGE_URL` is unset or
  unreachable; no 500s surfaced to the operator.
- No regression on `/ops/plan.html` (existing endpoint behaviour
  untouched).
- No new top-level API function added (folded into plan-state).

## Risks + mitigations

- **Notion API rate limits (3 req/s)**: 30s CDN cache on GET; PATCH only
  fires on save. Low operator concurrency.
- **Secrets**: agent writes no .env or vercel env. Operator sets via
  `vercel env add`; the file names are in `docs/corkboard.md`.
- **Bridge-offline UX regression**: feature-detect at page load, hide
  Claude chips if the bridge is down, show a one-line status.
- **12-function cap**: verified via `find api -name '*.js' | grep -v
  '/_'` — folding, not new function.

## Rollback

- Revert the single feature commit. No migrations to undo. Notion DB can
  be deleted standalone if abandoned.

## Follow-ups (out of this PR)

- Mini bridge daemon install + `claude -p` wiring.
- Write-support for the Claude sidebar (NL card ops) once the bridge is
  live.
- Auto-sweep cron: GitHub Actions nightly that calls the ask endpoint with
  "find stale cards".
