# Plan: pretzel-redesign (make /free-pretzels as fun as the game, outside the rip)
(Drafted by the planner subagent in session local_a6387455; save as .agent/plan.md. Base is origin/main 18e87d6, PR #29/#30 merged, so no stacking.)

Risk: **medium**. Operational medium (public page under `free-pretzels/`, every step revertible). Security low (no auth, secrets, api/, hooks, MCP, agent tools). Compliance medium-high (outward-facing franchise branding, AI-generated art, new third-party font). No path in the CLAUDE.md high table is touched. Deploying is **critical** and not part of this plan.

## Goal
Redesign every surface of /free-pretzels except the pack carousel and rip sequence: word-wall landing hero, factory-line quest map (Mix, Twist, Bake, Win) with a "you are here" marker, collector's binder for won vouchers ("3 of 4", empty slots show their quest, Golden Ticket as the shiny missing slot), real food photos breaking out of frames, and the new Higgsfield art (foil wrapper, diamond-plate spotlight, Golden Ticket image + shimmer MP4). The full game loop and every packs.js hook keep working.

## Scope
**Scope:** free-pretzels/index.html, free-pretzels/packs.css, free-pretzels/packs.js, free-pretzels/pack3d.js, free-pretzels/art/, .agent/
- packs.js: rendering only (`renderTrail`, `renderVouchers`, ticket video). No API, state or flow changes.
- pack3d.js: only if the user later says yes to C1/C6.
- Out of scope: api/, api/_lib/, vercel.json, supabase/migrations/, scripts/, tests/, ops/, and every guardrail folder (hooks, policy, control).

## Decisions so far (defaults until the user says otherwise)
- C1 Stage background: KEEP BLACK (decision 48). Green plate on quest map, binder, rest of page.
- C2 Word wall is both `.hero` (game off) and the `#g-pop` welcome card (game on); logo unaltered, clear space 12.5%, "Made to Crave®".
- C3 Golden Ticket = 5th gold "Ticket" node after Win, only when `bonus.on`.
- C4 No near-miss: after "Keep my 4" or stop at 3, hide the ticket slot; show "Set complete" / "Your set".
- C5 Photos: the user's real photos are already in the repo: `free-pretzels/packs/pretzel.webp` and `rivet-*.webp` (user sent them in chat). Use those; never AI food imagery.
- C6 3D pack: KEEP procedural foil. foil-pack.webp used on hero CTA pack, no-WebGL fallback packs, binder card backs.

## Steps (app works after each; one commit each)
1. Memory: state.md for this branch; append decisions (loosened brand rules; diamond plate anywhere, supersedes "top only" of decision 17; fonts Archivo Black, Montserrat, Caveat + Rock Salt (Apache 2.0) for "Salted"; C-item outcomes).
2. Assets into `free-pretzels/art/` from the notes folder `redesign-assets/`. Shimmer does not loop cleanly (first vs last frame PSNR 23.8 dB): play once, hold last frame.
3. Tokens and fonts: Rock Salt added to the Google Fonts link; `--glow --shadow-1/2 --radius --ease`; global reduced-motion block.
4. Word wall hero + welcome popup. CTA "Rip your free pack" (`#g-pop-go` text). Keep `#o-headline #o-accent #o-stamp #g-pop-title #g-pop-stamp` as real text; `body[data-layout]` still works.
5. Food photos breaking out of frames (tilted, overlapping) in hero and a food band.
6. Sections restyle (offer, claim, locations, footer): rounded cards, soft shadows, plate accents, gradients on decorative layers only; keep offer-script ids; text AA on flat colour.
7. Factory line (`renderTrail`): Mix, Twist, Bake, Win (+ Ticket), "you are here" marker, aria-labels keep both meanings, keep "Every pack wins."
8. Binder (`renderVouchers`): "N of 4" header, won cards keep code + "Staff: redeem", empty slots show quest and reopen via the existing `#q-resume` path, ticket slot per C4, decisions 46/47 respected.
9. Golden Ticket art on ticket vcard and `.st-ticket` face, text in HTML (image is tilted about -6deg); shimmer MP4 `muted playsinline preload=none` + poster, reduced motion = poster only. Rip beats unchanged.
10. Validate: `npm test`, id check, local mock loop at 375 px and 1280 px, reduced motion, no-WebGL, `tests/guardrails.sh`, `scripts/agent/eval-report.sh`, reviewer subagent, draft PR.

## Success criteria
- `npm test` all pass (tests don't cover the page HTML). Diff only inside Scope. Id check: every id read by packs.js and the inline offer script exists once in index.html. No gambling words in UI copy (odds, chance, luck, risk, hurry, countdown). `free-pretzels/art/` 2 MB or less; first-load extra (excl. lazy MP4) 700 KB or less.
- Local mock, 375 px + desktop: full loop (first pack, IG, email link, app, trade with ticket art + shimmer, keep, stop at 3, skip + resume, staff redeem); binder 1 of 4 to 4 of 4; marker moves Mix to Win; word wall shows CRAVE lit with unaltered logo and ®; reduced motion only fades; /ops/qr srcdoc preview still renders.

## Risks + mitigations
- Broken hooks: keep all ids and `.pick/.pk*`, `#stage .st-*`; id check + full loop after Steps 4, 7, 8.
- Brand departure without corporate sign-off: decision recorded, PR flags it; logo and ® unaltered.
- Weight: budgets above, lazy video, srcset, decoding=async.
- Contrast: text on flat colour only. Hobby cap: no new endpoints.

## Rollback / escalation
`git revert <sha>` per step. Escalate on any need for non-rendering logic in packs.js, any need to touch api/, scripts/ or vercel.json, or a check failing after 2 changed retries.
