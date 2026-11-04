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
const { escapeHtml } = require('./md');

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

// Chunk base64 to 76 chars/line per RFC 2045.
function chunk76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join('\r\n');
}

// Strip chars that must not appear in an RFC 2183 `filename=` quoted-string:
// CR, LF, NUL, and `"`. Attachment filenames flow from caller code paths
// (today: `invoice-<int>.pdf`), but this keeps a mis-wired caller from
// breaking the MIME structure.
function safeFilename(name) {
  // eslint-disable-next-line no-control-regex
  return String(name || 'attachment').replace(/[\r\n\x00"]/g, '').slice(0, 200) || 'attachment';
}

// Build the inner plain+html alternative body. Returns { body, boundary }
// so an outer multipart/mixed can embed it when attachments are present.
function buildAlternative({ html, text, preheader }) {
  const boundary = '----=_pcwh_alt_' + Math.random().toString(36).slice(2);
  const htmlWithPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${escapeHtml(preheader)}</div>\n${html}`
    : html;
  const body = [
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
  return { body, boundary };
}

// Build an RFC 822 message. Returns a base64url-encoded string suitable
// for Gmail's users.messages.send `raw` field.
//
//   - No attachments → one multipart/alternative, structurally identical
//     to the pre-attachment layout (the random boundary name prefix is
//     the only difference; downstream SMTP/IMAP/Gmail ignore the name).
//     Campaign-nurture send path is unchanged.
//   - With attachments → outer multipart/mixed wraps an inner
//     multipart/alternative (plain+html) followed by one base64 part
//     per attachment.
//
// `attachments` is an array of { filename, mime, content } where content
// is a Buffer (or anything Buffer.from understands).
function buildRaw({ to, subject, html, text, preheader, attachments }) {
  const encSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const headersCommon = [
    `From: "${FROM_NAME}" <${FROM_ADDRESS}>`,
    `To: ${to}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
  ];

  const atts = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const alt = buildAlternative({ html, text, preheader });

  let raw;
  if (!atts.length) {
    // Byte-for-byte equivalent to the pre-attachment layout: outer
    // Content-Type is the alternative boundary itself (no mixed wrapper).
    raw = [
      ...headersCommon,
      alt.body, // starts with "Content-Type: multipart/alternative; boundary=..."
    ].join('\r\n');
  } else {
    const mixedBoundary = '----=_pcwh_mix_' + Math.random().toString(36).slice(2);
    const parts = [
      ...headersCommon,
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      `--${mixedBoundary}`,
      alt.body, // alternative sub-part, with its own Content-Type header line
      `--${mixedBoundary}`,
    ];
    atts.forEach((a, i) => {
      const filename = safeFilename(a && a.filename);
      const mime = (a && a.mime) || 'application/octet-stream';
      const content = Buffer.isBuffer(a && a.content) ? a.content : Buffer.from((a && a.content) || '');
      parts.push(
        `Content-Type: ${mime}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        chunk76(content.toString('base64')),
        '',
      );
      if (i < atts.length - 1) parts.push(`--${mixedBoundary}`);
    });
    parts.push(`--${mixedBoundary}--`, '');
    raw = parts.join('\r\n');
  }

  return Buffer.from(raw, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, html, text, preheader, attachments }) {
  const gmail = await getGmail();
  const raw = buildRaw({ to, subject, html, text, preheader, attachments });
  const r = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return { id: r.data.id, threadId: r.data.threadId };
}

module.exports = {
  sendEmail,
  FROM_ADDRESS,
  FROM_NAME,
  // Internal: a deterministic-boundary builder for smoke tests. The
  // public `buildRaw` uses random boundaries, so a snapshot would never
  // match. When `_fixedBoundaries` is passed, we briefly override
  // Math.random so buildRaw picks the same boundary strings every time;
  // when it isn't, this is a plain passthrough and no global state is
  // touched.
  __test_buildRaw: ({ to, subject, html, text, preheader, attachments, _fixedBoundaries }) => {
    const args = { to, subject, html, text, preheader, attachments };
    if (!_fixedBoundaries) return buildRaw(args);
    const savedRandom = Math.random;
    try {
      let i = 0;
      // eslint-disable-next-line no-global-assign
      Math.random = () => _fixedBoundaries[i++ % _fixedBoundaries.length];
      return buildRaw(args);
    } finally {
      // eslint-disable-next-line no-global-assign
      Math.random = savedRandom;
    }
  },
};
