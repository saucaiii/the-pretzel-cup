# Plan: qr-control-panel (`/ops/qr`), stacked on PR #26

Branch: `agent/qr-scan-redirect` (stack on draft PR saucaiii/the-pretzel-cup#26).
Design approved by the human in chat ("Approve plan as written"), 2026-11-05.
This file still needs `scripts/agent/approve-plan.sh` before any edit.

## Risk
**HIGH overall, with CRITICAL parts that are prepare-only.**
- HIGH (security): new operator-only write path that changes what a
  printed QR sticker points at and what the public offer page says.
  Auth via the existing `readSession`/`requireRole` (role `operator`).
  `api/_lib/` is NOT edited.
- MEDIUM (operational): `middleware.js` gains Redis counters; `api/leads.js`
  gains a `?resource=` dispatcher; `assets/ops-nav.js` gains one link.
- LOW: `/ops/qr` page, `/free-pretzels` live-offer rendering, vendored QR lib.
- CRITICAL, human only: creating the Vercel access token
  (`EDGE_CONFIG_WRITE_TOKEN`), setting env vars `EDGE_CONFIG_WRITE_TOKEN`
  and `EDGE_CONFIG_ID`, creating + connecting the Edge Config store,
  seeding `scan_target` and `offer`, any deploy. The agent writes the
  exact steps into the PR and `.agent/state.md`; it never runs them.
- Fairness/automated decisions about people: none.

## Goal
An operator can, from `/ops/qr` and without a redeploy: change where `/scan`
sends people, edit and schedule the `/free-pretzels` offer with a live phone
preview, lint copy against brand voice, generate per-placement QR codes in
brand colours, see scan counts by placement, and restore any of the last 20
versions in one click.

## Scope (files the human should list in `.agent-control/scope.txt`)
- `api/leads.js` (add `?resource=offer` and `?resource=qr` dispatch; existing lead POST/GET unchanged)
- `api/_qr.js` (new; underscore = not a serverless function, so the 12-function cap is untouched)
- `middleware.js` (Redis scan counters, reject self-loop `/scan` targets)
- `ops/qr/index.html` (new)
- `assets/ops-nav.js` (one "QR + Offer" link under Sales)
- `assets/vendor/qrcode-generator.js`, `assets/vendor/qrcode-generator.LICENSE` (new, vendored, MIT)
- `free-pretzels/index.html`
- `tests/scan-redirect.test.mjs` (extend), `tests/qr-config.test.mjs` (new)
- `package.json` (only to add a `test` script; no new dependencies)
- `.agent/plan.md`, `.agent/state.md`, `.agent/decisions.md`

Not touched: `api/_lib/`, `vercel.json`, `scripts/`, `.github/`, `supabase/`, hooks, settings.

## Steps
1. **`api/_qr.js`** (CommonJS, pure where possible so it is unit-testable):
   - `parseTarget` with the same rules as `middleware.js` (relative `/path`,
     not `//` or `/\`, or absolute http/https), plus: reject own-host `/scan`
     (redirect loop), max 2000 chars.
   - `validateOffer`: headline <= 80, details <= 600, steps 0..5 each <= 140,
     fine_print <= 800, stamp <= 40, layout in {green, black, gold-light},
     starts_at/ends_at ISO dates with ends >= starts. Unknown keys dropped.
   - `lintCopy`: flags em/en dashes, emojis (Extended_Pictographic),
     `!!`/`?!` stacks, headline > 48 chars. Advisory only, returned to UI.
   - `sanitizePlacement`: `[a-z0-9_-]{1,32}` else `other`.
   - Edge Config write: `PATCH https://api.vercel.com/v1/edge-config/{EDGE_CONFIG_ID}/items`
     with `Authorization: Bearer ${EDGE_CONFIG_WRITE_TOKEN}`, items
     `[{operation:'upsert', key, value}]`, 8s timeout. Missing env -> 503
     with a clear "not configured" message (never crashes).
   - Read path: `@vercel/edge-config` `get()` (already a dependency).
   - Redis (existing `@upstash/redis`, same env vars as leads.js):
     history `LPUSH qr:history` + `LTRIM 0 19`, entry
     `{v, ts, by_sub, by_name, kind, scan_target?, offer?}`;
     stats from `qr:scans:<YYYY-MM-DD>` hashes.
2. **`api/leads.js`**: at the top of the handler, if `req.query.resource`
   is `offer` or `qr`, hand off to `api/_qr.js`; otherwise existing code runs
   byte-for-byte as today.
   - `GET ?resource=offer` public; `Cache-Control: public, s-maxage=30, stale-while-revalidate=120`;
     returns `{offer, status: 'scheduled'|'live'|'ended'}`.
   - `GET ?resource=qr&view=config|history|stats` operator.
   - `POST ?resource=qr` operator, `{action: 'publish_offer'|'set_target'|'reset_target'|'restore', ...}`.
     CSRF: require `Content-Type: application/json` and `Origin` matching the host.
     Write Edge Config first, then history; history failure is logged, not fatal.
3. **`middleware.js`**: inside the existing `waitUntil`, `HINCRBY qr:scans:<date> <placement> 1`
   + `EXPIRE 40d`, using the REST client; any error swallowed. Date uses the
   timezone already used elsewhere in the repo (checked at implement time;
   UTC if none). Self-loop targets fall back to `/free-pretzels`.
   Redirect behaviour and 800ms Edge Config timeout unchanged.
4. **Vendor QR lib**: `qrcode-generator@1.4.4` (Kazuhiko Arase, MIT) via
   `npm pack` into the scratchpad, copy the single browser file + licence into
   `assets/vendor/`. Pinned, no runtime CDN, noted in the PR.
5. **`ops/qr/index.html`** using `assets/ops-chrome.css` + `assets/ops-nav.js`:
   1) redirect picker (site pages list + custom URL, inline validation,
      test link, reset to `/free-pretzels`);
   2) offer editor with live phone preview (iframe of the real
      `/free-pretzels?preview=1` fed via `postMessage`);
   3) creative tools: green/black/gold-light hero, optional stamp line, start/end
      schedule, brand-voice lint panel;
   4) QR studio: placement name -> `/scan?utm_source=<name>`, SVG + PNG
      download, colours limited to the brand palette, contrast check
      (WCAG ratio >= 4.5 and dark-on-light module colour) that blocks download on fail;
   5) scan stats today / 7d / 30d by placement;
   6) history list with one-click restore (confirm dialog).
   Brand rules: see "Brand rules (from the brand guide)" below; they apply
   to the editor, the preview and every QR/hero option. Hero layouts are
   **green / black / gold-light (#F2E7A4)**; there is no cream option.
   Lint and layout options enforce: tagline colour locked to white or black,
   diamond plate top-only, no green+gold gradient (all backgrounds solid),
   no off-palette colours, no second "crave" line next to the lockup.
6. **`free-pretzels/index.html`**: apply the brand fixes below to the
   current static page first (tagline, diamond plate, palette, type), then
   fetch `/api/leads?resource=offer` (2.5s
   timeout); render headline/details/steps/fine print/stamp/layout; if
   status `ended`, show "This offer has ended" plus the two locations; on any
   failure keep today's static content. `?preview=1` accepts `postMessage`
   from the same origin only.
7. **Tests** (`node --test`): validation tables for target/offer/lint/
   placement; parity test that `_qr.js` and `middleware.js` `parseTarget`
   agree on a shared input table; middleware counter path with a stub Redis
   (success, Redis throws, Redis missing) never changes the 302; self-loop
   fallback; handler auth (no session 401, wrong role 403, bad Origin 403)
   with stubbed auth.
8. **Validate**: tests, `tests/guardrails.sh`, `scripts/agent/eval-report.sh`,
   reviewer subagent; visual check of `/ops/qr` and `/free-pretzels` at
   375px and desktop in a local static server with mocked API responses.
9. **Record + propose**: update `.agent/state.md` and `.agent/decisions.md`,
   commit (Conventional Commits) and push to `agent/qr-scan-redirect`, update
   the draft PR body with Evidence and the human steps. Never merge, deploy,
   set secrets or force-push.

## Brand rules (from the brand guide)
Source: internal brand guide PDF held by the user. It is marked internal and
this repo is public: never commit it, copy pages from it, or quote it at
length in code or the PR. Short rule summaries in comments are fine.
- **Tagline** "Made to Crave®" (with ®), title case, centred directly under
  the logo, gap = one tagline height, colour white or black only (white on
  green here; today it is gold-light, which is wrong). One tagline only, no
  stacked "crave" lines under it.
- **Diamond plate** at the very top of the page, flush to the edge, exactly
  3 rows (48x24 tile, so 36px tall at 2 diamonds per tile row), white at
  75% opacity on green, even unaltered spacing. Never top and bottom.
  Remove the thin strip under the hero.
- **Logo** clear space >= height of the "P" in Philly on every side; nothing
  over it; no recolour, tilt, crop, outline or ring.
- **Colour** solid only: green #0D5237 dominant, black, gold #D4B662 /
  #B2872F / #F2E7A4 (light panels). Secondary text cool gray #6D6E71.
  Cream #FAF4E1 is removed everywhere. No gradients at all.
- **Type** headlines Archivo Black (FatFrank stand-in) at +0.01em
  letter-spacing, never tightened; body Montserrat 400/500/700 (Gotham
  stand-in); optional script accent word in Caveat (SantElia stand-in);
  never BullPen.
- **Voice** bold, confident, flavourful, simple. "Crave" lines are welcome
  in promo body copy, never next to the logo + tagline lockup. Plus the
  standing rules: no emojis, em dashes, shadows, hover animation, soft
  rounded cards, pure white backgrounds, Inter/Geist.

## Success criteria
- Quantitative: all `node --test` suites pass (existing 20 plus new);
  `tests/guardrails.sh` passes; only files in Scope change (CI scope-check);
  serverless function count unchanged (`api/_qr.js` is underscore-prefixed);
  no new npm dependencies.
- Qualitative: with env vars unset, every write returns a clear 503 and the
  public page and `/scan` still work exactly as on PR #26; an operator can
  restore a prior version in one click; the QR studio cannot export a
  low-contrast or off-brand code; brand lint catches each listed pattern;
  `/free-pretzels` shows "Made to Crave®" in white under the logo, a
  3-row diamond plate at the top only, and no #FAF4E1 anywhere in the repo
  files touched (grep check); the brand PDF is not in git.

## Risks + mitigations
- **Write token blast radius**: a Vercel access token can do more than edit
  Edge Config. Mitigation: human creates it scoped to the team with an
  expiry; only read server-side; never sent to the browser or logged.
- **Bad target bricks the sticker**: validation server-side and in middleware;
  middleware still falls back on anything invalid; reset button.
- **Self-redirect loop**: `/scan` targets rejected in both places.
- **CSRF on operator POST**: JSON content type + Origin check + existing
  session cookie.
- **Redis counters slow or break `/scan`**: inside `waitUntil`, errors
  swallowed, test proves the 302 is unchanged when Redis throws.
- **Unbounded Redis keys**: placement sanitised; day hashes expire in 40 days;
  history trimmed to 20.
- **Edge Config propagation delay (seconds)**: UI says "live within about a
  minute" and re-reads after publish.
- **Stored XSS via offer text**: page renders with `textContent` only; length limits.
- **Leads endpoint regression**: dispatcher only triggers on `resource`;
  existing POST/GET paths untouched; reviewer checks the diff.

## Rollback / escalation
- Code: `git revert` the commits on this branch (no history rewrite). PR #26
  behaviour returns.
- Config: restore from history in `/ops/qr`, or the human sets `scan_target`
  in the Vercel dashboard. Deleting the `offer` key makes `/free-pretzels`
  show its static content.
- Escalate: any need to touch `api/_lib/`, `vercel.json`, or a new
  serverless function; 2 failed retries; any scope change.
