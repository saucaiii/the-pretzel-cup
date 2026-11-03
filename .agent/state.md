# State — agent/ops-ia-nav

Task: operator-dashboard IA rebuild, PR 1 of 3 (shared nav).

Progress:
- Branch cut from latest `main` (`0d950b5`, has PR #13 sweep merged).
- `assets/ops-nav.js` written: 5-section IA, click dropdowns, Escape/outside-click close, auto-active from pathname.
- 15 `/ops/*` HTML files: nav body emptied + `<script src="/assets/ops-nav.js" defer>` injected.
- Driver/baker/API/Supabase untouched (verified by scope).

Follow-ups (separate PRs):
- Extract shared ops chrome CSS → `assets/ops-chrome.css` (kills ~80 duplicate lines/file × 15).
- Rebuild `/ops` dashboard: Today metrics (live operator numbers, not plan metrics) + 5 category cards.
