/* Admin-only group email. The browser never talks to n8n or Airtable directly for this:
   every action requires the signed-in Administrator's token, recipients are recomputed HERE from
   Airtable (never trusted from the browser), every attachment is virus-scanned (fail closed) before
   it is stored, and the actual sending is done one-person-at-a-time by an n8n workflow that checks a
   one-time token this function writes into the Group Emails row. */
const crypto = require('crypto');
const https = require('https');
const { BASE_ID, requireAdmin, airtable, json } = require('./lib/session');
const { scanBuffer } = require('./lib/scan');

const T_EMAILS = 'tbl8T5oxGbAgX0bZ8';
const T_STUDENTS = 'tbluHnJc9VM6l4U6V';
const F = { first: 'flduMlCg6WQYp1603', last: 'fldaIIUPWQqHMxUbG', pFirst: 'fldqJs1uDhrOJchi7', pLast: 'fldeQZnY89hXgeK76',
  primary: 'fldHE8GLMmh1GZqz6', secondary: 'flddSBcxPPyp3lQT3', student: 'fldoxaHnlJN2wZTXU' };
const E = { subject: 'Subject', body: 'Body', mode: 'Mode', status: 'Status', audience: 'Audience', recipients: 'Recipients',
  count: 'Recipient Count', sent: 'Sent Count', failed: 'Failed Count', requestedBy: 'Requested By', created: 'Created At', token: 'Send Token', error: 'Last Error' };
const ATTACH_FIELD_ID = 'fldmORcDcwiFt7hUj';
const WEBHOOK = 'https://n8n.flyace.org/webhook/ace-group-email';

const LIMITS = { files: 5, totalBytes: 10 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, recipients: 150, subject: 200, body: 10000 };
const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'doc', 'docx', 'xls', 'xlsx', 'csv'];
const ROLES = ['primary', 'secondary', 'student'];
const REC_ID = /^rec[A-Za-z0-9]{14}$/;
const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[A-Za-z]{2,}$/;

const bad = (msg, code = 400) => json(code, { error: msg });
const clean = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();

function httpsJson(options, body) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', () => resolve({ status: 502, json: null }));
    req.end(body);
  });
}

async function getRow(id) {
  if (!REC_ID.test(String(id || ''))) return null;
  return airtable('GET', '/' + BASE_ID + '/' + T_EMAILS + '/' + id);
}

/* Recipients come from Airtable, for the record ids the admin is looking at, for the chosen roles. */
async function buildRecipients(recordIds, roles) {
  const ids = [...new Set((recordIds || []).filter((i) => REC_ID.test(String(i))))].slice(0, 500);
  const picked = ROLES.filter((r) => (roles || []).includes(r));
  const seen = new Map(); const byRole = { primary: 0, secondary: 0, student: 0 };
  let students = 0, noEmail = 0, invalid = 0, dupes = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const formula = 'OR(' + chunk.map((id) => "RECORD_ID()='" + id + "'").join(',') + ')';
    const q = '?returnFieldsByFieldId=true&pageSize=100&filterByFormula=' + encodeURIComponent(formula) +
      [F.first, F.last, F.pFirst, F.pLast, F.primary, F.secondary, F.student].map((f) => '&fields%5B%5D=' + f).join('');
    const data = await airtable('GET', '/' + BASE_ID + '/' + T_STUDENTS + q);
    if (!data) return null;
    for (const rec of data.records || []) {
      students++;
      const f = rec.fields || {};
      const sName = (clean(f[F.first]) + ' ' + clean(f[F.last])).trim() || 'Student';
      const pName = (clean(f[F.pFirst]) + ' ' + clean(f[F.pLast])).trim() || 'Parent';
      const wants = { primary: [f[F.primary], pName + ' (primary parent of ' + sName + ')'], secondary: [f[F.secondary], 'Secondary parent of ' + sName], student: [f[F.student], sName + ' (student)'] };
      for (const role of picked) {
        const [raw, label] = wants[role];
        const email = clean(raw).toLowerCase();
        if (!email) { noEmail++; continue; }
        if (!EMAIL.test(email)) { invalid++; continue; }
        if (seen.has(email)) { dupes++; continue; }
        seen.set(email, { email, name: label, role }); byRole[role]++;
      }
    }
  }
  return { recipients: [...seen.values()], byRole, students, noEmail, invalid, dupes };
}

