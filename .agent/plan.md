# plan: photo-anchor-fix

**Risk:** medium (endpoint + public UI constant; no DB, no secrets).

## Goal
Fix a one-day-off bug in the bi-weekly box-photo cadence shipped in PR #58.
The anchor was set to **2026-12-05** which is a Saturday. Driver photo
days run **every other Friday**, so the anchor must be **2026-12-04**
(a Friday). Without this fix, the first scheduled photo day lands on a
Saturday and the 14-day cadence is shifted by one day forever.

## Scope
- `api/driver/submit.js` — rename comment, update `PHOTO_ANCHOR_ISO`.
- `driver/index.html` — update mirrored `ANCHOR` in the `PhotoDay`
  module.

The applied migration `supabase/migrations/p25_route_photo_submissions.sql`
contains an informational comment with the wrong date. Not touched: a
committed-and-applied migration should not be rewritten, and the comment
is historical, not functional.

## Steps
1. Edit `api/driver/submit.js`: `PHOTO_ANCHOR_ISO = '2026-12-04'` and
   update the adjacent comment ("Anchor: Friday 2026-12-04").
2. Edit `driver/index.html`: `const ANCHOR = '2026-12-04';`.
3. Run `node .agent/anchor-check.mjs` (temp smoke) to verify
   `isPhotoDay('2026-12-04')` is true and `isPhotoDay('2026-12-05')`
   is false; verify the next 4 photo days are Fridays.
4. `npm test` — must stay at the baseline 75/77 (qr-config +
   scan-redirect are pre-existing).
5. Commit on `agent/photo-anchor-fix`, push, open PR.

## Success criteria
- `isPhotoDay('2026-12-04') === true`.
- `isPhotoDay('2026-12-05') === false`.
- Next four photo days: 2026-12-04, 2026-12-18, 2027-01-01, 2027-01-15
  — all Fridays.
- `npm test` baseline unchanged.
- Scope check passes.

## Risks + mitigations
- **Prod drift between endpoint and client:** both constants must move
  together or the client will show the banner on a day the server
  rejects. Mitigation: single PR, both files edited, smoke before push.
- **Already-written DB rows** (if any driver submitted today thinking
  it was a photo day): none expected — today is 2026-11-27, feature
  shipped a few hours ago, first photo day was never going to be today.
  Verified by: `select count(*) from route_photo_submissions;` returns 0
  (user confirmed post-merge; no drivers on the route today).

## Rollback
`git revert <sha>` on `main`. Vercel redeploys previous commit. No
migrations to roll back.
