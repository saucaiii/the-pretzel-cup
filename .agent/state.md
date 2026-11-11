# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/ops-corkboard-notion
Task: Build /ops/corkboard — a Notion-backed project cork board for Pretzel
Cup dev work, with a Claude sidebar that proxies to a future mini bridge.

## Progress
- Notion DB "Pretzel Cup — Builds" created
  (data_source_id e717957f-4722-4e3e-b669-02f466c1bcb4; page id
  8f20306422db4775a110dbc4eddf1fa9). Schema: Name, Status, Area,
  Priority, Next Action, Blocker, PR, PR State, Session Link, Repo Link,
  Last Touched, Build ID (auto). Seeded 17 rows from the Pretzels
  sidebar group (11 active/in-PR, 4 shipped, 1 paused, 1 self-ref).
- `api/_notion.js` — fetch-based Notion wrapper (listBuilds, createBuild,
  updateBuild, archiveBuild). Underscore-prefixed, not deployed as a
  function. Moved out of `api/_lib/` since that path is HIGH-risk in
  policy.sh.
- `api/plan-state.js` — folded `?resource=corkboard` branch:
  GET/POST/PATCH/DELETE for Notion + `?action=ask` proxy to
  `MINI_BRIDGE_URL/ask` with 503 graceful offline. Default 90-Day Plan
  behaviour untouched.
- `ops/corkboard/index.html` — gated page (shares /ops/plan's boot
  pattern), cork-texture board, deterministic tilt per card, status
  strip + PR badge + blocker strip, filter row (status, area, priority,
  search, stuck-only, hide-shipped), edit/add modal, archive button,
  Claude FAB + right-dock sidebar with four mode tabs (chat, add,
  sweep, card) and an offline banner probed at load.
- `ops/index.html` — tool tile "Cork Board" added above Announcements.
- `docs/corkboard.md` — setup recipe for NOTION_TOKEN,
  NOTION_BUILDS_DB_ID, MINI_BRIDGE_URL, MINI_BRIDGE_TOKEN; the four env
  vars are operator-added, not committed.

## Open items this PR leaves behind
- No mini bridge code yet (`~/pretzel-corkboard-bridge/` is a follow-up
  PR outside this repo).
- No tests yet. The repo has no test suite (CLAUDE.md: "No test suite
  yet"). Manual smoke list is in the PR body.
- The `tool-corkboard-stat` id on /ops renders as mdash until a
  follow-up wires a stat (e.g. count of non-shipped builds).

## Failures and root causes
- None this run.

## Handoff
- Open a draft PR against `main` with the agent template filled.
- Operator adds the four env vars in Vercel, shares the Notion database
  with the integration, then `npm run deploy`.
- Smoke test after deploy: /ops/corkboard loads after Mike/pretzels
  login, shows 17 cards, filters work, add/edit/archive round-trips to
  Notion, Claude FAB shows grey dot + "offline" chip in the sidebar.
