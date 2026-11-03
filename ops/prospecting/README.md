# /ops/prospecting

Operator-only prospecting view: delis + supermarkets + grocery stores that sit within 1.5 mi of a current route stop. The point is route density — slot a new account into an existing drive instead of extending the route.

## Data

- `data.json` — 118 candidates (OpenStreetMap, pulled 2026-11-02). Each row: name, category, chain_type, address, lat/lon, nearest existing stop + distance in miles, phone, website, hours.
- `density.json` — per-stop density (31 rows): how many candidates sit within 1.5 mi of each current stop.

## Filters applied before shipping

- 20-mi radius around FSQ bakery + 20-mi radius around LYN bakery (union).
- Hard-excluded chains: 7-Eleven (existing accounts), CVS, Walgreens, Rite Aid, Duane Reade, Walmart, Target, Costco, Sam's Club, BJ's, Trader Joe's, Whole Foods, Aldi, Lidl, Wegmans, Fairway, dollar stores.
- Soft-flagged `chain-corporate`: Stop & Shop, ShopRite (HQ planograms).
- Deduped: same-name or ≤50 m of a current stop → dropped.
- Shipped slice: `nearest_stop_mi ≤ 1.5`.

## Refresh

```bash
cd ~/pretzel-cup-prospecting   # scripts live here
python3 pull_osm.py            # 20-mi Overpass pull
python3 triage.py              # chain filter + dedupe
python3 per_stop.py            # density
```

Then regenerate the JSON:

```bash
python3 -c "import csv, json; \
  rows=list(csv.DictReader(open('prospects_route_adjacent.csv'))); \
  json.dump({'generated_at':'<YYYY-MM-DD>','rows':rows}, open('ops/prospecting/data.json','w'), indent=2)"
```

OSM data isn't a billing record — don't chase 100% recall. Small-corner delis get mapped inconsistently. For ratings / reviews / hours, see the Google Places enrichment follow-up.

## Not shipped here

- Full 3,700-row 20-mi dump — lives at `~/pretzel-cup-prospecting/prospects_all.csv`.
- Google ratings / review counts — separate task (Places API on `pretzel-cup-sync`).
- Lead status (called / interested / won) — a Supabase table would be the right home if operators want to track outreach.
