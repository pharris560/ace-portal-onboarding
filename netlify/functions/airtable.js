/* Netlify serverless proxy — keeps the Airtable PAT server-side.
   Receives requests from the portal, forwards them to Airtable,
   and returns the response. The PAT never reaches the browser.

   Guard rails (added for the flyace.org email-admin feature): the browser can never
   - touch the Email Accounts / Email Activity / Board Members tables (only the signed-in
     admin functions can),
   - create, promote to, edit, or delete an 'Administrator' Portal Account,
   - read admin password hashes, or probe hashes through formulas/sorts. */
const BASE = 'appFVg5UNlwzJMuaY';
const ACCOUNTS = { id: 'tblwJ9C1BQIMGMzKx', name: 'portal accounts' };
const SERVER_ONLY = [
  { id: 'tbljFURQrugQGgZOE', name: 'email accounts' },
  { id: 'tblcHVVOwvXRAH64L', name: 'email activity' },
  { id: 'tblJMfsctvEKNdEp8', name: 'board members' }
];
const SECRET_FIELDS = ['Password Hash', 'Security Answer Hash'];

const reply = (statusCode, message) => ({
  statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message } })
});
const isType = (t, def) => { const s = String(t ?? '').toLowerCase(); return s === def.id.toLowerCase() || s === def.name; };
const isAdminValue = (v) => String(v?.name ?? v ?? '').trim().toLowerCase() === 'administrator';

async function at(PAT, method, path) {
  const r = await fetch('https://api.airtable.com/v0' + path, { method, headers: { Authorization: 'Bearer ' + PAT } });
  return r.ok ? r.json() : null;
}

exports.handler = async function (event) {
  const PAT = process.env.AIRTABLE_PAT;
  if (!PAT) return reply(500, 'AIRTABLE_PAT environment variable is not set in Netlify.');

  /* The portal passes the Airtable path as ?_path=/appXXX/tblXXX[/recXXX] */
  const airtablePath = event.queryStringParameters?._path || '';

  /* Security: only allow requests to the ACE base */
  if (!airtablePath.startsWith('/' + BASE + '/')) return reply(403, 'Forbidden — unknown base.');

  /* Strip _path from the raw query string, preserve everything else (filters, fields, offset) */
  const rawQuery = event.rawQuery || '';
  const cleanQuery = rawQuery.replace(/(?:^|&)_path=[^&]*/g, '').replace(/^&/, '');

  let segs;
  try { segs = airtablePath.split('/').filter(Boolean).map(decodeURIComponent); } catch (_) { return reply(400, 'Bad path.'); }
  const table = segs[1] || '';
  const method = event.httpMethod;
  const isRead = method === 'GET' || method === 'HEAD';

  if (segs.some(s => s === '..')) return reply(400, 'Bad path.');
  if (SERVER_ONLY.some(t => isType(table, t))) return reply(403, 'Forbidden — this table is managed by the admin email tools only.');

  if (isType(table, ACCOUNTS)) {
    let body = null;
    if (event.body && !isRead) { try { body = JSON.parse(event.body); } catch (_) { return reply(400, 'Bad body.'); } }

    if (isRead) {
      /* Only two query shapes exist in the portal: one record by id, or look up by email.
         Anything else (fields[], sort, other formulas) could be used to probe hashes. */
      const params = new URLSearchParams(cleanQuery);
      for (const k of params.keys()) if (!['filterByFormula', 'maxRecords', 'pageSize'].includes(k)) return reply(403, 'Forbidden query.');
      const f = params.get('filterByFormula');
      if (f !== null && !/^LOWER\(\{Email\}\)='[a-z0-9._%+\-@]{1,254}'$/.test(f)) return reply(403, 'Forbidden query.');
    } else {
      /* Writes: no admin can be created, promoted, edited or removed from the browser. */
      if (body && body.performUpsert) return reply(403, 'Forbidden.');
      const rows = body ? (Array.isArray(body.records) ? body.records : [body]) : [];
      for (const row of rows) if (isAdminValue(row?.fields?.['Account Type'])) return reply(403, 'Administrator accounts can only be changed in Airtable.');
      const ids = new Set();
      if (segs[2]) ids.add(segs[2]);
      rows.forEach(r => r?.id && ids.add(r.id));
      new URLSearchParams(cleanQuery).forEach((v, k) => { if (k.startsWith('records')) ids.add(v); });
      for (const id of ids) {
        const cur = await at(PAT, 'GET', '/' + BASE + '/' + ACCOUNTS.id + '/' + encodeURIComponent(id));
        if (!cur || isAdminValue(cur.fields?.['Account Type'])) return reply(403, 'Administrator accounts can only be changed in Airtable.');
      }
    }
  }

  const airtableUrl = 'https://api.airtable.com/v0' + airtablePath + (cleanQuery ? '?' + cleanQuery : '');
  const fetchOptions = {
    method,
    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' }
  };
  if (event.body && !isRead) fetchOptions.body = event.body;

  try {
    const response = await fetch(airtableUrl, fetchOptions);
    let text = await response.text();

    /* Admin password hashes never leave the server; Administrators sign in through admin-login. */
    if (isType(table, ACCOUNTS) && isRead && response.ok) {
      try {
        const j = JSON.parse(text);
        const scrub = (rec) => { if (rec?.fields && isAdminValue(rec.fields['Account Type'])) SECRET_FIELDS.forEach(k => delete rec.fields[k]); };
        (j.records || [j]).forEach(scrub);
        text = JSON.stringify(j);
      } catch (_) { /* leave as is */ }
    }
    return { statusCode: response.status, headers: { 'Content-Type': 'application/json' }, body: text };
  } catch (err) {
    return reply(502, 'Proxy error: ' + err.message);
  }
};
