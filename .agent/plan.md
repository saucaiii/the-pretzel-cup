# Plan — /ops/prospecting page

**Risk:** Medium
- Operational: static page + static JSON; no API, no DB migration, no deploy change. Reversible by `git revert`.
- Security: no auth change; reuses existing `/api/auth/me` operator gate verbatim.
- Compliance: no personal data; prospect records are public OSM data (business names + public addresses).

**Goal.** Give operators a route-density prospecting view inside `/ops`, so they can see 118 delis / supermarkets within 1.5 mi of a current stop, sorted by distance, grouped by route, and exportable.

**Scope (files touched).**
- `ops/prospecting/index.html` — new page (operator gate + table + filters + CSV export).
- `ops/prospecting/data.json` — 118 route-adjacent prospects (name, category, chain_type, address, lat/lon, nearest stop + distance, phone, website, hours).
- `ops/prospecting/density.json` — per-stop density (31 stops, how many prospects within 1.5 mi).
- `ops/prospecting/README.md` — one-page note on source + refresh.
- `ops/index.html` — add "Prospecting" tile + nav link; add per-tile stat loader.

**Out of scope.**
- Full 3,700-row 20-mi dump (lives in `~/pretzel-cup-prospecting/prospects_all.csv`, not shipped).
- Google Places enrichment (ratings / reviews / hours) — a separate task.
- Supabase table for prospects. If operators want to mark leads as "called / interested / won", that's a follow-up.
- Any changes to `api/`, `supabase/`, `vercel.json`, auth, telegram, sheets libs.

**Steps.**
1. Branch `agent/ops-prospecting` from `main` (done).
2. Write this plan.
3. Copy prospects_route_adjacent.csv + per_stop_density.csv from `~/pretzel-cup-prospecting/` to JSON in `ops/prospecting/`.
4. Build `ops/prospecting/index.html` reusing the gate / banner / nav pattern from `ops/stops/index.html`.
5. Add tile + nav link in `ops/index.html`.
6. Local smoke: load the page in the preview browser signed in as an operator.
7. Commit; push `agent/ops-prospecting`; open **draft** PR.

**Success criteria.**
- Quantitative: new files land only under `ops/prospecting/` plus a tile + nav line in `ops/index.html`; nothing else diffs. Scope check passes.
- Qualitative: operator can open `/ops/prospecting`, filter by route, see distance-to-nearest-stop, click a lead to open Google Maps, export the filtered subset to CSV. Signed-out visitors are redirected to `/signin`.

**Risks + mitigation.**
- *Stale OSM data.* README states the pull date (2026-11-02) and the one-command refresh path. Not a correctness risk — it's a lead list, not a billing record.
- *Operator confusion with current customers.* Dedup already applied (names + 50m coord match); re-check pre-commit.
- *Vercel 12-function cap.* No new API function. Data is a static JSON file served by Vercel's static layer.

**Rollback.** `git revert` the PR merge commit.
