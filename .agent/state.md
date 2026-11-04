# State — agent/ops-chrome-css

PR 4 of operator-dashboard cleanup — CSS extract.

Progress:
- Branch cut from `main` at `c5f98a5` (post-#16).
- `assets/ops-chrome.css` created with the canonical chrome rules.
- 14 ops HTML files: link added + 189 inline chrome-rule lines stripped.
- `ops/standings.html` left alone — self-contained CSS, no `/brand.css` link, needs a separate migration pass.
- Driver / baker / API / Supabase untouched.

Follow-ups: migrate `ops/standings.html` onto brand.css + ops-chrome.css; then consider extracting the per-page `.card` / `.btn` / `.field` patterns that also repeat across many ops sub-pages.
