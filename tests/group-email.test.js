/* Mocked tests for the group email + virus scan. Nothing here touches Airtable, n8n or the scanner.
   Run: npm run test:server */
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');

process.env.AIRTABLE_PAT = 'patTEST.secret';
process.env.CLOUDMERSIVE_API_KEY = 'test-key';

const ADMIN_ID = 'recADMIN0000000001', OTHER_ADMIN_ID = 'recADMIN0000000002';
const accounts = {
  [ADMIN_ID]: { id: ADMIN_ID, fields: { Email: 'pam@example.com', 'Full Name': 'Pam Admin', 'Account Type': { name: 'Administrator' } } },
  [OTHER_ADMIN_ID]: { id: OTHER_ADMIN_ID, fields: { Email: 'other@example.com', 'Full Name': 'Other Admin', 'Account Type': { name: 'Administrator' } } },
};
const S = require('../netlify/functions/lib/session');
const adminTok = S.signToken({ rec: ADMIN_ID }), otherTok = S.signToken({ rec: OTHER_ADMIN_ID });

/* ---- fake Airtable (global fetch) ---- */
const F = { first: 'flduMlCg6WQYp1603', last: 'fldaIIUPWQqHMxUbG', pFirst: 'fldqJs1uDhrOJchi7', pLast: 'fldeQZnY89hXgeK76', primary: 'fldHE8GLMmh1GZqz6', secondary: 'flddSBcxPPyp3lQT3', student: 'fldoxaHnlJN2wZTXU' };
const students = {};
const addStudent = (n, o = {}) => { students['recSTU' + String(n).padStart(11, '0')] = { id: 'recSTU' + String(n).padStart(11, '0'), fields: { [F.first]: 'S' + n, [F.last]: 'L' + n, [F.pFirst]: 'P' + n, [F.pLast]: 'L' + n, [F.primary]: 'p' + n + '@example.com', ...o } }; return 'recSTU' + String(n).padStart(11, '0'); };
let emails = {}; let nextRow = 1;
const calls = { patches: [], webhooks: [], uploads: [], scans: [], studentQueries: [] };
let scannerMode = 'clean'; let webhookStatus = 200;

