#!/usr/bin/env node
// Standalone route-pitch packet PDF generator.
//
// Renders pitch-kit/print-bundle.html through headless Chrome and
// writes the 6-page PDF to pitch-kit/pdfs/route-pitch.pdf.
//
// Unlike scripts/gen-print-kits.mjs (per-store fan-out that needs
// Supabase), this one is generic — one PDF, no personalization — so
// it needs no env vars. The route-pitch packet is the same for every
// prospect.
//
// Usage:
//   node scripts/gen-pitch-pdf.mjs
//
// Flags:
//   --base=<url>    override the base URL (default:
//                   https://the-pretzel-cup.vercel.app). Pass a local
//                   http://127.0.0.1:... to render from a dev server.
//   --out=<path>    override the output path (default:
//                   pitch-kit/pdfs/route-pitch.pdf).
//   --dry           print URL + output path, do not run Chrome.
//
// Prereqs: Chrome at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome.

import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = flag('base', 'https://the-pretzel-cup.vercel.app').replace(/\/+$/, '');
const OUT  = resolve(flag('out', 'pitch-kit/pdfs/route-pitch.pdf'));
const DRY  = args.includes('--dry');

const url = `${BASE}/pitch-kit/print-bundle.html`;

function printPdf(url, outPath) {
  return new Promise((ok, fail) => {
    const child = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-pdf-header-footer',
      `--print-to-pdf=${outPath}`,
      '--virtual-time-budget=20000',
      '--run-all-compositor-stages-before-draw',
      '--window-size=1200,900',
      url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code === 0) ok();
      else fail(new Error(`chrome exit ${code}: ${stderr.slice(0, 300)}`));
    });
    child.on('error', fail);
  });
}

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  console.log(`→ Rendering ${url}`);
  console.log(`→ Output:    ${OUT}${DRY ? ' (DRY RUN)' : ''}`);
  if (DRY) return;
  await printPdf(url, OUT);
  console.log('✓ Done');
}

main().catch(e => { console.error(e); process.exit(1); });
