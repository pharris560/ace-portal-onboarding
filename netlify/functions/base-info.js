/* Tells the Administrator dashboard which Airtable base the portal is really reading and
   writing, so staff can confirm it is the current school year's base. Asks Airtable for the
   live name; if the access key lacks permission to read base names, falls back to the name
   recorded below and says so (source: 'recorded'), so the page never claims a check it did not do. */
const { BASE_ID, requireAdmin, json } = require('./lib/session');

const RECORDED_NAME = '2026 - 2027 ACE Student Enrollment'; /* update when ACE rolls to a new school year */

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'GET only' });
  if (!(await requireAdmin(event))) return json(401, { error: 'Administrator sign-in required' });
  try {
    const res = await fetch('https://api.airtable.com/v0/meta/bases', { headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_PAT } });
    if (res.ok) {
      const j = await res.json();
      const base = (j.bases || []).find(b => b.id === BASE_ID);
      if (base && base.name) return json(200, { name: base.name, baseId: BASE_ID, source: 'airtable' });
    }
  } catch (_) { /* fall through */ }
  return json(200, { name: RECORDED_NAME, baseId: BASE_ID, source: 'recorded' });
};
