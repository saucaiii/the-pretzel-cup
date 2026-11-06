# Working memory (short-term). Keep under 60 lines.
Branch: agent/qr-scan-redirect
Task: qr-control-panel (stacked on PR #26)
Status: built + verified locally; reviewer run; pushing to draft PR #26
Started: 2026-11-05 (plan approved 2026-11-06T02:15Z, hash b0e5a8d0)

## Progress
- api/_qr.js (new, underscore = not a function): offer/target validation,
  brand lint, Edge Config PATCH via REST, Redis history (20) + stats.
- api/leads.js: ?resource=offer|qr routed to _qr.js; lead paths unchanged.
- middleware.js: HINCRBY qr:scans:<NY day> <placement> in waitUntil,
  /scan self-loop rejected. 302 behaviour unchanged.
- ops/qr/index.html: redirect picker, offer editor + srcdoc phone
  preview, layouts green/black/gold-light, lint, schedule, QR studio
  (SVG/PNG, contrast gate), stats, history + restore. Nav: Growth.
- free-pretzels/index.html: brand fixes (tagline Made to Crave® white,
  72px top plate = 3 tile rows, cream removed, Caveat accent, +0.01em),
  live offer render, ended state, absolute logo path (was broken at
  /free-pretzels without trailing slash).
- assets/vendor/qrcode-generator.js 1.4.4 MIT, unmodified + LICENSE.
- Tests: npm test 116/116. guardrails.sh 106/0. Visual check at 375px
  and 1280px with a stdin mock server (X-Frame-Options DENY emulated).

## Not verified
- Anything on real Vercel: Edge Config REST write, Vercel-CDN-Cache-
  Control honoured, @upstash/redis inside edge middleware, middleware
  ESM in a non-module project. Needs a preview deploy.
- Generated QR codes were not scanned with a phone.
- eval-report scope signal "fail": plan lists scope as bullets, not a
  one-line **Scope:**. scope-check passes with the PR-body line.

## Next (human, CRITICAL: prepare only)
- Vercel token, EDGE_CONFIG_ID, EDGE_CONFIG_WRITE_TOKEN (+ VERCEL_TEAM_ID
  if team-owned), Edge Config store + seed, preview deploy, prod deploy.
  Exact steps are in the PR body.

## Handoffs
- implementer (this session) -> reviewer subagent: diff + plan.
  Result: pass with notes (all low). Accepted all 5 deliberate deviations.
- Guardrails now 101/5: .agent-control/failures.json is EMPTY (not {}),
  guardrails.sh tars it into its temp repo, on-failure.sh jq then fails.
  Root cause: context/environment issue (human-owned control file).
  Human fix: reset it to {} and rerun tests/guardrails.sh. Was 106/0
  earlier in this task with the same code.

## Retry log (qr-control-panel)
- npm pack inspect step failed: assumed package/LICENSE exists; the MIT
  licence is in the qrcode.js header + package.json. Root cause: tool
  misuse (wrong file assumption). Fix: read header/package.json instead.
- Mock server file write blocked by scope policy (scratchpad outside
  scope.txt). Root cause: tool misuse. Fix: ran the server from stdin,
  nothing written to disk.
