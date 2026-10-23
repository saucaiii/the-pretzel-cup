# The Pretzel Cup &mdash; Two Views

A pair of single-page sites for the PPF × 7-Eleven weekly sales competition. Both pull live from the same Google Sheet, but show different things to different audiences.

## Two URLs, two audiences

- **`/`** &mdash; the **participant view**. Public, no login. For 7-Eleven store managers. Shows ranks and gold progress bars; **never shows dollar amounts**.
- **`/ops`** &mdash; the **PPF operator view**. Login-gated (`Mike` / `pretzels`). Shows everything: dollars, percent changes, biggest movers, full operational data.

Both views share the same data source, the same brand system, and the same parsing logic. They differ only in what they reveal to the viewer.

## Files

```
pretzel-leaderboard/
├── index.html       ← Participant view (public)
├── ops.html         ← PPF operator view (gated)
├── ppf-logo.jpg     ← Official PPF logo
├── vercel.json      ← Static-hosting config + security headers + clean URLs
└── README.md        ← This file
```

## Important note on the password gate

**The login on `/ops.html` is NOT real security.** The username and password live in the page's JavaScript — anyone who views the page source (right-click → View Source, or DevTools) can read them in seconds.

This is a "velvet rope" gate: appropriate for keeping a 7-Eleven clerk from stumbling into the operator view if they visit the wrong URL. It is **not** appropriate for protecting genuinely sensitive financial data from someone who is trying to see it.

If you need real protection:

1. **Vercel Password Protection** (recommended) — Pro plan feature ($150/mo) that gates the deployment at the edge before any HTML loads. Add it under Vercel project settings → Deployment Protection.
2. **Split into two Vercel projects** — `pretzelcup.vercel.app` for participants (public), `pretzelcup-ops.vercel.app` for operators (with Vercel Password Protection). Only PPF gets the second URL.

For now, the velvet rope is fine. Just understand what it is.

## Seasons and quarters

Each week is a **Season**. Calendar quarters group them — **Q1 = Jan/Feb/Mar, Q2 = Apr/May/Jun, Q3 = Jul/Aug/Sep, Q4 = Oct/Nov/Dec**. The campaign starts at `CAMPAIGN_START` (set to 4/27/2026 in the config).

- **Season prize**: 10% off the winner's next supply bill
- **Quarter prizes**: Grand Prize, 2nd Place, 3rd Place (defined in the `QUARTER_PRIZES` config — fill in the actual prizes once decided)

Quarter totals aggregate sales from the first of the quarter (Apr 1 for Q2) through the last day of the quarter (Jun 30 for Q2), **clamped to the campaign start** — so the first quarter only counts seasons that fall within the campaign window. Future quarters get full 13-week aggregates.

The current season and quarter are computed automatically from today's date. No manual rollover needed each week. You only need to touch the code if:

- You want to update the quarter prize labels (`QUARTER_PRIZES` config block in both HTML files)
- The campaign start date changes (`CAMPAIGN_START`)

## Participant view (`/`)

What the store manager sees:

- **Hero** — "See where you stack up." + current season number/dates + 10% off prize callout
- **Countdown** — time remaining until Monday reset
- **Live Standings** — every store, ranked, with gold progress bars showing % of the way to the current leader. Caption underneath each bar shows the per-day change vs. last season.
- **Quarter Grand Prizes** — top 3 stores in the current quarter on a podium-style layout with progress bars (no dollars)
- **How It Works** — four-card playbook
- **Crave Big. Snack Bigger.** brand close

What they *don't* see: dollar amounts, week-over-week percent change with green/red arrows, biggest-mover callouts. Those are all operator-only.

## Operator view (`/ops`)

After signing in with `Mike` / `pretzels`:

- Black "PPF OPERATOR VIEW · CONFIDENTIAL · SIGNED IN AS MIKE" banner at the top
- "Sign Out" button in the header (clears the session)
- Same season/quarter framing as the participant view
- **Full standings with dollar amounts**
- **vs Last Season** percent change with up/down arrows
- **Biggest Mover** card showing the store with the highest growth
- Quarter standings with dollars and days reported

The session is stored in `sessionStorage`, so it survives page reloads but clears when the browser tab closes.

## Deploy to Vercel

### Drag-and-drop
1. Go to [vercel.com/new](https://vercel.com/new)
2. Drag this folder onto the page
3. Click Deploy
4. The participant view will be at `your-project.vercel.app/` and the operator view at `your-project.vercel.app/ops` (clean URL, no `.html`)

### CLI
```bash
npm i -g vercel
cd pretzel-leaderboard
vercel --prod
```

`vercel.json` has `"cleanUrls": true`, so `/ops` automatically serves `ops.html`.

## Brand alignment

Both views follow the PPF Brand Guides:

- **Primary green** `#0D5237` dominates
- **Gold trio** (`#F2E7A4` → `#D4B662` → `#B2872F`) for accents, prize cards, and progress bars
- **Black** for the countdown strip and crave banner
- **Diamond plate** at the top of the header on both pages (white at ~75% opacity, three rows, top only — never both top and bottom, never distorted)
- **Made to Crave®** in the footer with the registered trademark
- **"Crave Big. Snack Bigger."** banner pulled from the brand-approved tagline list

### Typography

FatFrank/Gotham/SantElia aren't free Google Fonts. The pages use:

| Brand font | Stand-in |
|---|---|
| FatFrank (display) | **Anton** |
| Gotham (body) | **Inter** |
| SantElia (script accent) | **Caveat** |

### Logo

Both views use the official PPF logo (`ppf-logo.jpg`), as supplied. Per brand spec, no recoloring/rotation/alteration. If you receive a transparent PNG or SVG, drop it in and update the `<img src=>` references in both HTML files.

## Weekly maintenance

Almost zero. The current season/quarter are computed automatically from `CAMPAIGN_START`. Just update the spreadsheet as usual; the leaderboard auto-refreshes every 5 minutes.

The one thing you might want to update each quarter: the `QUARTER_PRIZES` labels in both files (currently "Grand Prize" / "2nd Place" / "3rd Place" — change to whatever the actual prizes are, e.g. "$5,000 / $2,500 / $1,000" or "Trip to Philly / iPad / Gift Card").

## Marketing-psychology choices

- **Progress bars instead of dollars on participant view**: hides sensitive numbers while preserving the live-race feeling. Stores can see *how close* they are to the leader without seeing the exact gap in dollars.
- **"Leading the pack" on the #1 bar**: explicit verbal confirmation triggers status reward; makes #1 visible even to peripheral-vision viewers.
- **"% of leader" framing**: anchors effort to a moving target. The harder the leader pushes, the more everyone has to push to keep their relative position — this is the "Red Queen" dynamic that sustains league competition.
- **"vs last season" caption**: gives stores a private metric (their own velocity) alongside the public metric (rank). Even stores at the bottom of the leaderboard get a positive signal if they're growing.
- **Quarter grand prizes**: anchor for the long game. Without these, stores that fall behind early in a season give up. With a 13-season aggregate, every season counts toward something bigger.
- **Crave-forward copy** ("Stack wins all quarter", "Crave Big. Snack Bigger.") keeps the brand voice consistent.
