/* Signed admin session tokens + shared helpers for the email-admin functions.
   The signing key is derived from the existing AIRTABLE_PAT env var, so no new Netlify
   setting is needed. Rotating the PAT invalidates every open admin session (fine). */
const crypto = require('crypto');

const BASE_ID = 'appFVg5UNlwzJMuaY';
const TABLE_ACCOUNTS = 'tblwJ9C1BQIMGMzKx';
const SESSION_MINUTES = 30;

function key() {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) throw new Error('AIRTABLE_PAT is not set');
  return crypto.createHmac('sha256', pat).update('ace-admin-session-v1').digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signToken(claims) {
  const payload = b64(JSON.stringify({ ...claims, exp: Date.now() + SESSION_MINUTES * 60 * 1000 }));
  const sig = b64(crypto.createHmac('sha256', key()).update(payload).digest());
  return payload + '.' + sig;
}

/* Returns the claims if the token is genuine and unexpired, else null. */
function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', key()).update(payload).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch (_) { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!claims || typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
  return claims;
}

/* Reads "Authorization: Bearer <token>" and re-checks the account is STILL an Administrator,
   so removing the Administrator type in Airtable cuts access immediately, not at expiry. */
async function requireAdmin(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const claims = verifyToken(auth.replace(/^Bearer\s+/i, ''));
  if (!claims || !claims.rec) return null;
  const acct = await airtable('GET', '/' + BASE_ID + '/' + TABLE_ACCOUNTS + '/' + encodeURIComponent(claims.rec));
  const type = acct?.fields?.['Account Type']?.name || acct?.fields?.['Account Type'];
  if (type !== 'Administrator') return null;
  return { rec: claims.rec, email: acct.fields.Email, name: acct.fields['Full Name'] };
}

async function airtable(method, path, body) {
  const res = await fetch('https://api.airtable.com/v0' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_PAT, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) return null;
  return res.json();
}

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

module.exports = { BASE_ID, TABLE_ACCOUNTS, signToken, verifyToken, requireAdmin, airtable, json };
