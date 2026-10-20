/* Server-side Administrator sign-in. Verifies the password here (never in the browser) and
   returns a signed, 30-minute session token that the email-admin function requires.
   Only a Portal Account whose Account Type is 'Administrator' can obtain a token. */
const crypto = require('crypto');
const { BASE_ID, TABLE_ACCOUNTS, signToken, airtable, json } = require('./lib/session');

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
  if (!/^[a-z0-9._%+\-@']{3,254}$/.test(email) || email.includes("'") || !password) return json(400, { error: 'Email and password required' });
  if (throttled(email)) return json(429, { error: 'Too many attempts. Try again in 15 minutes.' });

  const formula = "AND(LOWER({Email})='" + email + "',{Account Type}='Administrator')";
  const data = await airtable('GET', '/' + BASE_ID + '/' + TABLE_ACCOUNTS + '?maxRecords=2&filterByFormula=' + encodeURIComponent(formula));
  const acct = data?.records?.length === 1 ? data.records[0] : null;

  const given = crypto.createHash('sha256').update(password).digest();
  const stored = acct && /^[0-9a-f]{64}$/i.test(acct.fields['Password Hash'] || '') ? Buffer.from(acct.fields['Password Hash'], 'hex') : crypto.randomBytes(32);
  const ok = acct && crypto.timingSafeEqual(given, stored);
  if (!ok) {
    fails.set(email, [...(fails.get(email) || []), Date.now()]);
    return json(401, { error: 'Incorrect email or password' });
  }
  fails.delete(email);
  return json(200, { token: signToken({ rec: acct.id }), name: acct.fields['Full Name'], email: acct.fields.Email });
};