const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
const nope = (s = 404) => ({ ok: false, status: s, json: async () => ({}), text: async () => '{}' });
global.fetch = async (url, opts = {}) => {
  const u = new URL(url); const method = opts.method || 'GET';
  let m;
  if ((m = u.pathname.match(/\/tblwJ9C1BQIMGMzKx\/(rec\w+)$/))) return accounts[m[1]] ? ok(accounts[m[1]]) : nope();
  if (u.pathname.endsWith('/tbl8T5oxGbAgX0bZ8')) { const id = 'recMAIL' + String(nextRow++).padStart(10, '0'); emails[id] = { id, fields: { ...JSON.parse(opts.body).fields } }; return ok(emails[id]); }
  if ((m = u.pathname.match(/\/tbl8T5oxGbAgX0bZ8\/(rec\w+)$/))) {
    const row = emails[m[1]]; if (!row) return nope();
    if (method === 'PATCH') { const f = JSON.parse(opts.body).fields; calls.patches.push({ id: m[1], f });
      if (f.Attachments) f.Attachments = f.Attachments.map((k) => (row.fields.Attachments || []).find((a) => a.id === k.id)).filter(Boolean); // Airtable keeps existing files by id
      Object.assign(row.fields, f); }
    return ok(row);
  }
  if (u.pathname.endsWith('/tbluHnJc9VM6l4U6V')) {
    const f = u.searchParams.get('filterByFormula') || ''; calls.studentQueries.push(f);
    const ids = [...f.matchAll(/RECORD_ID\(\)='([^']+)'/g)].map((x) => x[1]);
    return ok({ records: ids.map((i) => students[i]).filter(Boolean) });
  }
  return nope();
};
/* ---- fake https.request (scanner, Airtable upload API, n8n webhook) ---- */
https.request = (options, cb) => {
  const chunks = [];
  const req = { on() { return req; }, destroy() {}, end(body) { if (body) chunks.push(Buffer.from(body)); setImmediate(() => respond()); } };
  function respond() {
    const body = Buffer.concat(chunks);
    const res = { statusCode: 200, on(ev, fn) { if (ev === 'data') this._d = fn; if (ev === 'end') this._e = fn; return this; } };
    let payload = '{}';
    if (options.hostname === 'api.cloudmersive.com') {
      calls.scans.push({ headers: options.headers, bytes: body.length });
      if (scannerMode === 'clean') payload = JSON.stringify({ CleanResult: true, FoundViruses: null });
      else if (scannerMode === 'infected') payload = JSON.stringify({ CleanResult: false, FoundViruses: [{ FileName: 'x', VirusName: 'Eicar-Test' }] });
      else if (scannerMode === 'error') res.statusCode = 500;
      else if (scannerMode === 'garbage') payload = 'not json';
    } else if (options.hostname === 'content.airtable.com') {
      const j = JSON.parse(body.toString()); const id = options.path.match(/\/(rec\w+)\//)[1];
      calls.uploads.push({ id, filename: j.filename });
      const row = emails[id]; row.fields.Attachments = [...(row.fields.Attachments || []), { id: 'att' + (row.fields.Attachments || []).length + j.filename, filename: j.filename, size: Buffer.from(j.file, 'base64').length }];
    } else if (options.hostname === 'n8n.flyace.org') {
      calls.webhooks.push(JSON.parse(body.toString())); res.statusCode = webhookStatus;
    }
    cb(res); res._d && res._d(payload); res._e && res._e();
  }
  return req;
};

const handler = require('../netlify/functions/group-email').handler;
const upload = require('../netlify/functions/airtable-upload').handler;
const call = (payload, token = adminTok) => handler({ httpMethod: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: JSON.stringify(payload) });
const body = (r) => JSON.parse(r.body);
const b64 = (n, c = 'a') => Buffer.alloc(n, c).toString('base64');
const newDraft = async (token) => body(await call({ action: 'draft' }, token)).draftId;

addStudent(1, { [F.secondary]: 's1@example.com', [F.student]: 'kid1@example.com' });
addStudent(2, { [F.primary]: 'P2@Example.com', [F.secondary]: 'p2@example.com' });          // same address as primary (dupe)
addStudent(3, { [F.primary]: '' });                                                           // blank primary
addStudent(4, { [F.primary]: 'not-an-email' });                                               // invalid
const IDS = Object.keys(students);

test('every action needs a signed-in Administrator', async () => {
  assert.equal((await call({ action: 'draft' }, null)).statusCode, 401);
  assert.equal((await call({ action: 'draft' }, 'garbage.token')).statusCode, 401);
  assert.equal((await handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);
});

test('recipients: chosen roles only, deduped, blanks/invalid skipped, counted', async () => {
  let r = body(await call({ action: 'recipients', recordIds: IDS, roles: ['primary'] }));
  assert.equal(r.count, 2); assert.equal(r.noEmail, 1); assert.equal(r.invalid, 1); assert.equal(r.students, 4);
  assert.deepEqual(r.list.map((x) => x.email).sort(), ['p1@example.com', 'p2@example.com']);
  r = body(await call({ action: 'recipients', recordIds: IDS, roles: ['primary', 'secondary', 'student'] }));
  assert.deepEqual(r.list.map((x) => x.email).sort(), ['kid1@example.com', 'p1@example.com', 'p2@example.com', 's1@example.com']);
  assert.equal(r.duplicatesSkipped, 1); // student 2's secondary == primary
  r = body(await call({ action: 'recipients', recordIds: IDS, roles: ['student'] }));
  assert.equal(r.count, 1);
  r = body(await call({ action: 'recipients', recordIds: IDS, roles: [] }));
  assert.equal(r.count, 0);
});
test('recipients: record ids are validated, so nothing can be injected into the Airtable formula', async () => {
  calls.studentQueries.length = 0;
  await call({ action: 'recipients', recordIds: ["recX'),TRUE(),RECORD_ID()='a", IDS[0], 'x'], roles: ['primary'] });
  const q = calls.studentQueries.join('');
  assert.ok(q.includes(IDS[0])); assert.ok(!q.includes('TRUE()'));
});

test('attach: file type, size and count limits', async () => {
  const d = await newDraft();
  assert.equal((await call({ action: 'attach', draftId: d, filename: 'evil.exe', contentType: 'application/x-msdownload', base64: b64(100) })).statusCode, 415);
  assert.equal((await call({ action: 'attach', draftId: d, filename: 'x.pdf', base64: b64(4 * 1024 * 1024 + 1) })).statusCode, 413);
  assert.equal((await call({ action: 'attach', draftId: d, filename: 'x.pdf', base64: '' })).statusCode, 400);
  const before = calls.uploads.length;
  for (let i = 0; i < 5; i++) assert.equal((await call({ action: 'attach', draftId: d, filename: 'f' + i + '.pdf', contentType: 'application/pdf', base64: b64(1000) })).statusCode, 200);
  assert.equal((await call({ action: 'attach', draftId: d, filename: 'f6.pdf', base64: b64(1000) })).statusCode, 409); // 6th
  assert.equal(calls.uploads.length - before, 5);
  const d2 = await newDraft();
  for (const n of [4, 4]) await call({ action: 'attach', draftId: d2, filename: 'big' + Math.random() + '.pdf', base64: b64(n * 1024 * 1024) });
  assert.equal((await call({ action: 'attach', draftId: d2, filename: 'third.pdf', base64: b64(3 * 1024 * 1024) })).statusCode, 413); // 11 MB total
});
test('attach: the scanner runs on every file; an infected file is refused and never stored', async () => {
  const d = await newDraft(); const up = calls.uploads.length, sc = calls.scans.length;
  scannerMode = 'infected';
  const r = await call({ action: 'attach', draftId: d, filename: 'invoice.pdf', contentType: 'application/pdf', base64: b64(500) });
  assert.equal(r.statusCode, 422); assert.equal(body(r).scan, 'infected'); assert.match(body(r).error, /Eicar-Test/);
  assert.equal(calls.uploads.length, up); assert.equal(calls.scans.length, sc + 1);
  scannerMode = 'clean';
  const ok2 = await call({ action: 'attach', draftId: d, filename: 'invoice.pdf', contentType: 'application/pdf', base64: b64(500) });
  assert.equal(ok2.statusCode, 200); assert.equal(body(ok2).scan, 'clean'); assert.equal(body(ok2).attachments.length, 1);
  assert.equal(calls.uploads.length, up + 1);
  assert.equal(calls.scans.at(-1).headers.Apikey, 'test-key');
  assert.match(calls.scans.at(-1).headers.restrictFileTypes, /\.pdf/);
});
test('attach: FAIL CLOSED when the scanner errors, times out, returns junk or has no key', async () => {
  const d = await newDraft(); const up = calls.uploads.length;
  for (const mode of ['error', 'garbage']) {
    scannerMode = mode;
    const r = await call({ action: 'attach', draftId: d, filename: 'a.pdf', base64: b64(100) });
    assert.equal(r.statusCode, 503, mode); assert.equal(body(r).scan, 'unavailable');
  }
  scannerMode = 'clean';
  const key = process.env.CLOUDMERSIVE_API_KEY; delete process.env.CLOUDMERSIVE_API_KEY;
  try { assert.equal((await call({ action: 'attach', draftId: d, filename: 'a.pdf', base64: b64(100) })).statusCode, 503); } finally { process.env.CLOUDMERSIVE_API_KEY = key; }
  assert.equal(calls.uploads.length, up);
});
test('remove: keeps the other attachments', async () => {
  const d = await newDraft();
  await call({ action: 'attach', draftId: d, filename: 'one.pdf', base64: b64(100) });
  const two = body(await call({ action: 'attach', draftId: d, filename: 'two.pdf', base64: b64(100) }));
  const rm = body(await call({ action: 'remove', draftId: d, attachmentId: two.attachments[0].id }));
  assert.deepEqual(rm.attachments.map((a) => a.filename), ['two.pdf']);
});

test('a draft belongs to the admin who made it', async () => {
  const d = await newDraft();
  assert.equal((await call({ action: 'status', draftId: d }, otherTok)).statusCode, 404);
  assert.equal((await call({ action: 'send', draftId: d, mode: 'test', subject: 's', body: 'b' }, otherTok)).statusCode, 404);
  assert.equal((await call({ action: 'status', draftId: 'recNOPE' })).statusCode, 404);
});

test('test send: goes ONLY to the signed-in admin, whatever group was chosen; token is one-time and passed to n8n', async () => {
  const d = await newDraft(); calls.webhooks.length = 0;
  const r = await call({ action: 'send', draftId: d, mode: 'test', subject: 'Hello', body: 'World', recordIds: IDS, roles: ['primary', 'secondary', 'student'] });
  assert.equal(r.statusCode, 200); assert.equal(body(r).queued, 1);
  const row = emails[d].fields;
  assert.deepEqual(JSON.parse(row.Recipients).map((x) => x.email), ['pam@example.com']);
  assert.equal(row.Mode, 'Test'); assert.equal(row.Status, 'Queued'); assert.equal(row['Recipient Count'], 1);
  assert.match(row['Send Token'], /^[0-9a-f]{32}$/);
  assert.deepEqual(calls.webhooks.at(-1), { recordId: d, token: row['Send Token'] });
});
test('real send: needs subject, message, a matching confirmed count, and is capped', async () => {
  const d = await newDraft(); calls.webhooks.length = 0;
  const base = { action: 'send', draftId: d, mode: 'send', recordIds: IDS, roles: ['primary'], audience: 'AM Falcons', confirmCount: 2 };
  assert.equal((await call({ ...base, subject: '', body: 'x' })).statusCode, 400);
  assert.equal((await call({ ...base, subject: 's', body: '  ' })).statusCode, 400);
  assert.equal((await call({ ...base, subject: 's'.repeat(201), body: 'x' })).statusCode, 400);
  assert.equal((await call({ ...base, subject: 's', body: 'x', confirmCount: 3 })).statusCode, 409); // stale count
  assert.equal((await call({ ...base, subject: 's', body: 'x', roles: [] })).statusCode, 400);      // nobody
  assert.equal(calls.webhooks.length, 0); // none of the refusals reached n8n
  const big = Array.from({ length: 151 }, (_, i) => addStudent(100 + i));
  const r = await call({ ...base, recordIds: big, confirmCount: 151, subject: 's', body: 'x' });
  assert.equal(r.statusCode, 400); assert.match(body(r).error, /limited to 150/);
  assert.equal(calls.webhooks.length, 0);
});
test('real send: queues exactly the confirmed recipients once; a sent draft cannot be sent again', async () => {
  const d = await newDraft(); calls.webhooks.length = 0;
  const r = await call({ action: 'send', draftId: d, mode: 'send', subject: 'Picture day', body: 'Hi\n\nBye', recordIds: IDS, roles: ['primary'], audience: 'AM Falcons', confirmCount: 2 });
  assert.equal(r.statusCode, 200); assert.equal(body(r).queued, 2);
  assert.deepEqual(JSON.parse(emails[d].fields.Recipients).map((x) => x.email).sort(), ['p1@example.com', 'p2@example.com']);
  assert.equal(emails[d].fields.Mode, 'Send'); assert.equal(emails[d].fields['Requested By'], 'pam@example.com');
  assert.equal(calls.webhooks.length, 1);
  emails[d].fields.Status = 'Sent'; // n8n finished
  const again = await call({ action: 'send', draftId: d, mode: 'send', subject: 's', body: 'b', recordIds: IDS, roles: ['primary'], confirmCount: 2 });
  assert.equal(again.statusCode, 409); assert.equal(calls.webhooks.length, 1);
  assert.equal((await call({ action: 'attach', draftId: d, filename: 'late.pdf', base64: b64(10) })).statusCode, 409);
});
test('if n8n cannot be reached the row is marked Failed and the admin is told nothing was sent', async () => {
  const d = await newDraft(); webhookStatus = 500;
  try {
    const r = await call({ action: 'send', draftId: d, mode: 'test', subject: 's', body: 'b' });
    assert.equal(r.statusCode, 502); assert.match(body(r).error, /Nothing was sent/);
    assert.equal(emails[d].fields.Status, 'Failed'); assert.equal(emails[d].fields['Send Token'], '');
  } finally { webhookStatus = 200; }
});
test('after a test send the same draft can still be sent to the group', async () => {
  const d = await newDraft();
  await call({ action: 'send', draftId: d, mode: 'test', subject: 's', body: 'b' });
  emails[d].fields.Status = 'Test sent';
  const r = await call({ action: 'send', draftId: d, mode: 'send', subject: 's', body: 'b', recordIds: IDS, roles: ['primary'], confirmCount: 2 });
  assert.equal(r.statusCode, 200);
});

/* ---- parent/student document uploads are scanned too ---- */
const up = (extra = {}) => upload({ httpMethod: 'POST', body: JSON.stringify({ recordId: 'recABCDEFGHIJKLMN', fieldId: 'fldX', filename: 'id.pdf', contentType: 'application/pdf', base64: b64(300), ...extra }) });
test('document upload: infected file is blocked before it is stored', async () => {
  scannerMode = 'infected'; const before = calls.uploads.length;
  const r = await up();
  assert.equal(r.statusCode, 422); assert.match(JSON.parse(r.body).error.message, /blocked/i);
  assert.equal(calls.uploads.length, before);
  scannerMode = 'clean';
});
test('document upload: fail closed when the scanner is down', async () => {
  scannerMode = 'error';
  try { const r = await up(); assert.equal(r.statusCode, 503); assert.match(JSON.parse(r.body).error.message, /not uploaded/); } finally { scannerMode = 'clean'; }
});
test('document upload: clean file is scanned then stored', async () => {
  const sc = calls.scans.length;
  emails.recABCDEFGHIJKLMN = { id: 'recABCDEFGHIJKLMN', fields: {} };
  const r = await up();
  assert.equal(r.statusCode, 200); assert.equal(calls.scans.length, sc + 1);
});
