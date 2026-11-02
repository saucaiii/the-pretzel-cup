#!/usr/bin/env node
// Imports store-manager contact info from the local macOS Contacts app
// into public.stops.
//
// Match key: Contacts "Organization" field (e.g. "711 VS") equals the
// stop's `name` column exactly. Writes manager_first_name,
// manager_last_name, and manager_phone (whichever are present).
// manager_email is left alone — collect those via /ops/onboard.
//
// Local-only: reads Contacts via osascript, so this runs on the Mac,
// never on Vercel. Mac must have granted this terminal access to the
// Contacts app (System Settings → Privacy & Security → Contacts).
//
// Run with:
//   cd ~/pretzel-cup
//   node --env-file=.env scripts/import-store-contacts.mjs            # dry run (default)
//   node --env-file=.env scripts/import-store-contacts.mjs --apply    # actually write

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ─── Pull Contacts via AppleScript ────────────────────────────────
// Delimiter choices avoid collision with phone numbers and names.
const OSA = String.raw`
tell application "Contacts"
  set out to ""
  set theList to every person whose organization contains "711"
  repeat with p in theList
    try
      set fn to first name of p
    on error
      set fn to ""
    end try
    try
      set ln to last name of p
    on error
      set ln to ""
    end try
    try
      set org to organization of p
    on error
      set org to ""
    end try
    set phoneStr to ""
    try
      repeat with ph in (every phone of p)
        set phoneStr to phoneStr & (value of ph) & "~"
      end repeat
    end try
    set out to out & org & "||" & fn & "||" & ln & "||" & phoneStr & linefeed
  end repeat
  return out
end tell
`;

const osa = spawnSync('osascript', ['-e', OSA], { encoding: 'utf8' });
if (osa.status !== 0) {
  console.error('osascript failed:', osa.stderr || osa.error);
  process.exit(1);
}

function clean(s) {
  return String(s ?? '').replace(/missing value/g, '').trim();
}
function firstPhone(s) {
  const first = clean(s).split('~').map(x => x.trim()).filter(Boolean)[0] || '';
  return first || null;
}

const rows = osa.stdout
  .split('\n')
  .map(l => l.trim())
  .filter(Boolean)
  .map(line => {
    const [org, fn, ln, phones] = line.split('||');
    let first = clean(fn) || null;
    let last  = clean(ln) || null;
    // Contacts entry style: a full name typed into the First Name field
    // with no Last Name set ("Kishan Patel" → first="Kishan", last="Patel").
    if (first && !last && first.includes(' ')) {
      const parts = first.split(/\s+/);
      first = parts.shift();
      last  = parts.join(' ');
    }
    return {
      org:   clean(org),
      first,
      last,
      phone: firstPhone(phones),
    };
  })
  .filter(r => r.org.startsWith('711 '));

// Dedupe on org — if the same org appears twice, keep the first with a phone,
// else just the first.
const byOrg = new Map();
for (const r of rows) {
  const prev = byOrg.get(r.org);
  if (!prev || (!prev.phone && r.phone)) byOrg.set(r.org, r);
}
const contacts = [...byOrg.values()];

if (contacts.length === 0) {
  console.log('No "711 ___" organization entries found in Contacts.');
  process.exit(0);
}

// ─── Load matching stops ──────────────────────────────────────────
const { data: stops, error: stopsErr } = await sb
  .from('stops')
  .select('id, name, town, route_key, manager_first_name, manager_last_name, manager_phone')
  .in('name', contacts.map(c => c.org));

if (stopsErr) {
  console.error('Supabase stops query failed:', stopsErr.message);
  process.exit(1);
}

const stopByName = new Map(stops.map(s => [s.name, s]));

// ─── Plan updates ─────────────────────────────────────────────────
const plan = [];
const unmatched = [];
for (const c of contacts) {
  const s = stopByName.get(c.org);
  if (!s) { unmatched.push(c); continue; }
  const patch = {};
  if (c.first && c.first !== s.manager_first_name) patch.manager_first_name = c.first;
  if (c.last  && c.last  !== s.manager_last_name ) patch.manager_last_name  = c.last;
  if (c.phone && c.phone !== s.manager_phone     ) patch.manager_phone      = c.phone;
  plan.push({ stop: s, contact: c, patch });
}

// ─── Report ───────────────────────────────────────────────────────
console.log(`Found ${contacts.length} unique 711-tagged contact(s). Matching against ${stops.length} stop(s).\n`);
for (const p of plan) {
  const name = [p.contact.first, p.contact.last].filter(Boolean).join(' ') || '(no name)';
  if (Object.keys(p.patch).length === 0) {
    console.log(`  ✓ ${p.stop.name.padEnd(14)} already up to date (${name})`);
  } else {
    const changes = Object.entries(p.patch).map(([k, v]) => `${k.replace(/^manager_/, '')}=${v}`).join(', ');
    console.log(`  ${APPLY ? '→' : '•'} ${p.stop.name.padEnd(14)} ${name.padEnd(22)} ${changes}`);
  }
}
if (unmatched.length) {
  console.log('\nUnmatched (no stop with that name):');
  for (const u of unmatched) console.log(`  - ${u.org}  (${[u.first, u.last].filter(Boolean).join(' ') || '(no name)'})`);
}

const toWrite = plan.filter(p => Object.keys(p.patch).length > 0);
if (!APPLY) {
  console.log(`\nDry run. ${toWrite.length} stop(s) would be updated. Re-run with --apply to write.`);
  process.exit(0);
}

// ─── Apply ────────────────────────────────────────────────────────
let ok = 0, fail = 0;
for (const p of toWrite) {
  const { error } = await sb.from('stops').update(p.patch).eq('id', p.stop.id);
  if (error) {
    console.error(`  ✗ ${p.stop.name}: ${error.message}`);
    fail++;
  } else {
    ok++;
  }
}
console.log(`\nApplied: ${ok} updated, ${fail} failed.`);
process.exit(fail ? 1 : 0);
