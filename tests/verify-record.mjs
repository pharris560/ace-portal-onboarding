#!/usr/bin/env node
// Read-only verification helper for a submitted student record.
//
// After you do a LIVE submit on the portal, run this to confirm the record landed in Airtable
// with the right fields — WITHOUT logging into Airtable and eyeballing. It only ever does GETs,
// through the portal's own Netlify proxy (which holds the PAT server-side), so it can never write.
//
// Usage:
//   node tests/verify-record.mjs --email jamie@example.com     # newest record for a parent email
//   node tests/verify-record.mjs --id recXXXXXXXXXXXXXX        # a specific record id
//   node tests/verify-record.mjs --email x@y.com --new         # also assert it looks like a fresh submit
//   node tests/verify-record.mjs --id recXXXX --json           # raw JSON dump
//   [--base https://hilarious-cactus-c41afa.netlify.app]       # override host (defaults to portal.flyace.org)
//
// Exit code: 0 if the record was found (and, with --new, all fresh-submit checks passed); 1 otherwise.

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);

const BASE = opt('--base') || 'https://portal.flyace.org';
const AT_BASE_ID = 'appFVg5UNlwzJMuaY';
const AT_TABLE_ALL = 'tbluHnJc9VM6l4U6V';
const email = opt('--email');
const id = opt('--id');
const wantNew = has('--new');
const rawJson = has('--json');

if (!email && !id) {
  console.error('Provide --email <parent email> or --id <recordId>. See header for usage.');
  process.exit(1);
}

const proxy = (path, qs) =>
  `${BASE}/.netlify/functions/airtable?_path=${encodeURIComponent(path)}${qs ? '&' + qs : ''}`;

const VALID_STATUS = ['Active', 'Pending', 'Flight Circle', 'Schedule Interview', 'Inactive', 'Graduate', 'Waiting List', 'Withdrawn', 'Need Proof of Citizenship', 'Non-Citizen', 'Never Scheduled Interview'];
const VALID_NR = ['New', 'Returning'];

const val = (v) => (v && typeof v === 'object' && 'name' in v ? v.name : v);
const line = (ok, label, detail) => console.log(`  ${ok === null ? '•' : ok ? '✓' : '✗'} ${label}${detail != null ? ': ' + detail : ''}`);

async function getRecord() {
  if (id) {
    const res = await fetch(proxy(`/${AT_BASE_ID}/${AT_TABLE_ALL}/${id}`));
    if (!res.ok) throw new Error(`proxy ${res.status} fetching record ${id}`);
    return res.json();
  }
  const formula = `LOWER({Primary Parent Email})='${email.toLowerCase()}'`;
  const res = await fetch(proxy(`/${AT_BASE_ID}/${AT_TABLE_ALL}`, `filterByFormula=${encodeURIComponent(formula)}`));
  if (!res.ok) throw new Error(`proxy ${res.status} searching ${email}`);
  const data = await res.json();
  const recs = data.records || [];
  if (!recs.length) return null;
  // newest by Portal Last Updated / Application Completion Date, else last returned
  recs.sort((a, b) => String(b.fields['Portal Last Updated'] || b.fields['Application Completion Date'] || '')
    .localeCompare(String(a.fields['Portal Last Updated'] || a.fields['Application Completion Date'] || '')));
  return recs[0];
}

(async () => {
  let rec;
  try { rec = await getRecord(); } catch (e) { console.error('Error:', e.message); process.exit(1); }
  if (!rec || !rec.fields) {
    console.log(email ? `No record found for parent email ${email}.` : `No record found with id ${id}.`);
    process.exit(1);
  }
  const f = rec.fields;
  if (rawJson) { console.log(JSON.stringify(rec, null, 2)); process.exit(0); }

  const name = [val(f['First Name']), val(f['Middle Name']), val(f['Last Name'])].filter(Boolean).join(' ');
  console.log(`\nRecord ${rec.id}  —  ${name || '(no name)'}   [${BASE}]\n`);

  // Core identity / contact
  console.log('Student');
  line(!!name, 'Name', name || '(missing)');
  line(null, 'Grade', val(f['Grade']) || '—');
  line(null, 'Shirt Size', val(f['Shirt Size']) || '—');
  line(!!f['Student Email Address'], 'Student Email', f['Student Email Address'] || '(missing)');
  line(null, 'Gender', val(f['Gender']) || '—');
  line(null, 'School', f['School'] || '—');
  line(null, 'Student ID', f['Student ID Number'] || '—');

  console.log('Parents / address');
  line(!!f['Primary Parent Email'], 'Primary Parent Email', f['Primary Parent Email'] || '(missing)');
  line(null, 'Primary Parent', [f['Primary Parent First Name'], f['Primary Parent Last Name']].filter(Boolean).join(' ') || '—');
  line(null, 'Secondary Parent', [f['Secondary Parent First Name'], f['Secondary Parent Last Name']].filter(Boolean).join(' ') || '—');
  line(null, 'Home Address', [f['Address'], f['City'], f['County'], f['Zip Code']].filter(Boolean).join(', ') || '—');

  // Onboarding-specific integrity checks
  console.log('Onboarding checks');
  const status = val(f['Status']);
  line(VALID_STATUS.includes(status), 'Status is a valid option', status || '(empty)');
  const nr = val(f['New/Returning']);
  line(VALID_NR.includes(nr), "New/Returning is 'New' or 'Returning'", nr || '(empty)');
  const attendance = (f['Attendance'] || []).map(val);
  line(attendance.length === 1, 'Attendance is exactly one session', attendance.join(', ') || '(none)');
  const docs = f['Documents'] || [];
  line(docs.length >= 1, 'Proof-of-citizenship attached (Documents)', `${docs.length} file(s)`);
  line(null, 'ID Expiration Date', f['ID Expiration Date'] || '—');
  line(null, 'Medical Expiration Date', f['Medical Expiration Date'] || '—');
  line(!!f['Student Essay'], 'Student Essay present', f['Student Essay'] ? `${String(f['Student Essay']).length} chars` : '(missing)');

  let freshOk = true;
  if (wantNew) {
    console.log('Fresh-submit assertions (--new)');
    const s1 = status === 'Pending'; line(s1, "Status === 'Pending'", status); freshOk = freshOk && s1;
    const s2 = nr === 'New'; line(s2, "New/Returning === 'New'", nr); freshOk = freshOk && s2;
    const s3 = attendance.length === 1; line(s3, 'exactly one attendance session', attendance.join(', ')); freshOk = freshOk && s3;
    const s4 = docs.length >= 1; line(s4, 'proof-of-citizenship on file', `${docs.length} file(s)`); freshOk = freshOk && s4;
  }
  console.log('');
  process.exit(wantNew && !freshOk ? 1 : 0);
})();
