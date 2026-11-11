# Plan: corkboard "Added by" + remove ops header logo

Branch: `claude/corkboard-added-by-remove-logo`
Risk: **Low** — UI-only on one page plus two server files; no migrations, no `api/_lib/`, no workflows, no `vercel.json`.
Scope: `ops/corkboard/index.html, api/plan-state.js, api/_notion.js, docs/corkboard.md`

## Goal

Stamp every new cork board card with the operator who created it so the team can see who added what, and strip the redundant PPF logo image from the corkboard header (the wordmark next to it already names the page).

## Scope

In scope:
- `ops/corkboard/index.html` — remove the `<img>` inside `.ops-brand`; add a small "Added by …" footer on each card; a `.added-by` CSS rule.
- `api/plan-state.js` — `checkGate` now returns the session; `handleCorkboard` stamps `patch.addedBy` (direct POST) and `body.addedBy` (bridge proxy) from `sess.name`, server-side, so the client can't spoof it.
- `api/_notion.js` — read/write the new `Added by` rich-text property; if Notion returns 400 because the property is missing, retry once without it so creates still land.
- `docs/corkboard.md` — document the new Notion property.

Out of scope:
- The shared `ops-brand` logo on other `/ops/*` pages. The user asked about this one.
- The mini bridge (`~/pretzel-corkboard-bridge/` on the mini) — updated separately, same operator, same data flow.

## Success criteria

- `/ops/corkboard` renders without the PPF image, and the "Philly Pretzel Factory / Operator" wordmark still links to `/ops`.
- Adding a card via `+ Add card` or the Claude sidebar's `add` mode writes the operator's display name to the `Added by` Notion property. The card shows `Added by <name>` under the blocker strip.
- If the Notion `Added by` property is missing, the create still succeeds (retry path), no 500.
- Existing cards without an `Added by` value render exactly as before.

## Risk and rollback

Risk is low. The server stamps `addedBy` only on `method === 'POST'` and `action === 'ask'`; GET/PATCH/DELETE are untouched. The Notion retry path is a single-shot strip-and-retry, bounded, no loop. CSS additions are scoped under `.card .added-by`.

Rollback: `git revert` of the merge commit. No migrations to undo. The Notion `Added by` property can remain on the DB without the code reading it.

## Test plan

- [ ] `/ops/corkboard` loads with no PPF logo in the header.
- [ ] `+ Add card` → Notion row has `Added by` set to the signed-in operator name; card shows "Added by …".
- [ ] Claude sidebar in `add` mode creates a row with `Added by` set.
- [ ] If the Notion `Added by` property is removed, the next create still 201s (the retry path).
- [ ] Existing cards without `Added by` render unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
