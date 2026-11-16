# /ops/corkboard — Notion-backed project cork board

A velvet-rope cork board of every Pretzel Cup build, backed by one Notion
database. Operator-only. Opens the Claude sidebar when the mini bridge is
online for chat, NL card ops, auto-sweeps, and per-card follow-ups.

## How it fits together

```
Browser (/ops/corkboard)
   │
   ├─▶ /api/plan-state?resource=corkboard            Notion  (reads/writes)
   │      (GET list, POST add, PATCH edit, DELETE archive)
   │
   └─▶ /api/plan-state?resource=corkboard&action=ask Mini bridge (Tailscale)
          Vercel proxies the chat to the mini,          │
          which shells out to `claude -p` under         └─▶ claude -p + Notion
          the operator's Claude subscription.               (optional writes)
```

Notion is the source of truth. Edits in Notion itself show up on the board
on next load. If the mini is offline, the board still works — the Claude
sidebar shows an "offline" chip and the FAB dot goes grey.

## One-time Notion setup

1. **Create an internal integration.**  
   <https://www.notion.so/profile/integrations> → New internal integration →
   name it something like `pretzel-cup-corkboard`. Grant it the capabilities:
   Read content, Update content, Insert content.  
   Copy the **internal integration secret** — this is `NOTION_TOKEN`.

2. **Share the database with the integration.**  
   Open the `Pretzel Cup — Builds` database in Notion. `···` menu → Add
   connections → pick the integration you just made. Without this step
   every API call returns `object_not_found`.

3. **Grab the database id.** Open the database as a full page. The URL is
   `https://www.notion.so/<workspace>/<database_id>?v=…`. The
   `<database_id>` is a 32-char hex string (without the dashes). This is
   `NOTION_BUILDS_DB_ID`.

4. **Add the `Added by` property.** On the database, `+ Add a property` →
   type **Text** → name it exactly `Added by`. The server writes the
   signed-in operator's name here on every create; it also shows at the
   bottom of each card. If the property is missing, creates still succeed
   but the attribution field is silently dropped.

## Vercel environment

These go in `Settings → Environment Variables`. Apply to **Production**
(and Preview if you want it on preview URLs too).

| Name                  | Where it comes from                              | Scope          |
| --------------------- | ------------------------------------------------ | -------------- |
| `NOTION_TOKEN`        | Notion integration secret                        | Encrypted      |
| `NOTION_BUILDS_DB_ID` | Database id from the Notion URL                  | Plain is fine  |
| `MINI_BRIDGE_URL`     | Tailscale URL of the mini bridge, e.g. `http://100.x.y.z:7878` | Plain is fine |
| `MINI_BRIDGE_TOKEN`   | Shared secret the mini and Vercel both check     | Encrypted      |

The two bridge vars are optional. Without them, the board still works and
the Claude sidebar shows an offline chip.

Add them with the CLI (operator-run; agent cannot):

```bash
vercel env add NOTION_TOKEN production
vercel env add NOTION_BUILDS_DB_ID production
vercel env add MINI_BRIDGE_URL production
vercel env add MINI_BRIDGE_TOKEN production
```

Re-deploy after setting them: `npm run deploy`.

## Mini bridge (follow-up)

The daemon is not part of this PR. It will live at
`~/pretzel-corkboard-bridge/` on the mini and expose `POST /ask` on the
Tailscale network. Expected request shape:

```json
{ "mode": "chat|add|sweep|card", "prompt": "…", "selectedId": "notion-page-id" }
```

Expected response:

```json
{ "reply": "Claude's answer here", "wrote": false }
```

The bridge is responsible for:
- Bearer-checking `Authorization: Bearer <MINI_BRIDGE_TOKEN>`.
- Passing the whole current builds list as context to `claude -p`.
- For `add` / `sweep` / `card` modes, letting Claude call Notion directly
  (the bridge has its own `NOTION_TOKEN`). The frontend reloads after any
  mode that may have written.

## Risk + rollback

Medium. The board is isolated under `/ops/corkboard`; the API change folds
into `api/plan-state.js` and leaves the default resource unchanged.
Rollback is a single `git revert` of the feature commit — no migrations,
no data dependencies to unwind. The Notion database can be deleted
standalone if the board is abandoned.
