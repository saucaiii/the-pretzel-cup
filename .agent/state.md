# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: agent/ops-prospecting
Task: /ops/prospecting page — route-density leads for operators
Status: PR ready

## Progress
- Branch cut from main (2 unrelated signin edits stashed as "pre-branch: existing signin edits").
- Plan in .agent/plan.md (Medium risk — static page + static JSON, no API/auth/db changes).
- Added ops/prospecting/{index.html, data.json, density.json, README.md}.
- Added nav link + tile + per-tile stat loader in ops/index.html.
- JSON parses; inline JS syntax-checks clean under node --check.

## Failures and root causes
- (none)

## Review notes
- Not covered: Google ratings / review counts (follow-up — needs Places API on pretzel-cup-sync).
- Full 3,700-row 20-mi dump intentionally NOT shipped; lives at ~/pretzel-cup-prospecting/prospects_all.csv.
- No new serverless function added — the Hobby 12-cap constraint stays safe.
- Operator gate pattern copied from ops/stops/index.html (/api/auth/me POST → signin on reject).

## Handoff
- Open draft PR against main. Human reviews, previews deploy, merges.
