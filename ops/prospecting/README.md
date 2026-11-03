# /ops/prospecting

Operator-only wholesale prospecting across four segments. The deli / market tab is route-density (slot into an existing driver route); schools / churches / daycares are foot-in-the-door event / fundraiser / function orders that lead to standing wholesale.

## Data files (static JSON, shipped with the repo)

- `data.json` — 118 route-adjacent delis + markets within 1.5 mi of a current stop (10mi radius from either bakery minus chains + existing accounts).
- `density.json` — per-stop deli / market density (31 stops).
- `schools.json` — 700 K-12 schools within 10 mi of a bakery, NCES-enriched with public/private, enrollment, grade span, district, free-lunch %.
- `churches.json` — 838 Christian churches within 10 mi, by denomination.
- `daycares.json` — 26 preschools + daycares within 10 mi (OSM only — thin coverage).

## Source + pull dates

- OpenStreetMap via Overpass — pulled 2026-11-03.
- NCES EDGE Public School Locations — 2024-25 (September 2025).
- NCES EDGE Private School Locations — 2023-24 (December 2024).
- NCES Common Core of Data Public School Characteristics — 2023-24.

## Filters applied before shipping

**Delis + markets**
- 20-mi union of both bakery radii; keep ≤ 1.5 mi from a current stop.
- Hard-excluded chains: 7-Eleven (existing accounts), CVS/Walgreens/Rite Aid/Duane Reade, Walmart/Target/Costco/Sam's/BJ's, Trader Joe's/Whole Foods/Aldi/Lidl, Wegmans, Fairway, dollar stores.
- Soft-flagged `chain-corporate`: Stop & Shop, ShopRite.
- Dedup against current stops by name OR ≤ 50 m coord match.

**Schools**
- 20-mi union of both bakery radii; shipped slice ≤ 10 mi.
- K-12 only. Universities / colleges filtered out (ISCED levels 5–8, name match).
- Joined to NCES EDGE public + private geocode by distance (≤ 300 m) + name-token overlap; enrollment from NCES CCD characteristics by NCESSCH id.

**Churches**
- Christian denominations only (religion=christian OR Christian denomination tag OR Christian-named inferred when no tag).
- 20-mi union; shipped slice ≤ 10 mi.

**Daycares**
- `amenity=kindergarten` in OSM; shipped slice ≤ 10 mi. OSM coverage is sparse — most independent in-home daycares aren't mapped.

## Refresh

Scripts live in `~/pretzel-cup-prospecting/` on the operator machine (not in this repo):

```bash
# OSM pulls
python3 pull_osm.py                  # delis + markets (20 mi)
python3 pull_schools_churches.py     # K-12 + Christian churches + preschools

# Triage + CSV
python3 triage.py                    # delis chain filter + dedup
python3 triage_schools_churches.py   # schools + churches + daycares CSVs

# NCES enrichment (schools only)
python3 nces/enrich_schools_v2.py    # join OSM schools to NCES, add enrollment
python3 rebuild_schools_csv.py       # write final 10-mi / 20-mi CSVs

# Then regenerate the JSON files in this directory
```

## Not shipped here

- 20-mi full dumps for all segments — lives at `~/pretzel-cup-prospecting/*_20mi.csv`.
- Google ratings / reviews / hours — separate task (Places API on `pretzel-cup-sync`).
- Private-school enrollment — PSS pull, follow-up.
- Daycare completeness — NY State OCFS licensed-childcare, follow-up.
- Lead status (called / interested / won) — Supabase table if operators want to track outreach.
