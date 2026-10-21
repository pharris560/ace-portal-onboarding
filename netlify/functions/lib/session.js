/* Signed admin session tokens + shared helpers for the email-admin functions.
   The signing key is derived from the existing AIRTABLE_PAT env var, so no new Netlify
   setting is needed. Rotating the PAT invalidates every open admin session (fine). */
const crypto = require('crypto');

const BASE_ID = 'appFVg5UNlwzJMuaY';
const TABLE_ACCOUNTS = 'tblwJ9C1BQIMGMzKx';
const SESSION_MINUTES = 30;          /* Administrator sessions */
const MEMBER_SESSION_MINUTES = 120;  /* everyone else: automatic sign-out after 2 hours */
const COOKIE_NAME = 'ace_session';

/* Account Type (Portal Accounts) -> portal role. Staff, Volunteer and Board sign in with an
   emailed one-time code, never a password. Every other type is a parent/student password login. */
const CODE_ROLES = ['staff', 'volunteer', 'board'];
function roleFor(accountType) {
  const t = String(accountType?.name ?? accountType ?? '').trim().toLowerCase();
  if (t === 'administrator') return 'admin';
  if (t === 'staff' || t === 'volunteer' || t === 'board') return t;
  return 'parent';
}
const sessionMinutes = (role) => (role === 'admin' ? SESSION_MINUTES : MEMBER_SESSION_MINUTES);

function key() {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) throw new Error('AIRTABLE_PAT is not set');
  return crypto.createHmac('sha256', pat).update('ace-admin-session-v1').digest();
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function signToken(claims, minutes = SESSION_MINUTES) {
  const payload = b64(JSON.stringify({ ...claims, exp: Date.now() + minutes * 60 * 1000 }));
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

/* ---- HttpOnly session cookie (all roles) ---- */
function sessionCookie(token, minutes) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + Math.round(minutes * 60);
}
const clearCookie = () => COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

function readCookie(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return '';
}

/* Returns { rec, email, name, role } for a genuine, unexpired cookie whose account still exists.
   The role is re-read from Airtable every time, so changing someone's Account Type takes effect
   immediately, not when their cookie expires. */
async function getSession(event) {
  const claims = verifyToken(readCookie(event));
  if (!claims || claims.kind !== 'portal' || !claims.rec) return null;
  const acct = await airtable('GET', '/' + BASE_ID + '/' + TABLE_ACCOUNTS + '/' + encodeURIComponent(claims.rec));
  if (!acct) return null;
  return { rec: acct.id, email: acct.fields.Email, name: acct.fields['Full Name'], role: roleFor(acct.fields['Account Type']) };
}

/* null unless the signed-in person holds one of the allowed roles. Used by every function that
   later replaces the open proxy. */
async function requireRole(event, roles) {
  const s = await getSession(event);
  return s && roles.includes(s.role) ? s : null;
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

module.exports = {
  BASE_ID, TABLE_ACCOUNTS, CODE_ROLES, roleFor, sessionMinutes, signToken, verifyToken, requireAdmin,
  sessionCookie, clearCookie, readCookie, getSession, requireRole, airtable, json
};
