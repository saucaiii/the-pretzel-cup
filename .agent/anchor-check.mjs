// Smoke test for photo-anchor-fix. Reruns the server's isPhotoDay()
// against the corrected anchor and verifies the next four photo days
// are Fridays.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('../api/driver/submit.js');
const { isPhotoDay, PHOTO_ANCHOR_ISO, PHOTO_PERIOD_DAYS } = mod.__helpers;

const dow = iso => {
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, d)).toLocaleDateString('en-US', { weekday:'long', timeZone:'UTC' });
};

const checks = [];
const assertEq = (label, got, want) => checks.push({ label, got, want, pass: got === want });

assertEq('anchor is 2026-12-04', PHOTO_ANCHOR_ISO, '2026-12-04');
assertEq('period is 14', PHOTO_PERIOD_DAYS, 14);

assertEq('isPhotoDay(2026-12-04) Friday',  isPhotoDay('2026-12-04'), true);
assertEq('isPhotoDay(2026-12-05) Saturday', isPhotoDay('2026-12-05'), false);
assertEq('isPhotoDay(2026-12-11) Friday+7', isPhotoDay('2026-12-11'), false);
assertEq('isPhotoDay(2026-12-18) Friday+14', isPhotoDay('2026-12-18'), true);
assertEq('isPhotoDay(2027-01-01) Friday+28', isPhotoDay('2027-01-01'), true);
assertEq('isPhotoDay(2027-01-15) Friday+42', isPhotoDay('2027-01-15'), true);

// pre-anchor
assertEq('isPhotoDay(2026-11-27) pre-anchor Fri', isPhotoDay('2026-11-27'), false);

// every true should be a Friday
for (const iso of ['2026-12-04','2026-12-18','2027-01-01','2027-01-15']) {
  assertEq(`${iso} day-of-week`, dow(iso), 'Friday');
}

let fail = 0;
for (const c of checks) {
  const mark = c.pass ? '✓' : '✗';
  console.log(`${mark} ${c.label} — got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`);
  if (!c.pass) fail++;
}
console.log('');
if (fail) { console.log(`FAIL ${fail}/${checks.length}`); process.exit(1); }
console.log(`ALL GREEN ✅ ${checks.length}/${checks.length}`);
