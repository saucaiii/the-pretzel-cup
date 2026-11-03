#!/usr/bin/env node
// Seed script for the wholesale ordering stack (P14).
//
// Idempotent. Safe to run multiple times:
//   - products: upsert on sku
//   - campaigns: upsert on slug
//   - campaign emails: upsert on (campaign_id, position)
//   - customers: upsert on email (citext → case-insensitive dedupe)
//
// Reads customers live from the wholesale lead-form sheet. Service
// account (same creds as GOOGLE_SHEET_KEY_B64 used by _lib/sheet.js)
// must have Viewer access to the sheet. Grant via Sheet → Share →
// paste client_email from the key JSON → Viewer.
//
// Run with (from repo root):
//   node --env-file=.env scripts/seed-wholesale.mjs            # dry run
//   node --env-file=.env scripts/seed-wholesale.mjs --apply    # actually write
//
// Required env:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_SHEET_KEY_B64   (base64 service account JSON; same as _lib/sheet.js)
//
// Privacy: customer emails and names never printed. Counts only.

import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';

const APPLY = process.argv.includes('--apply');

for (const v of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GOOGLE_SHEET_KEY_B64']) {
  if (!process.env[v]) {
    console.error(`${v} must be set in .env`);
    process.exit(1);
  }
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ─── Static content: products ──────────────────────────────────────
const PRODUCTS = [
  { sku: 'pretzel-unwrapped', name: 'Pretzel (unwrapped)', unit_price_cents:   90 },
  { sku: 'pretzel-wrapped',   name: 'Wrapped Pretzel',     unit_price_cents:  110 },
  { sku: 'twist-wrapped',     name: 'Wrapped Twist',       unit_price_cents:  120 },
  { sku: 'dip-small',         name: 'Small Dip',           unit_price_cents:   60 },
  { sku: 'dip-large',         name: 'Large Dip',           unit_price_cents:  300 },
  { sku: 'rivet-shaker',      name: 'Rivet Shaker',        unit_price_cents:  200 },
  { sku: 'rivet-tray-small',  name: 'Small Rivet Tray',    unit_price_cents: 3000 },
];

// ─── Static content: campaign + 6 nurture emails ───────────────────
const CAMPAIGN = {
  slug: 'winter-2026-27',
  name: 'Winter Nurture — Made to Crave',
  starts_on: '2026-12-01',
  ends_on:   '2027-02-28',
};

const EMAILS = [
  {
    position: 1,
    send_date: '2026-12-01',
    promo_code: 'HOLIDAY25',
    cta_src: 'winter26-e1-holiday25',
    cta_label: 'Reserve a date',
    subject: 'HOLIDAY25 is live. Bring your cravings.',
    preheader: 'Buy 100 pretzels, get 25 free. Through Jan 4.',
    body_md:
`Hi {{first_name}},

New season, same craving.

HOLIDAY25 opens today. Order 100 pretzels for {{organization}} and 25 come free. No tiers, no fine print, no limit on how many times you use it. End-of-term parties, holiday assemblies, staff lunches, concession runs. Crave it, book it, share it.

Flour, water, yeast and salt. Hand-twisted that morning at {{pickup_location}} ({{pickup_address}}).

Code runs through **Sunday January 4**, so it covers you from first-week-of-December right through the first school day back. The weeks before winter break fill up fast on our end, so lock in your dates early.

**Use code HOLIDAY25.**

Thanks for keeping Philly Pretzel Factory on the menu at {{organization}}.

*Made to Crave®*
`,
  },
  {
    position: 2,
    send_date: '2026-12-14',
    promo_code: 'HOLIDAY25',
    cta_src: 'winter26-e2-holiday25',
    cta_label: 'Place an order',
    subject: 'Last-week-of-term parties? HOLIDAY25 has you.',
    preheader: 'Crave big, snack bigger. Code still live.',
    body_md:
`Hi {{first_name}},

The last week before winter break is a blur. Grade-level parties, staff lunches, holiday assemblies, concert nights. HOLIDAY25 is built for exactly this.

**100 pretzels, 25 free, code HOLIDAY25.** Hot, salted, fresh-twisted that morning.

To turn a last-minute order fast, send us:
- {{pickup_location}} pickup or a delivery address
- Headcount (we'll round the count for you)
- A time window, even a loose one

Craving more? We've got you covered. HOLIDAY25 runs straight through winter break and your first day back — order now for this week or pre-book for January 5.

Have a good run into break.

*Made to Crave®*
`,
  },
  {
    position: 3,
    send_date: '2027-01-04',
    promo_code: 'HOLIDAY25',
    cta_src: 'winter26-e3-newyear25',
    cta_label: 'Book a January delivery',
    subject: 'HOLIDAY25 ends today. NEWYEAR25 opens tomorrow.',
    preheader: 'New season, same craving. Three weeks of fresh-start pretzels.',
    body_md:
`Hi {{first_name}},

Welcome back.

**Today is the last day of HOLIDAY25.** If you've got a staff lunch or a Friday reward day already on the books for this week, order by close of business for pickup at {{pickup_location}}.

**Tomorrow, NEWYEAR25 opens and runs through Sunday January 25.** Same 100-plus-25 offer. Three full school weeks of runway for welcome-back lunches, PBIS reward days, student council socials, and the lead-up to 100th Day.

New year. Same craving. Hand-twisted that morning.

*Made to Crave®*
`,
  },
  {
    position: 4,
    send_date: '2027-01-25',
    promo_code: 'NEWYEAR25',
    cta_src: 'winter26-e4-winter25',
    cta_label: 'Reserve yours',
    subject: '100th Day of School, 100 pretzels, 25 free.',
    preheader: 'WINTER25 opens tomorrow. The math works out. We did it on purpose.',
    body_md:
`Hi {{first_name}},

The 100th Day of School is one of our favorite reasons to show up at an elementary building. It's also a perfect fit for the code we're rolling out tomorrow.

**NEWYEAR25 ends today. WINTER25 opens Tuesday and runs through Sunday February 8.**

Order 100 pretzels for your 100th Day celebration at {{organization}} and 25 come free. Enough for a classroom, a grade level, or the staff lounge, depending on your plan. If 100 isn't the right number, the offer stacks: 200 pretzels gets 50 free, 300 gets 75, and so on.

Crave big, snack bigger.

Dates filling up at {{pickup_location}} for the last week of January and first week of February.

*Made to Crave®*
`,
  },
  {
    position: 5,
    send_date: '2027-02-08',
    promo_code: 'WINTER25',
    cta_src: 'winter26-e5-love25',
    cta_label: 'Lock in a February date',
    subject: 'LOVE25 is live tomorrow. Crave it. Love it. Share it.',
    preheader: 'Three weeks of pretzel bonus for your February stretch.',
    body_md:
`Hi {{first_name}},

February is the surprise busy month. Valentine's parties. Presidents' Day half-days. Black History Month assemblies. Mid-winter concerts. The staff birthdays that always seem to land right now.

**WINTER25 wraps today. LOVE25 opens tomorrow and runs through Sunday February 28.**

Same 100-plus-25 offer, final chunk of the winter run. Valentine's Day lands six days in.

Popular February picks for {{organization}} and schools like it:
- **Classroom Valentine's parties** (we can split a 100-count across multiple rooms)
- **Staff lounge drops** for Presidents' Day week
- **Student recognition events** that got pushed from January
- **Black History Month assemblies**

Crave it. Love it. Share it.

*Made to Crave®*
`,
  },
  {
    position: 6,
    send_date: '2027-02-23',
    promo_code: 'LOVE25',
    cta_src: 'winter26-e6-love25',
    cta_label: 'Place final winter order',
    subject: 'Last week of LOVE25. Winter promo closes Sunday.',
    preheader: 'Final chance for the 25-free bonus. Order by Friday.',
    body_md:
`Hi {{first_name}},

Quick note: **LOVE25 closes Sunday February 28**, and with it the full winter promo run.

If {{organization}} has been meaning to run one more pretzel delivery before the end of the month, this is the week.

**100 pretzels, 25 free, code LOVE25. Orders in by Friday February 26 to deliver this week.**

Hand-twisted that morning. Hot, salted, ready for pickup at {{pickup_location}}.

We'll pick up again in the spring with a new code, but this specific run closes with Love25.

Thanks for a great winter.

*Made to Crave®*
`,
  },
];

// ─── Google Sheet — wholesale lead form ────────────────────────────
// Separate spreadsheet from the daily sales sheet (which lives in
// GOOGLE_SHEET_ID). Hard-coded because this script is one-purpose and
// won't be re-pointed. If the sheet ever moves, update here.
const WHOLESALE_SHEET_ID = '1Br-5b7Sl3-3OKB4q4Xs8mqAM_6vl_DBijbXzf9cq8eA';
const WHOLESALE_TAB_GID  = 164530681;

// Header-name → canonical customer field. Multiple variants map to
// one column so a renamed header still works. Lowercased + stripped
// of non-alphanumerics for comparison.
const HEADER_MAP = {
  email:           ['email', 'emailaddress'],
  first_name:      ['firstname', 'first', 'given'],
  contact_name:    ['fullname', 'contactname', 'name', 'contact'],
  organization:    ['organization', 'org', 'school', 'business', 'company', 'organizationname', 'schoolname', 'businessname'],
  pickup_location: ['pickuplocation', 'location', 'preferredlocation', 'pickup'],
  pickup_address:  ['pickupaddress', 'address', 'deliveryaddress'],
  phone:           ['phone', 'phonenumber', 'cell', 'mobile'],
  tax_exempt:      ['taxexempt', 'exempt', 'ein', 'nonprofit'],
  notes:           ['notes', 'note', 'comments', 'other'],
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseTaxExempt(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === 'exempt';
}

async function readWholesaleSheet() {
  const creds = JSON.parse(Buffer.from(process.env.GOOGLE_SHEET_KEY_B64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  // Resolve the tab name from its gid.
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: WHOLESALE_SHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  });
  const tab = meta.data.sheets.find(s => s.properties.sheetId === WHOLESALE_TAB_GID);
  if (!tab) throw new Error(`Tab gid ${WHOLESALE_TAB_GID} not found in sheet`);
  const tabName = tab.properties.title;
  const quoted  = /[^A-Za-z0-9_]/.test(tabName) ? `'${tabName.replace(/'/g, "''")}'` : tabName;

  // Pull everything.
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: WHOLESALE_SHEET_ID,
    range: `${quoted}!A1:ZZ`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = r.data.values || [];
  if (!rows.length) return { headers: [], rows: [] };

  // Build header → column index map.
  const header = rows[0].map(h => norm(h));
  const colFor = {};
  for (const [field, variants] of Object.entries(HEADER_MAP)) {
    const idx = header.findIndex(h => variants.includes(h));
    if (idx >= 0) colFor[field] = idx;
  }
  // Email is col R per the brief (0-indexed 17). Fall back to that if
  // no header matched — but trust the header if present.
  if (colFor.email == null) colFor.email = 17;
  if (!header.length) throw new Error('Empty header row in Wholesale sheet');

  // Walk data rows newest-last (sheet-order), dedupe on lowercased email
  // keeping the LAST row (most recent form submission).
  const byEmail = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const emailRaw = row[colFor.email];
    const email = String(emailRaw || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    const cust = { email };
    for (const [field, idx] of Object.entries(colFor)) {
      if (field === 'email') continue;
      const v = row[idx];
      if (v == null || v === '') continue;
      if (field === 'tax_exempt') cust[field] = parseTaxExempt(v);
      else cust[field] = String(v).trim();
    }
    byEmail.set(email, cust);  // last-write-wins → most recent row
  }
  return { headers: header, missing: Object.keys(HEADER_MAP).filter(f => colFor[f] == null && f !== 'email'), rows: [...byEmail.values()] };
}

// ─── Upserts ───────────────────────────────────────────────────────
async function upsertProducts() {
  if (!APPLY) return { planned: PRODUCTS.length };
  const { data, error } = await sb
    .from('wholesale_products')
    .upsert(PRODUCTS, { onConflict: 'sku', ignoreDuplicates: false })
    .select('id');
  if (error) throw new Error(`products: ${error.message}`);
  return { written: data.length };
}

async function upsertCampaign() {
  if (!APPLY) return { planned: 1 };
  const { data, error } = await sb
    .from('wholesale_campaigns')
    .upsert([CAMPAIGN], { onConflict: 'slug', ignoreDuplicates: false })
    .select('id');
  if (error) throw new Error(`campaign: ${error.message}`);
  return { written: data.length, campaign_id: data[0].id };
}

async function upsertCampaignEmails(campaignId) {
  const rows = EMAILS.map(e => ({ ...e, campaign_id: campaignId }));
  if (!APPLY) return { planned: rows.length };
  const { data, error } = await sb
    .from('wholesale_campaign_emails')
    .upsert(rows, { onConflict: 'campaign_id,position', ignoreDuplicates: false })
    .select('id');
  if (error) throw new Error(`campaign_emails: ${error.message}`);
  return { written: data.length };
}

async function upsertCustomers(customers) {
  if (!APPLY) return { planned: customers.length };
  // Chunk to stay under Supabase's default row limit for a single call.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < customers.length; i += CHUNK) {
    const chunk = customers.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from('wholesale_customers')
      .upsert(chunk, { onConflict: 'email', ignoreDuplicates: false })
      .select('id');
    if (error) throw new Error(`customers (${i}..${i + chunk.length}): ${error.message}`);
    written += data.length;
  }
  return { written };
}

// ─── Main ──────────────────────────────────────────────────────────
try {
  console.log(APPLY ? 'APPLY mode — writes will happen.' : 'DRY RUN — no writes. Re-run with --apply.');

  console.log('\n[1/4] Loading wholesale lead sheet…');
  const { headers, missing, rows: customers } = await readWholesaleSheet();
  console.log(`  → ${customers.length} unique customer(s) after email dedupe.`);
  if (missing && missing.length) {
    console.log(`  ! Headers not found in sheet (field will be left null): ${missing.join(', ')}`);
  }

  console.log('\n[2/4] Products…');
  const p = await upsertProducts();
  console.log(`  → ${APPLY ? `wrote ${p.written}` : `would write ${p.planned}`} product row(s).`);

  console.log('\n[3/4] Campaign + emails…');
  const c = await upsertCampaign();
  let campaignId = c.campaign_id;
  if (!APPLY) {
    // Dry-run: we still need an id to plan the emails upsert. Look it
    // up from an existing seed (if any) to show whether campaign emails
    // would create new rows or update.
    const { data } = await sb.from('wholesale_campaigns').select('id').eq('slug', CAMPAIGN.slug).maybeSingle();
    campaignId = data?.id || '(none — would be created)';
  }
  console.log(`  → campaign ${APPLY ? 'written' : 'planned'} (${CAMPAIGN.slug}).`);
  if (APPLY) {
    const e = await upsertCampaignEmails(campaignId);
    console.log(`  → wrote ${e.written} campaign email row(s).`);
  } else {
    console.log(`  → would write ${EMAILS.length} campaign email row(s).`);
  }

  console.log('\n[4/4] Customers…');
  const u = await upsertCustomers(customers);
  console.log(`  → ${APPLY ? `wrote ${u.written}` : `would write ${u.planned}`} customer row(s).`);

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write.');
  } else {
    console.log('\nSeed complete.');
  }
  process.exit(0);
} catch (err) {
  console.error('\nSeed failed:', err.message || err);
  process.exit(1);
}
