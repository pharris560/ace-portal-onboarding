/* GET  -> who is signed in right now (role re-read live from Airtable), or 401.
   POST -> sign out: clears the session cookie. */
const { getSession, clearCookie, json } = require('./lib/session');

exports.handler = async function (event) {
  if (event.httpMethod === 'POST') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie(), 'Cache-Control': 'no-store' }, body: '{"ok":true}' };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'GET or POST only' });
  const s = await getSession(event);
  if (!s) return { statusCode: 401, headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie(), 'Cache-Control': 'no-store' }, body: '{"error":"Not signed in"}' };
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ rec: s.rec, email: s.email, name: s.name, role: s.role }) };
};
