// Gmail API send wrapper for the wholesale nurture campaign.
//
// Uses the SAME service-account credentials as _lib/sheet.js
// (GOOGLE_SHEET_KEY_B64, a base64-encoded service account JSON). Adds
// the gmail.send scope and uses JWT "subject" impersonation to send
// AS the configured From address.
//
// IMPORTANT deployment note (not enforced in code — documented in
// docs/wholesale.md):
//
//   Service-account subject impersonation on Gmail requires either
//   a Google Workspace account with domain-wide delegation configured
//   on the admin console, OR for the service account to have been
//   granted delegation on the target user via the Workspace admin.
//   A plain consumer @gmail.com address cannot be impersonated this
//   way — if the From address is a consumer account, use OAuth 2.0
//   with a stored refresh token instead. This module throws a clear
//   error if the Gmail API returns an auth failure so the operator
//   knows which path to configure.
//
// Scope requested: https://www.googleapis.com/auth/gmail.send

const { google } = require('googleapis');

const FROM_ADDRESS   = 'mcaiazzoppffs@gmail.com';
const FROM_NAME      = 'Philly Pretzel Factory';
const SCOPES         = ['https://www.googleapis.com/auth/gmail.send'];

let _gmail = null;

async function getGmail() {
  if (_gmail) return _gmail;
  const b64 = process.env.GOOGLE_SHEET_KEY_B64;
  if (!b64) throw new Error('GOOGLE_SHEET_KEY_B64 not set');
  const creds = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.JWT({
    email:   creds.client_email,
    key:     creds.private_key,
    scopes:  SCOPES,
    subject: FROM_ADDRESS,
  });
  await auth.authorize();
  _gmail = google.gmail({ version: 'v1', auth });
  return _gmail;
}

// Build an RFC 822 message with a multipart/alternative body (plain +
// html). Returns a base64url-encoded string suitable for Gmail's
// users.messages.send `raw` field.
function buildRaw({ to, subject, html, text, preheader }) {
  const boundary = '----=_pcwh_' + Math.random().toString(36).slice(2);
  const encSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const htmlWithPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${preheader}</div>\n${html}`
    : html;
  const parts = [
    `From: "${FROM_NAME}" <${FROM_ADDRESS}>`,
    `To: ${to}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlWithPreheader,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(parts, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, html, text, preheader }) {
  const gmail = await getGmail();
  const raw = buildRaw({ to, subject, html, text, preheader });
  const r = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return { id: r.data.id, threadId: r.data.threadId };
}

module.exports = { sendEmail, FROM_ADDRESS, FROM_NAME };
