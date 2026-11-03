# Plan — /ops/prospecting adds Schools / Churches / Daycares segments

**Risk:** Medium
- Operational: static JSON data files + edits to a single operator-only page. No API, no DB, no deploy change. Reversible by `git revert`.
- Security: no auth change; reuses the existing operator gate on the page.
- Compliance: no personal data. Schools / churches / daycares are public listings (OSM + NCES public-use data).

**Goal.** Extend `/ops/prospecting` from one wholesale segment (delis + markets, 118 route-adjacent leads) to four: delis & markets, schools, churches, daycares — a fundraiser / event / coffee-hour foot-in-the-door motion for the three new segments. Operators can filter and export each segment on its own.

**Scope:** `ops/prospecting/ ops/index.html`

**Steps.**
1. Branch `agent/ops-prospecting-schools-churches` from `main`.
2. Write this plan.
3. Generate static data files from `~/pretzel-cup-prospecting/`:
   - `ops/prospecting/schools.json` (700 K-12 schools within 10 mi, NCES-enriched: public/private, enrollment, grade span, district, free-lunch %).
   - `ops/prospecting/churches.json` (838 Christian churches within 10 mi, denomination).
   - `ops/prospecting/daycares.json` (26 preschools / daycares within 10 mi).
4. Extend `ops/prospecting/index.html`:
   - Replace the two-tab control (Leads / Per-stop density) with a 5-tab control: `Delis & Markets` (the current Leads tab, unchanged) · `Schools` · `Churches` · `Daycares` · `Per-stop density`.
   - Each new tab: segment-specific filter row, sortable table, CSV export of the filtered subset.
   - Metrics strip at the top switches to show segment-specific totals.
5. `ops/index.html` — update the Prospecting tile stat to show total across all four segments.
6. Local smoke: open the page in the preview browser.
7. Commit, push, open draft PR.

**Success criteria:**
- Quantitative: new files under `ops/prospecting/` + edits to `ops/prospecting/index.html` + a 1-line stat change in `ops/index.html`. Scope check passes.
- Qualitative: operator opens `/ops/prospecting`, picks `Schools`, filters to public + min enrollment 1500, sees Freeport HS / Hempstead HS / Sewanhaka HS at the top; CSV export has the filtered subset. Same for Churches (by denomination) and Daycares. Signed-out visitors redirect to `/signin`.

**Rollback:** `git revert` the PR merge commit.

**Risks + mitigation.**
- *Larger JSON files* — schools.json ~230 KB, churches.json ~210 KB, daycares.json ~8 KB. All fetch over gzip at Vercel's static edge, no latency issue. No new serverless function.
- *Stale enrichment* — OSM pulled 2026-11-03, NCES CCD 2023-24, NCES EDGE 2024-25 public / 2023-24 private. README lists pull dates and the refresh script.

**Out of scope.**
- Private-school enrollment (needs separate PSS pull — follow-up).
- Daycare completeness (OCFS data — follow-up).
- Google Places ratings / reviews / hours — the same follow-up queued since the first PR.
- Lead status tracking (called / interested / won) — Supabase table if operators ever want it.
