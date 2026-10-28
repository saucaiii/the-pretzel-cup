#!/usr/bin/env node
// Batch per-store print-kit generator.
//
// Loads env from .env, queries Supabase (service role) for stores +
// each route's primary driver + driver stats, builds a personalized
// URL per store, and uses headless Chrome to print each one to a PDF
// at:
//   /Users/chris/Desktop/Philly Pretzel Factory/Store Print Kits/
//
// Naming matches Chris's existing convention:
//   <ROUTE>_<stop_order:02>_<store_name_cleaned>.pdf
//
// Run with:
//   cd ~/pretzel-cup
//   node --env-file=.env scripts/gen-print-kits.mjs
//
// Flags:
//   --full          include barcodes + pricing card (for new stores)
//   --only=<slug>   only generate the given store (store_code_norm or slug)
//   --dry           print URLs + filenames but don't actually run Chrome
//
// Prereqs: Chrome at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome

import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import { mkdirSync } from 'fs';

const BASE   = 'https://the-pretzel-cup.vercel.app';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = '/Users/chris/Desktop/Philly Pretzel Factory/Store Print Kits';

const args = process.argv.slice(2);
const FULL = args.includes('--full');
const DRY  = args.includes('--dry');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').slice(7).toUpperCase().replace(/[^A-Z0-9]/g, '');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function cleanName(s) {
  return String(s || '')
    .replace(/[—–]/g, '_')     // em/en dash → underscore
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}
function slugFor(s) {
  return s.store_code_norm || `${s.route_key}${String(s.stop_order).padStart(2, '0')}`;
}

async function loadDriverStats(id) {
  const { data, error } = await sb
    .from('returns').select('for_date,sold_singles,sold_doubles')
    .eq('submitted_by', id);
  if (error) throw error;
  let pretzels = 0, firstDate = null;
  for (const r of (data || [])) {
    pretzels += (r.sold_singles || 0) + (r.sold_doubles || 0);
    if (r.for_date && (!firstDate || r.for_date < firstDate)) firstDate = r.for_date;
  }
  const years = firstDate
    ? +(((Date.now() - new Date(firstDate + 'T00:00:00Z').getTime()) / (365 * 24 * 60 * 60 * 1000)).toFixed(1))
    : 0;
  return { years, delivered: pretzels };
}

function printPdf(url, outPath) {
  return new Promise((resolve, reject) => {
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
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`chrome exit ${code}: ${stderr.slice(0, 300)}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('→ Loading stops…');
  const { data: stops, error: se } = await sb
    .from('stops')
    .select('id,name,town,route_key,stop_order,store_code,store_code_norm,store_display_name')
    .eq('active', true)
    .order('route_key').order('stop_order');
  if (se) throw se;

  console.log('→ Loading routes + primary drivers…');
  const { data: routes, error: re } = await sb
    .from('routes').select('key,primary_driver_id');
  if (re) throw re;

  const driverIds = [...new Set(routes.map(r => r.primary_driver_id).filter(Boolean))];
  let driverNames = {};
  if (driverIds.length) {
    const { data: people, error: pe } = await sb
      .from('people').select('id,name').in('id', driverIds);
    if (pe) throw pe;
    driverNames = Object.fromEntries(people.map(p => [p.id, p.name]));
  }
  const routePrimary = Object.fromEntries(routes.map(r => [r.key, r.primary_driver_id]));

  console.log('→ Computing driver stats…');
  const driverStats = {};
  for (const id of driverIds) {
    driverStats[id] = await loadDriverStats(id);
    console.log(`    ${driverNames[id]}: ${driverStats[id].years} yrs · ${driverStats[id].delivered.toLocaleString()} pretzels`);
  }

  // Apply --only filter if given
  const picked = ONLY
    ? stops.filter(s => slugFor(s).toUpperCase().replace(/[^A-Z0-9]/g, '') === ONLY)
    : stops;
  if (ONLY && picked.length === 0) {
    console.error(`--only=${ONLY}: no match. Available slugs:`,
      stops.map(s => slugFor(s)).join(', '));
    process.exit(1);
  }

  console.log(`→ ${picked.length} store${picked.length === 1 ? '' : 's'} to print${FULL ? ' (full: +barcodes +pricing)' : ''}${DRY ? ' (DRY RUN)' : ''}\n`);

  let ok = 0, fail = 0;
  for (const s of picked) {
    const slug = slugFor(s);
    const name = s.store_display_name || `${s.name} — ${s.town}`;
    const primaryId = routePrimary[s.route_key];
    const driver = primaryId ? (driverNames[primaryId] || '') : '';
    const stats = primaryId ? (driverStats[primaryId] || {}) : {};

    const q = new URLSearchParams({
      store: slug,
      name,
      route: s.route_key,
      driver,
      years: String(stats.years || ''),
      delivered: String(stats.delivered || ''),
    });
    if (FULL) q.set('full', '1');

    const url = `${BASE}/onboarding-kit/print-bundle?${q.toString()}`;
    const fname = `${s.route_key}_${String(s.stop_order).padStart(2, '0')}_${cleanName(s.name)}.pdf`;
    const outPath = `${OUT_DIR}/${fname}`;

    const stamp = `[${String(ok + fail + 1).padStart(2, ' ')}/${picked.length}] ${s.route_key} #${String(s.stop_order).padStart(2, '0')} · ${s.name}`;
    if (DRY) {
      console.log(`${stamp}\n    url: ${url}\n    out: ${outPath}\n`);
      ok++;
      continue;
    }
    try {
      await printPdf(url, outPath);
      console.log(`${stamp} ✓ ${fname}`);
      ok++;
    } catch (err) {
      console.error(`${stamp} ✗ ${err.message}`);
      fail++;
    }
  }

  console.log(`\n→ Done: ${ok} ok, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
