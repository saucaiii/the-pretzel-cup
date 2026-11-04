# Working memory (short-term). Keep under 60 lines. Prune when a task closes.
Branch: claude/wholesale-invoice-pdf-f264f2
Task: Attach server-generated PDF invoice to the wholesale invoice email.

## Progress
- Scope widened, plan approved 2026-11-04.
- P16 migration written. Supabase MCP apply_migration denied by auto-mode;
  SQL is committed and will apply on the human's next migration run.
  Idempotent (`if not exists`, partial unique index, `create or replace
  function`).
- pdfkit 0.15.2 added to package.json + lockfile (`npm install` clean,
  0 vulnerabilities).
- `api/_lib/invoice-pdf.js` written (renderInvoicePdf → Promise<Buffer>).
  Letter page, built-in Helvetica, header + invoice-no row + two-column
  Bill-To/Store-Address + items table + totals. Local-date parser for
  `YYYY-MM-DD` to avoid UTC-midnight tz flip. Smoke: produces valid
  %PDF-1.3, ~2 KB.
- `api/_lib/gmail.js` upgraded to multipart/mixed when `attachments[]`
  is non-empty; empty/default path emits multipart/alternative with the
  same shape as before (only the random boundary name prefix changed,
  not the structure). `__test_buildRaw` added for deterministic smoke.
- `api/wholesale/invoice.js` wired via `assign_invoice_number` RPC
  (atomic CAS + COALESCE allocation); dry-run returns
  `rendered_pdf_base64` (DRAFT number unless row was already invoiced),
  live attaches the PDF. Send-failure rollback preserves
  `invoice_number` so retries reuse it (no duplicate numbers).
- `ops/wholesale/index.html`: Download-PDF button in invoice modal,
  disabled until dry-run lands; click → base64 → Blob → download.
- `docs/wholesale.md` updated: PDF section, P16 entry, rollback.
- All three Node modules pass `node --check`; static smokes pass
  (PDF magic bytes, no-att alternative, with-att mixed+disposition+
  filename, formatters).

## Review 2026-11-04
Verdict: pass (with LOW nits; fixes committed in this task)
Quantitative: tests fail (no runner configured — expected), scope fail
  (plan.md heading lacks colon; PR body carries **Scope:** line for
  plan-gate CI), new alerts 0 (CodeQL unchecked locally; no new
  patterns introduced).
Intent: met. CAS via single-UPDATE RPC serialises concurrent sends;
  retry reuses invoice_number via COALESCE; no-attachment MIME path
  is structurally identical (byte-equal with fixed boundaries);
  filename and PDF-text sanitation in place; dashboard download uses
  sandboxed iframe + revoked Blob URL.
Unexpected files: none.
Findings addressed:
  - LOW 1: pdf_error sanitised — fixed message, pdfkit internals go
    to console.error only.
  - LOW 3: __test_buildRaw is a passthrough when _fixedBoundaries is
    absent; no global Math.random mutation in the hot path.
  - INFO 3: gmail.js comment softened — "structurally identical",
    not "byte-for-byte".
Deferred:
  - LOW 2 (preview-date vs send-date): intended UX — preview shows
    today, live send stamps actual send day. Docs note added.
  - LOW 4 (items-table pagination beyond ~55 rows): not a real-world
    concern today; captured as follow-up.
  - INFO 1 (scope-check regex vs plan.md heading): PR body carries
    the labelled **Scope:** line; follow-up to teach scope-check.sh
    to accept markdown-header form too.
  - INFO 4 (rollback UPDATE not inspected): pre-existing pattern in
    the codebase, not introduced here.

## Failures and root causes
- Supabase `apply_migration` tool refused by the auto-mode classifier.
  Classified: tool misuse (restricted capability in this env). Fix:
  skip dev-DB apply, rely on committed SQL; human runs the migration.
  No code impact.

## Handoff — needs human
1. Review the branch; open draft PR with the labeled fields (Risk /
   Goal / Scope / Success criteria / Rollback) in the body for the
   plan-gate CI.
2. Apply `supabase/migrations/p16_wholesale_invoice_number.sql` to
   the dev DB before any live-send test (RPC must exist).
3. In dev, dry-run a *Mark invoiced* on a wholesale order: confirm
   HTML preview AND Download-PDF button both work.
4. Never un-draft from this agent.
