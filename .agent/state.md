# Working memory (short-term). Keep under 60 lines.
Branch: agent/qr-scan-redirect
Task: qr-scan-redirect
Status: code done, draft PR open; CRITICAL steps handed to human
Started: 2026-11-05

## Progress
- middleware.js (root, matcher /scan only): Edge Config scan_target,
  800ms timeout, fallback /free-pretzels, query passthrough, UTM for
  own site, 302 + no-store, qr_scan analytics event via waitUntil.
- tests/scan-redirect.test.mjs: 20/20 pass (node --test). Covers the
  no-EDGE_CONFIG fallback path, bad targets, UTM, passthrough.
- free-pretzels/index.html + resized logo: visual-checked at 375px,
  no horizontal scroll. Offer, redemption, fine print are placeholders.
- tests/guardrails.sh: 106 passed, 0 failed.

## Not verified
- Middleware on real Vercel (ESM middleware.js in a non-"type: module"
  project; Edge Config read; analytics event). Needs a preview deploy.
- The timeout path (Edge Config hanging) is not unit-tested.
- Whether Web Analytics is enabled on the project (MCP lacked team
  scope for get_project).

## Next (human, CRITICAL: prepare only)
- Create Edge Config store, connect to the-pretzel-cup (adds the
  EDGE_CONFIG env var), add item scan_target = "/free-pretzels".
- Enable Web Analytics if off. Preview deploy, test /scan, then prod.

## Handoffs
- (agent -> agent: input, output, result)
