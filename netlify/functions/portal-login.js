/* One sign-in endpoint for every role. The server (not the browser) looks the account up,
   checks the password, decides the role, and sets an HttpOnly session cookie:
     Administrator -> 30 minutes (also returns the bearer token the email-admin tools use)
     Parent/Student -> 2 hours
     Staff / Volunteer / Board -> no password; they sign in with an emailed one-time code (later stage). */
const { verifyPassword } = require('./lib/password');
const { BASE_ID, TABLE_ACCOUNTS, CODE_ROLES, roleFor, sessionMinutes, signToken, sessionCookie, airtable, json } = require('./lib/session');

/* Best-effort throttle (per warm function instance): 5 bad tries / 15 min per email. */
const fails = new Map();
const MAX_FAILS = 5, WINDOW_MS = 15 * 60 * 1000;
function throttled(k) {
  const now = Date.now();
  const list = (fails.get(k) || []).filter(t => now - t < WINDOW_MS);
  fails.set(k, list);
  return list.length >= MAX_FAILS;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  let email, password;
  try { ({ email, password } = JSON.parse(event.body || '{}')); } catch (_) { return json(400, { error: 'Bad request' }); }
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!/^[a-z0-9._%+\-@]{3,254}$/.test(email) || !password) return json(400, { error: 'Email and password required' });
  if (throttled(email)) return json(429, { error: 'Too many attempts. Try again in 15 minutes.' });

  const formula = "LOWER({Email})='" + email + "'";
  const data = await airtable('GET', '/' + BASE_ID + '/' + TABLE_ACCOUNTS + '?maxRecords=2&filterByFormula=' + encodeURIComponent(formula));
  if (data === null) return json(502, { error: 'Could not sign you in right now.' });
  const acct = data.records?.length ? data.records[0] : null;
  if (!acct) return json(404, { error: 'No account found with this email. Please check your email or create a new account.' });

  const role = roleFor(acct.fields['Account Type']);
  if (CODE_ROLES.includes(role)) return json(409, { error: 'Staff and volunteers sign in with an emailed code, not a password.', method: 'code' });

  const check = await verifyPassword(password, acct.fields);
  if (!check.ok) {
    fails.set(email, [...(fails.get(email) || []), Date.now()]);
    return json(401, { error: 'Incorrect password. Please try again.' });
  }
  fails.delete(email);

  /* Silent upgrade: an old SHA-256 account gets its salted scrypt hash now. A failed write never blocks sign-in. */
  if (check.upgrade) {
    await airtable('PATCH', '/' + BASE_ID + '/' + TABLE_ACCOUNTS + '/' + acct.id, { fields: { 'Password Hash V2': check.upgrade } }).catch(() => null);
  }

  const minutes = sessionMinutes(role);
  const out = {
    rec: acct.id, email: acct.fields.Email, name: acct.fields['Full Name'], role,
    type: acct.fields['Account Type']?.name || acct.fields['Account Type'] || '',
    expiresInMinutes: minutes
  };
  if (role === 'admin') out.token = signToken({ rec: acct.id });
  const cookie = sessionCookie(signToken({ rec: acct.id, kind: 'portal' }, minutes), minutes);
  return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' }, body: JSON.stringify(out) };
};
