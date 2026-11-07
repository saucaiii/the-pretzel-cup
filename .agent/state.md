# Working memory (short-term). Keep under 60 lines.
Branch: agent/pretzel-redesign
Task: pretzel-redesign (make /free-pretzels as fun as the game, outside the rip)
Status: building
Started: 2026-11-06

## Context
- Started by session local_7433b014 (relays the user's picks). Plan drafted by the
  planner subagent in session local_a6387455, saved as .agent/plan.md. Risk medium,
  no approve-plan gate. scope.txt: free-pretzels/, .agent/.
- Base origin/main 18e87d6 (PR #29, #30 merged). Previous task notes are in git history.
- Defaults C1 to C6 in plan.md hold until the user says otherwise (stage black,
  procedural 3D foil).
- Brand guide PDF is internal: never commit or quote it. No Higgsfield generation
  without asking the user and naming the cost.

## Progress
- Step 1 memory: plan.md, this file, decisions appended.
- Step 2 assets: copied from the notes folder into free-pretzels/art/.
  golden-ticket-540/900 re-cropped from the original (old 900 clipped the top-right
  corner): ffmpeg crop=2688:1314:0:90, scale, cwebp -q 78 -m 6.

## Next
- Steps 3 to 9, one commit each. Step 10 validation with a mock server outside the
  repo (scratchpad), screenshots 375 px and 1280 px.

## Handoffs
- (none yet)
