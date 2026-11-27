// Google Drive writer for bi-weekly box photos.
//
// Reuses the service account JSON key stored in GOOGLE_SHEET_KEY_B64
// (scope upgraded to include drive). Writes into the folder whose id
// is GOOGLE_DRIVE_PARENT_ID. The service account must be invited to
// that folder as Editor — a common setup foot-gun; the submit endpoint
// soft-degrades with a clear error when it isn't.
//
// Layout under the parent folder:
//   <parent>/<routeKey>/<YYYYMMDD> - <driverName>/<NN>-<stop>.jpg
//
// Behavior is idempotent:
//   - Folders are list-or-create by (name, parent).
//   - Photo uploads are overwrite-by-name: re-uploading the same stop
//     on the same day replaces the earlier file in place; the DB
//     counter only increments on the create branch.

const { google } = require('googleapis');
const { Readable } = require('stream');

const PARENT_ID = process.env.GOOGLE_DRIVE_PARENT_ID;

let _drive = null;
async function getDrive() {
  if (_drive) return _drive;
  const b64 = process.env.GOOGLE_SHEET_KEY_B64;
  if (!b64) throw new Error('GOOGLE_SHEET_KEY_B64 not set');
  if (!PARENT_ID) throw new Error('GOOGLE_DRIVE_PARENT_ID not set');
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _drive = google.drive({ version: 'v3', auth: await auth.getClient() });
  return _drive;
}

// Escape single quotes for Drive's q= query syntax.
function qesc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// Strip characters that are awkward in Drive folder/file names.
function sanitize(s) { return String(s).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim(); }

async function ensureFolder(parentId, name) {
  const drive = await getDrive();
  const q = `'${qesc(parentId)}' in parents and name = '${qesc(name)}' `
          + `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const found = await drive.files.list({
    q,
    fields: 'files(id,name,webViewLink)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (found.data.files && found.data.files.length) return found.data.files[0];
  const made = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,
  });
  return made.data;
}

// <parent>/<routeKey>/<YYYYMMDD> - <driverName>
async function ensureRouteDriverFolder({ routeKey, forDate, driverName }) {
  if (!PARENT_ID) throw new Error('GOOGLE_DRIVE_PARENT_ID not set');
  const route = await ensureFolder(PARENT_ID, routeKey);
  const dateSlug = String(forDate).replace(/-/g, '');
  const folderName = `${dateSlug} - ${sanitize(driverName || 'Unknown')}`;
  return await ensureFolder(route.id, folderName);
}

// Upload-or-replace: if a file with `filename` already lives in `folderId`,
// its contents are replaced (so the driver can re-take and overwrite). On
// create the response carries `created: true` so the caller knows whether
// to bump the photos_count in Supabase.
async function uploadPhoto({ folderId, filename, buffer, mimeType }) {
  const drive = await getDrive();
  const q = `'${qesc(folderId)}' in parents and name = '${qesc(filename)}' and trashed = false`;
  const existing = await drive.files.list({
    q,
    fields: 'files(id,name,webViewLink)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (existing.data.files && existing.data.files.length) {
    const prior = existing.data.files[0];
    const upd = await drive.files.update({
      fileId: prior.id,
      media: { mimeType, body: Readable.from(buffer) },
      fields: 'id,name,webViewLink',
      supportsAllDrives: true,
    });
    return Object.assign({ created: false }, upd.data);
  }
  const made = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id,name,webViewLink',
    supportsAllDrives: true,
  });
  return Object.assign({ created: true }, made.data);
}

// Translate common Drive errors so the UI can distinguish the "invite
// the service account" case from a generic 500.
function classifyDriveError(err) {
  const code = err && (err.code || (err.response && err.response.status));
  const msg  = (err && (err.message
    || (err.response && err.response.data && err.response.data.error && err.response.data.error.message))) || '';
  if (code === 403 || /insufficient permissions|does not have permission/i.test(msg)) {
    return { kind: 'forbidden', hint: 'service account is not an Editor on GOOGLE_DRIVE_PARENT_ID' };
  }
  if (code === 404 || /notFound/i.test(msg)) {
    return { kind: 'not_found', hint: 'GOOGLE_DRIVE_PARENT_ID may be wrong or not shared with the service account' };
  }
  return { kind: 'unknown', hint: String(msg).slice(0, 200) };
}

module.exports = {
  PARENT_ID,
  getDrive,
  ensureFolder,
  ensureRouteDriverFolder,
  uploadPhoto,
  classifyDriveError,
  sanitize,
};
