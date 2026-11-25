// Quick verification that the paged fetch returns the full annual window.
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const minFrom = '2025-11-25';
const toIso   = '2026-11-25';

const out = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from('returns')
    .select('for_date,sold_cents')
    .gte('for_date', minFrom).lte('for_date', toIso)
    .order('for_date').order('stop_id')
    .range(from, from + 999);
  if (error) throw error;
  if (!data || !data.length) break;
  out.push(...data);
  if (data.length < 1000) break;
}

const total = out.reduce((a, r) => a + (r.sold_cents || 0), 0);
console.log(`paged fetch: ${out.length} rows, $${(total / 100).toFixed(2)} total`);
