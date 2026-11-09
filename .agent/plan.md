# Split /ops/qr into two tabs — QR and Referral

Branch: `claude/ops-qr-split-d81b8e` (off `main`)
Risk: Medium — a single frontend ops page. No `api/_lib/`, no `api/*`, no
migrations, no `vercel.json`, no workflows, no auth/secrets, no money.
Scope: ops/qr/index.html

## Goal

`ops/qr/index.html` is 965 lines of seven stacked panels covering two
unrelated operator jobs: managing the window-sticker `/scan` destination and
the QR studio, and configuring the `/free-pretzels` pack game. Split them
into two tabs so each operator role sees only their own controls, keep a
small shared status strip above the tabs for the two facts both roles want
at a glance (current `/scan` destination; game on/off + start date), and
remember the chosen tab in `localStorage`.

Pure UI reorganisation. No endpoint, no backend, no payload changes.

## Layout after the rebuild

Shared strip (always visible, above the tabs):
- `/scan` destination now
- Pack game on/off + start date

Tab 1 — QR (sticker + scan destination):
- §1 Where the sticker goes (/scan destination picker)
- §4 QR studio (placement name, colours, SVG/PNG download)
- §5 Scans by placement
- §7 History

Tab 2 — Referral (the /free-pretzels pack game):
- §2 Free pretzel offer (headline, accent, stamp, details, steps, fine
  print, hero colour, schedule, game toggle, Instagram handle, Golden
  Ticket block) + phone preview + brand-voice lint
- §6 Pack game funnel stats

The section numbers inside panel headings are dropped; numbering is a relic
of the single-column stack.

## Segmented control

- Two buttons in `role="tablist"` row above the panels.
- `aria-selected` reflects the active tab. Keyboard: left/right/up/down
  arrows between the two buttons, Home/End for ends — mirrors the
  wholesale-page pattern.
- `localStorage['ops.qr.tab']` holds `'qr'` or `'referral'`. On load:
  1. If `location.hash` is `#qr` or `#referral`, use it.
  2. Else read localStorage.
  3. Else default to `'qr'`.
- Both `localStorage` and `location.hash` are updated on each change so a
  link can land on a tab and a refresh keeps you where you were.
- Under ~520px the two tabs become full-width stacked buttons.

## What stays identical

- Every API call: `GET api/leads?resource=qr&view=config|stats|history`,
  `POST api/leads?resource=qr` with `{action: set_target|reset_target|
  publish_offer|restore, ...}`, `GET api/leads?resource=packs&view=stats`.
- /free-pretzels phone preview (iframe `srcdoc` with injected `<base>` and
  `window.__OFFER_PREVIEW__ = true`, postMessage handshake).
- Edge Config readable/writable notice.
- "Reset to /free-pretzels" confirm.
- Disabled-when-not-writable states on Save / Reset / Publish / Restore.
- Lint rules, counts, layout tagline note, bonus requires-Instagram warn.
- QR SVG generation, contrast check, SVG/PNG download.
- Brand palette, square corners, no shadows, no new dependencies.

The shared strip is read-only (no inputs). Its numbers come from the same
`/config` fetch that fills the tab panels — no extra request.

## Success criteria

Quantitative
- Only `ops/qr/index.html` changes (`scripts/agent/scope-check.sh` passes).
- `node --check` on extracted inline JS passes.
- Tabs render; segmented control switches which panel group is visible;
  active tab is persisted in `localStorage['ops.qr.tab']` and restored on
  reload.
- Every existing control fires the same API call it fired before (grep
  confirms no `fetch(...)` URL changed).
- Edge Config readable/writable notice behaves the same.

Qualitative
- An operator managing stickers sees sticker controls only. Someone tuning
  the pack game sees the offer editor and funnel only.
- Shared strip answers "what's live right now" without a scroll.
- Mobile: both tabs reachable with a thumb, no zoom.

## Risks + mitigations

- Preview iframe reconnects when hidden. The offer editor lives on tab 2;
  switching to tab 1 hides the panel with `display:none`. `display:none`
  does not tear down an iframe; the postMessage handshake survives.
  Mitigation: toggle visibility at the panel level via a class on the
  tabs-root container, not around the iframe itself.
- `localStorage` read failure in private windows. Wrap read/write in
  try/catch; fall back to the URL hash and then to the default.
- Tab state out of sync with URL. Treat hash as truth on load; after that,
  write both together on every change.
- CI scope-check — the plan's `Scope:` line lists only `ops/qr/index.html`;
  any accidental edit elsewhere trips the check.

## Rollback / escalation

- Revert the single merge commit. No server-side state is persisted by this
  change.
- If a late-discovered bug surfaces in the offer preview, a one-line CSS
  tweak can short-circuit the segmented control to show both panels until
  a proper fix lands.
