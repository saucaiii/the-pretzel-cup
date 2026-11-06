# Plan: pretzel-packs v2 (3D foil packs, swipe carousel, 4th pack)

Draft, 2026-11-05. Not approved. Replaces the v1 plan (approved, built,
draft PR #27 on branch `agent/pretzel-packs`). v1 is in git history at
commit 269c89b. This plan changes v1's design, so it needs a new
`scripts/agent/approve-plan.sh` before any code changes.

## Risk
**CRITICAL (personal data, prizes), with HIGH parts.** Take the highest.
- CRITICAL: the prize cap goes from 3 to 4 per person; the migration
  changes (still unapplied, so `p10_pretzel_packs.sql` is edited in place).
  Human applies the migration, sets env, deploys.
- HIGH: new third-party code (three.js, MIT, vendored); third-party
  trademarks on the page (Instagram glyph, Apple App Store badge).
- MEDIUM: `api/_packs.js` new `app` source; `api/_qr.js` `app_store_url`.
- LOW: pack rendering, carousel, motion.
- Automated decisions about people: none. Every pack wins the same pretzel.

## Goal
Make the pack feel real and fun on a phone: an industrial, diamond plate,
gold foil booster pack rendered in 3D with real light, in a carousel of
5 packs the player swipes through, then opens. Bonus packs: email (+1),
Instagram (+1), App Store download (+1). Max 4 per person per offer.

## Decisions (user, 2026-11-05)
1. Rendering: 3D with three.js and **our own pack model built in code**
   (no Sketchfab model, so no credit line).
2. Brand exception: **lit metallic shading on the 3D pack only**, in brand
   golds, green and black. Page, buttons and voucher stay solid colour.
   Gold-to-gold shimmer rule still applies everywhere else.
3. 4th pack: **App Store download, honor tap** (like Instagram). Cap 4.
4. Carousel: **5 packs**, all identical in outcome (every pack wins).
5. Pack order: 1 first (free), 2 email, 3 Instagram, 4 App Store.

## Scope
**Scope (paths/files):** api/leads.js api/_packs.js api/_qr.js ops/qr/ free-pretzels/ supabase/migrations/p10_pretzel_packs.sql tests/ .agent/

Same as v1 (no widening). three.js is vendored under
`free-pretzels/vendor/` (inside scope). Not touched: `api/_lib/`,
`vercel.json`, `middleware.js`, `scripts/`, `.github/`, `package.json`
(three.js is not an npm dependency of the app).

## Design
**Pack model (built in code, `free-pretzels/pack3d.js`):**
- A crimped foil pouch: a subdivided plane bent into a slightly pillowed
  shape (thicker in the middle, thin at the edges), with crimped seal
  strips at top and bottom (zigzag ridges in the geometry).
- Materials (three.js `MeshPhysicalMaterial`): gold foil (metalness 1,
  low roughness, brand golds #D4B662 / #B2872F / #F2E7A4), diamond plate
  on the upper face (normal and roughness maps drawn on a canvas at run
  time from the existing 48x24 diamond tile, so no texture files), green
  #0D5237 lower panel. The environment map is a small canvas-made studio
  (black with gold-light softboxes), so reflections stay on-brand.
- Front art as canvas textures: "FREE PRETZEL" in Archivo Black on a black
  band above the tear line; our logo flat on the lower panel (never
  tilted, cropped or recoloured on the texture; see the logo rule below).
- Tear line: a gold strip across the middle; it brightens in beat 2.
- Rip (beat 3): two meshes (top and bottom halves). Top flies up and away,
  bottom drops straight down, no rotation.

**Logo rule with 3D:** the logo is printed on the pack, and the pack turns
in 3D. To keep "never tilted": the carousel turns packs only around the
vertical axis by at most 25 degrees while swiping (the logo stays upright,
never rotated in-plane), and every pack faces flat front when centred and
during beats 2 to 6. In beat 1 (spin-in) the logo stays hidden until the
pack faces front, as in v1. If the human considers any 3D turn a "tilt",
fall back to: logo hidden on all non-centred packs.

**Carousel (step 0, replaces "pick 1 of 3"):**
- 5 packs in a row, centred one large, neighbours smaller and dimmer.
  Swipe (pointer drag with momentum and snap), arrow buttons, and arrow
  keys. Light glints across the foil as packs move (tilt follows the drag;
  optional device tilt via `DeviceOrientationEvent` only after a tap,
  iOS asks permission, off by default).
- "Open this pack" button under the centred pack (plus tap on the pack).
  The chosen pack flies to centre, the others drop away, stage goes black,
  then the six beats run with v1's timing table (unchanged).

**Win (beats 3 to 6):** unchanged from v1 (real pretzel pops out, rays,
YOU WON / FREE PRETZEL, burst, shimmer, stamp, rivets rain, voucher).
The 3D canvas renders the pack; the existing 2D canvases keep rivets
(behind) and shards (front).

**Bonus list (page):**
- Pack 2: "Sign up with email (+1)" (unchanged flow, magic link, POST
  confirm).
- Pack 3: "Follow on Instagram (+1)" with the official Instagram glyph.
- Pack 4: "Download the app (+1)" with Apple's official "Download on the
  App Store" badge, linking to the `app_store_url` set in `/ops/qr`
  (validated `https://apps.apple.com/...`). Hidden until set. Unlocks on
  return (honor system, once per player).
- Trademark use: official artwork only, unaltered, at or above each
  owner's minimum size and clear space, on a plain background (white
  badge variant on black where needed). The human supplies the official
  files from Apple Marketing Tools and Instagram's brand resources; the
  agent does not redraw them. Until supplied, text buttons are used.

**Performance and fallbacks:**
- three.js (r160 module build, about 170 KB gzipped) and `pack3d.js` load
  only when the API says the game is on, after first paint.
- Pixel ratio capped at 2; one render loop that stops when nothing moves;
  carousel renders 5 instances of one geometry.
- No WebGL, load failure, or `prefers-reduced-motion`: use v1's CSS packs
  (already built) in the same carousel layout, no 3D.
- Target: 60 fps on a mid-range phone, under 1.5 s from tap to beat 1.

## API and data changes
- `api/_packs.js`: `SOURCES` adds `app`; `MAX_PACKS` 4; new action
  `{action:'app'}` (like `instagram`: live game, `app_store_url` set,
  rate-limited, once per player sets `pack_players.app_at`); state gains
  `bonuses.app` and `app_store_url`. Opening order: first, email,
  instagram, app.
- `api/_qr.js`: offer gains `app_store_url` (empty or
  `^https://apps\.apple\.com/` up to 300 chars).
- `p10_pretzel_packs.sql` (unapplied, edited in place): `pack_players.app_at
  timestamptz`; `pack_vouchers.source` check adds `'app'`. If it was
  applied before this lands, the human gets a separate `ALTER` instead.
- `/ops/qr`: App Store URL field; stats rows for app packs and app taps.

## Steps
1. Migration + `_packs.js` + `_qr.js`: `app` source, cap 4, `app_store_url`.
2. Tests: cap 4, app tap once, app hidden when URL unset, order of sources,
   URL validation, merge carries `app_at`.
3. Vendor three.js r160 (`three.module.min.js` + LICENSE) under
   `free-pretzels/vendor/`, fetched from the npm registry tarball, checksum
   recorded in the PR.
4. `free-pretzels/pack3d.js`: pack geometry, materials, canvas textures,
   environment, carousel, rip halves, render loop, fallback detection.
5. `free-pretzels/packs.js` + `packs.css` + `index.html`: carousel step 0,
   hook the 3D pack into beats 1 to 3, bonus list with 3 bonuses and
   brand-safe slots for the official badges, fallback to CSS packs.
6. `/ops/qr`: App Store URL field + stats.
7. Validate: `npm test`, `tests/guardrails.sh`, `eval-report.sh`, reviewer
   subagent, visual check at 375 px and desktop on the local mock (beats
   timing table, swipe, reduced motion, no-WebGL fallback, game off, API
   down), frame-time sample on the mock.
8. Record in `.agent/`, commit, push to `agent/pretzel-packs`, update draft
   PR #27.

## Success criteria
- Quantitative: all tests pass; only scoped files change; function count
  unchanged (12); no new npm dependencies; three.js only via the vendored
  file; page weight added only when the game is on.
- Qualitative: on a phone the pack reads as an industrial gold foil pack
  with diamond plate (side by side with v1, clearly more real); swiping the
  carousel feels smooth and snaps; beats still land at 0 / 0.9 / 2.0 /
  2.5 / 3.3 / 6.0 s (within about 0.2 s); a 5th pretzel is impossible for
  the same email; with no WebGL or reduced motion the v1 CSS packs work;
  with the game off the page is the plain offer page.

## Risks + mitigations
- **Phone performance / battery:** loop stops when idle; low-fps detection
  drops shadows and pixel ratio; fallback to CSS packs.
- **Third-party trademarks:** official files only, supplied by the human;
  usage guidelines followed; text buttons until then.
- **Brand drift from 3D shading:** exception limited to the pack; human
  reviews screenshots in the PR before turning the game on.
- **Honor-system bonuses (Instagram, app):** once per player, capped.
- **New third-party code:** three.js MIT, vendored and pinned, licence
  file shipped, noted in the PR.

## Rollback / escalation
- Turn the game off in `/ops/qr` (no deploy).
- Code: `git revert` of the v2 commits returns to v1 (still working).
- Escalate on any need for a new function, `vercel.json`, `api/_lib/`, or
  an npm dependency.

## Human steps (CRITICAL, prepare only)
- Run `scripts/agent/approve-plan.sh` for this plan.
- Supply the official Instagram glyph and App Store badge files (SVG)
  into `free-pretzels/packs/` or tell the agent where they are.
- Give the App Store URL and the Instagram handle (set in `/ops/qr`).
- Plus all v1 human steps in PR #27 (migration, `PACKS_STAFF_PIN`, Gmail,
  Supabase smoke test, preview on a phone, deploy).
