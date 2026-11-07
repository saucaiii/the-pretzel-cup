# Working memory (short-term). Keep under 60 lines.
Branch: agent/pretzel-redesign
Task: pretzel-redesign (make /free-pretzels as fun as the game, outside the rip)
Status: review fixed, opening draft PR
Started: 2026-11-06

## Context
- Started by session local_7433b014. Plan in .agent/plan.md (medium, no gate).
  scope.txt: free-pretzels/, .agent/. Base origin/main 18e87d6.
- USER (directly, mid-task): follow their mockup pretzel_site_mockup_three_directions.html
  (A word wall, B factory floor quest map, C collector's binder) closely, mix in the
  Higgsfield art and some of the agent's take, do NOT touch the pack ripping, and no
  fixes they did not ask for. Recorded in decisions.md.
- Brand guide PDF is internal: never commit or quote it.

## Progress (commits on this branch)
- Memory + plan; art copied (ticket re-cropped so no corner clips).
- Tokens, Rock Salt, reduced-motion block.
- Hero + welcome popup = mockup A (plate strip, logo, tilted word wall, CRAVE lit,
  copy line, "Rip your free pack" with foil pack, "every pack wins").
- Food band (earlier take): real pretzel + rivet photos breaking out of plate frames.
- Quest map (mockup B) REMOVED 2026-11-07 at the user's request.
- Binder = mockup C (Your set, N of 4, tilted gold cards, empty slots reopen the
  quest, Golden Ticket card with ticket art, shimmer once on win).
- Offer/claim/stores restyled (12px radius gold cards); rip stage buttons unchanged.

## Not done on purpose (rip beats untouched)
- Plan step 9 ticket art on the stage's .st-ticket face, and C6 foil photo on the
  no-WebGL fallback packs: both are inside the carousel/rip experience.

## Validation (mock server in scratchpad runs the real api/_packs.js)
- Full loop at 375: first, IG, email link, app, trade, ticket shimmer, staff redeem,
  stop at 3, keep, skip + resume. 1280: hero, popup, binder, map. /ops/qr srcdoc ok.
- npm test 187/187; guardrails 106/0; eval-report pass; id check 83 ids ok.
- Not verified: reduced motion (pane cannot emulate it), no-WebGL fallback, real phones.

## Review (reviewer subagent, 2026-11-06): not ready -> fixed
- F1 global button hover leaked into #stage buttons: stage override made more specific.
- F2 "Complete the set" shown at 4 of 4: now "Set complete. Keep or trade?", and the
  slot only shows while the ticket pack is on offer (no unearnable ticket).
- F3 step popup restyled without a request: reverted to the live look (only .ww-card new).
- F5 ticket code on art: flat gold-light pill. F6 shimmer: once per ticket per device,
  never on a used ticket. F7 recorded in decisions.md.
- Accepted: F4 reduced-motion block also makes the carousel's 0.2s scale instant;
  F8 logos sit on a 0.16-alpha glow (clear space kept). Code scanning not checked.

## User changes 2026-11-07 (done)
- Win card + step popup on the new theme; win card has one CTA to the next pretzel
  with pips and "N more to the Golden Ticket" (rip beats unchanged).
- Dog + rivet cup are cutouts on plate frames; ticket text has no pill.
- Map dropped; binder shows Collected (tick) vs Open (action, tap to unlock), no
  flavour words; food band side photos = pretzel dog + cinnamon rivets cup.

## Retries
- npm test 71/73: context/environment issue (no node_modules). npm ci --ignore-scripts.
- one-liner exit 1: tool misuse (zsh `echo ===`). Ran eval-report on its own.
- image-branch push exit 128: tool misuse (git mktree input lost its tab inside a shell
  variable). Change before retry: build the mktree input with printf per line.