const attachmentsOf = (row) => (row?.fields?.Attachments || []).map((a) => ({ id: a.id, filename: a.filename, size: a.size }));
const summarize = (row) => ({ id: row.id, status: row.fields[E.status]?.name || row.fields[E.status] || '', sent: row.fields[E.sent] || 0, failed: row.fields[E.failed] || 0, total: row.fields[E.count] || 0, error: row.fields[E.error] || '', attachments: attachmentsOf(row) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return bad('POST only', 405);
  const admin = await requireAdmin(event);
  if (!admin) return bad('Please sign in as an Administrator.', 401);
  let b; try { b = JSON.parse(event.body || '{}'); } catch (_) { return bad('Bad request'); }
  const action = String(b.action || '');

  if (action === 'draft') {
    const row = await airtable('POST', '/' + BASE_ID + '/' + T_EMAILS, { fields: { [E.status]: 'Draft', [E.requestedBy]: admin.email, [E.created]: new Date().toISOString(), [E.subject]: '(draft)' } });
    if (!row) return bad('Could not start the email. Try again.', 502);
    return json(200, { draftId: row.id });
  }

  if (action === 'recipients') {
    const r = await buildRecipients(b.recordIds, b.roles);
    if (!r) return bad('Could not read the student list. Try again.', 502);
    return json(200, { count: r.recipients.length, byRole: r.byRole, students: r.students, noEmail: r.noEmail, invalid: r.invalid, duplicatesSkipped: r.dupes, cap: LIMITS.recipients, list: r.recipients.slice(0, 300).map((x) => ({ name: x.name, email: x.email })) });
  }

  /* Everything below works on one of this admin's own drafts. */
  const row = await getRow(b.draftId);
  if (!row || row.fields[E.requestedBy] !== admin.email) return bad('That email draft was not found. Close this window and start again.', 404);
  const status = row.fields[E.status]?.name || row.fields[E.status];

  if (action === 'status') return json(200, summarize(row));

  if (action === 'attach' || action === 'remove') {
    if (!['Draft', 'Test sent'].includes(status)) return bad('This email was already sent, so its attachments can no longer change.', 409);
    if (action === 'remove') {
      const keep = (row.fields.Attachments || []).filter((a) => a.id !== b.attachmentId).map((a) => ({ id: a.id }));
      const upd = await airtable('PATCH', '/' + BASE_ID + '/' + T_EMAILS + '/' + row.id, { fields: { Attachments: keep } });
      return upd ? json(200, summarize(upd)) : bad('Could not remove it. Try again.', 502);
    }
    const filename = clean(b.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (!filename || !ALLOWED_EXT.includes(ext)) return bad('That file type is not allowed. Allowed: PDF, images (PNG, JPG, GIF), Word, Excel and CSV.', 415);
    let buf; try { buf = Buffer.from(String(b.base64 || ''), 'base64'); } catch (_) { return bad('Bad file data'); }
    if (!buf.length) return bad('That file is empty.');
    if (buf.length > LIMITS.fileBytes) return bad('That file is too large (' + (buf.length / 1048576).toFixed(1) + ' MB). Each file can be up to 4 MB.', 413);
    const existing = attachmentsOf(row);
    if (existing.length >= LIMITS.files) return bad('You can attach up to ' + LIMITS.files + ' files.', 409);
    if (existing.reduce((n, a) => n + (a.size || 0), 0) + buf.length > LIMITS.totalBytes) return bad('Attachments can total up to 10 MB.', 413);

    const scan = await scanBuffer(buf, filename, clean(b.contentType), ALLOWED_EXT.map((e) => '.' + e).join(','));
    if (scan.status === 'infected') return json(422, { error: 'Blocked: the virus scan found a problem in "' + filename + '" (' + scan.virus + '). It was not attached.', scan: 'infected' });
    if (scan.status !== 'clean') return json(503, { error: 'Could not scan "' + filename + '" for viruses right now, so it was not attached. ' + scan.reason, scan: 'unavailable' });

    const body = JSON.stringify({ contentType: clean(b.contentType) || 'application/octet-stream', file: buf.toString('base64'), filename });
    const up = await httpsJson({ hostname: 'content.airtable.com', path: '/v0/' + BASE_ID + '/' + row.id + '/' + ATTACH_FIELD_ID + '/uploadAttachment', method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_PAT, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (up.status !== 200) return bad('Could not store the attachment. Try again.', 502);
    const fresh = await getRow(row.id);
    return json(200, { ...(fresh ? summarize(fresh) : {}), scan: 'clean', filename });
  }

  if (action === 'send') {
    if (!['Draft', 'Test sent'].includes(status)) return bad('This email was already sent or is sending.', 409);
    const mode = b.mode === 'send' ? 'Send' : 'Test';
    const subject = clean(b.subject), text = String(b.body ?? '').replace(/\r\n/g, '\n').trim();
    if (!subject || subject.length > LIMITS.subject) return bad('Please enter a subject (up to ' + LIMITS.subject + ' characters).');
    if (!text || text.length > LIMITS.body) return bad('Please enter a message (up to ' + LIMITS.body + ' characters).');

    let recipients, audience;
    if (mode === 'Test') {
      recipients = [{ email: admin.email.toLowerCase(), name: admin.name || 'Administrator', role: 'test' }];
      audience = 'TEST to ' + admin.email;
    } else {
      const r = await buildRecipients(b.recordIds, b.roles);
      if (!r) return bad('Could not read the student list. Nothing was sent.', 502);
      recipients = r.recipients;
      if (!recipients.length) return bad('There is nobody to send to with those choices.');
      if (recipients.length > LIMITS.recipients) return bad('That is ' + recipients.length + ' people. A single send is limited to ' + LIMITS.recipients + '. Narrow the group.');
      if (Number(b.confirmCount) !== recipients.length) return bad('The recipient count changed (now ' + recipients.length + '). Review it and confirm again. Nothing was sent.', 409);
      audience = clean(b.audience).slice(0, 200) || 'Group email';
    }

    const token = crypto.randomBytes(16).toString('hex');
    const upd = await airtable('PATCH', '/' + BASE_ID + '/' + T_EMAILS + '/' + row.id, { fields: {
      [E.subject]: subject, [E.body]: text, [E.mode]: mode, [E.status]: 'Queued', [E.audience]: audience, [E.recipients]: JSON.stringify(recipients),
      [E.count]: recipients.length, [E.sent]: 0, [E.failed]: 0, [E.token]: token, [E.error]: '', [E.created]: new Date().toISOString() } });
    if (!upd) return bad('Could not save the email. Nothing was sent.', 502);

    const hook = JSON.stringify({ recordId: row.id, token });
    const r = await httpsJson({ hostname: 'n8n.flyace.org', path: '/webhook/ace-group-email', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(hook) } }, hook);
    if (r.status < 200 || r.status >= 300) {
      await airtable('PATCH', '/' + BASE_ID + '/' + T_EMAILS + '/' + row.id, { fields: { [E.status]: 'Failed', [E.token]: '', [E.error]: 'The sender workflow could not be reached (' + r.status + ').' } });
      return bad('The email sender could not be reached. Nothing was sent.', 502);
    }
    return json(200, { ok: true, queued: recipients.length, mode });
  }

  return bad('Unknown action');
};
module.exports.LIMITS = LIMITS;
