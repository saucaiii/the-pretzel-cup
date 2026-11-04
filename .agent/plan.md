# Plan — PDF invoice branding pass

## Risk
**HIGH.** Edits `api/_lib/invoice-pdf.js` (plan-first per
`.agent-policy/policy.sh`). Visual-only — no schema change, no change
to the send flow, no new serverless function, no env, no secret. Live
sends remain env-gated (`EMAIL_SEND_LIVE_ENABLED=true`).

## Goal
The customer's invoice PDF carries recognizable Pretzels of Long
Island / Philly Pretzel Factory branding: logo at the top-left and
PPF-green / cream accents on the structural rules. Layout, numbering,
and MIME flow all stay as-is — this is a styling pass on top of the
existing renderer.

## Scope (files, worktree-relative)
- `.agent/plan.md`, `.agent/state.md`, `.agent/decisions.md`
- `api/_lib/invoice-pdf.js`                                   (modify)
- `api/_lib/invoice-logo.jpg`                                 (new — copy of ppf-logo.jpg co-located with the renderer so Vercel's file tracer picks it up at deploy time)

**No changes to** `.claude/`, `.agent-policy/`, `.agent-control/`,
`.env*`, `vercel.json`, `supabase/migrations/`, `api/_lib/gmail.js`,
`api/wholesale/invoice.js`, `ops/wholesale/index.html`, or
`docs/wholesale.md`.

## Steps
1. **Co-locate the logo.** Copy `ppf-logo.jpg` (repo root, 1938×1725
   JPEG, ~284 KB) to `api/_lib/invoice-logo.jpg`. Keeps the require
   path statically resolvable from the renderer (`path.join(__dirname,
   'invoice-logo.jpg')`), which Vercel's `@vercel/nft` tracer needs
   to include the asset in the function bundle. No change to
   `vercel.json` required.
2. **Render the logo.** In `renderInvoicePdf`, before the header text,
   `doc.image(LOGO_PATH, M, M, { fit: [60, 60] })`. Shift the store
   name + address + phone 72 pt to the right of the logo so the
   header reads as a lockup. Fallback: if the logo file can't be read
   at module load, fall through to today's text-only header (fresh
   deploys that haven't tracked the asset yet don't 500).
3. **PPF-green accent rule.** Replace the plain 0.5 pt rule under the
   header with a 1.0 pt rule in PPF green (`#0D5237`).
4. **Cream header band on the items table.** Fill a cream
   (`#FAF4E1`) rectangle the full table width behind the QUANTITY /
   DATE PERFORMED / UNIT PRICE / TOTAL row, with PPF-green text.
5. **TOTAL emphasis.** Make the TOTAL row 11 pt (up from 10), bold,
   PPF-green text. SUBTOTAL / DISCOUNT / SALES TAX stay 10 pt black.
6. **Decision-log entry.** Append to `.agent/decisions.md`:
   `- 2026-11-04 | co-locate invoice-logo.jpg under api/_lib/ with
     synchronous fs.readFileSync at module load | @vercel/nft traces
     this pattern reliably; keeps vercel.json untouched | rejected
     repo-root path + includeFiles (requires vercel.json edit),
     base64-inline (bloats the JS file by ~380 KB) | review-by
     2027-11-04`.

## Success criteria

### Quantitative
- `node -e "require('./api/_lib/invoice-pdf').renderInvoicePdf({ order: FIXTURE, customer: FIXTURE, invoiceNumber: 5001, invoiceDate: new Date() }).then(b => { if (!b.slice(0,5).toString().startsWith('%PDF-')) process.exit(1); console.log('ok size=' + b.length); })"` succeeds — PDF still renders, size grows ~280 KB (JPEG embedded).
- `node --check api/_lib/invoice-pdf.js` clean.
- CI passes (plan-gate, scope-check, agent-conflicts, test, CodeQL).
- No new code-scanning alerts.

### Qualitative
- The PDF opens with the PPF logo at top-left, store name + address + phone to its right, a PPF-green rule under, a cream header band on the items table, and a prominent green TOTAL line.
- Layout is still single-page for a typical 1–4 item order.
- `EMAIL_SEND_LIVE_ENABLED` unset path still refuses live sends.

## Risks + mitigations
- **Vercel function bundle misses the logo.** `path.join(__dirname,
  'invoice-logo.jpg')` with `fs.readFileSync` at module load is
  statically analyzable by `@vercel/nft`; this is the recommended
  pattern. The renderer catches a missing-file error at load time
  and falls back to text-only so a deploy regression doesn't 500 the
  invoice modal.
- **PDF size jumps ~140×.** 280 KB email attachment is well under
  Gmail's 25 MB cap and Vercel's response-body limit; no concern.
- **Logo quality.** Source is 1938×1725, rendered at 60×60 pt →
  pdfkit downscales smoothly; no pixelation at print scale.
- **Color accessibility.** PPF green on cream has contrast ratio
  > 7:1 (AAA); PPF green on white > 9:1. Fine for any reader.

## Rollback
- Revert the PR → Vercel redeploys previous SHA.
- No schema change, no env change. Pure code.

## Escalation
- `@vercel/nft` fails to pick up the logo at deploy (customer
  invoices suddenly render text-only in prod) → the module-load
  fallback keeps the feature working; file a follow-up to switch to
  `vercel.json` `includeFiles` config and ship behind the fallback.
