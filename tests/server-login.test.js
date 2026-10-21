/* Mocked guard tests for the server-side sign-in (no live Airtable). Run: npm run test:server */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.AIRTABLE_PAT = 'patTEST.secret';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* Fake Airtable: Portal Accounts rows keyed by id. */
const accounts = {};
const add = (id, email, type, pw, name = 'Test ' + id) => { accounts[id] = { id, fields: { Email: email, 'Full Name': name, 'Account Type': { name: type }, ...(pw ? { 'Password Hash': sha(pw) } : {}) } }; };
add('recPARENT', 'parent@example.com', 'Existing Student', 'parent-pw-1');
add('recAPPL', 'new@example.com', 'New Applicant', 'applicant-pw-1');
add('recADMIN', 'admin@example.com', 'Administrator', 'admin-pw-1');
add('recSTAFF', 'staff@example.com', 'Staff', null);
add('recVOL', 'vol@example.com', 'Volunteer', null);
add('recBOARD', 'board@example.com', 'Board', null);
const writes = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const m = u.pathname.match(/\/v0\/appFVg5UNlwzJMuaY\/tblwJ9C1BQIMGMzKx(?:\/(rec\w+))?$/);
  if (!m) return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
  if (opts.method && opts.method !== 'GET') { writes.push({ method: opts.method, url, body: opts.body }); return ok({ id: m[1] || 'recNEW', fields: {} }); }
  if (m[1]) return accounts[m[1]] ? ok(accounts[m[1]]) : { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
  const f = u.searchParams.get('filterByFormula') || '';
  const em = f.match(/LOWER\(\{Email\}\)='([^']+)'/);
  return ok({ records: Object.values(accounts).filter(a => em && a.fields.Email.toLowerCase() === em[1]) });
};

const S = require('../netlify/functions/lib/session');
const login = require('../netlify/functions/portal-login').handler;
const sessionFn = require('../netlify/functions/portal-session').handler;
const proxy = require('../netlify/functions/airtable').handler;

const post = (email, password) => login({ httpMethod: 'POST', body: JSON.stringify({ email, password }) });
const cookieOf = (res) => res.headers['Set-Cookie'].split(';')[0];
const asCookie = (c) => ({ httpMethod: 'GET', headers: { cookie: c } });

test('parent: correct password signs in; cookie is HttpOnly, Secure, 2 hours', async () => {
  const r = await post('Parent@Example.com', 'parent-pw-1');
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.equal(b.role, 'parent'); assert.equal(b.token, undefined); assert.equal(b.expiresInMinutes, 120);
  const c = r.headers['Set-Cookie'];
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/); assert.match(c, /Max-Age=7200/);
  assert.equal(JSON.parse(r.body).password, undefined);
});
test('new applicant is a parent-role password login too', async () => {
  const r = await post('new@example.com', 'applicant-pw-1');
  assert.equal(JSON.parse(r.body).role, 'parent');
});
test('administrator: 30-minute cookie plus bearer token', async () => {
  const r = await post('admin@example.com', 'admin-pw-1');
  const b = JSON.parse(r.body);
  assert.equal(b.role, 'admin'); assert.ok(b.token); assert.match(r.headers['Set-Cookie'], /Max-Age=1800/);
  assert.ok(await S.requireAdmin({ headers: { authorization: 'Bearer ' + b.token } }));
});
test('wrong password: 401 and no cookie', async () => {
  const r = await post('parent@example.com', 'nope');
  assert.equal(r.statusCode, 401); assert.equal(r.headers['Set-Cookie'], undefined);
});
test('unknown email: 404', async () => { assert.equal((await post('ghost@example.com', 'x')).statusCode, 404); });
test('formula-injection style email is rejected', async () => {
  assert.equal((await post("x'),TRUE(),LOWER('a", 'x')).statusCode, 400);
});
test('staff, volunteer and board cannot use a password (code roles), even with a hash', async () => {
  for (const e of ['staff@example.com', 'vol@example.com', 'board@example.com']) {
    const r = await post(e, 'anything');
    assert.equal(r.statusCode, 409); assert.equal(r.headers['Set-Cookie'], undefined);
  }
  accounts.recSTAFF.fields['Password Hash'] = sha('pw'); // stray hash must not open the door
  assert.equal((await post('staff@example.com', 'pw')).statusCode, 409);
});
test('throttle: 6th bad try in a row is 429, even with the right password', async () => {
  add('recVIC', 'vic2@example.com', 'Existing Student', 'right-pw-1');
  for (let i = 0; i < 5; i++) assert.equal((await post('vic2@example.com', 'bad')).statusCode, 401);
  assert.equal((await post('vic2@example.com', 'right-pw-1')).statusCode, 429);
});

test('session: valid cookie returns the role; role is re-read live', async () => {
  const c = cookieOf(await post('parent@example.com', 'parent-pw-1'));
  let r = await sessionFn(asCookie(c));
  assert.equal(r.statusCode, 200); assert.equal(JSON.parse(r.body).role, 'parent');
  accounts.recPARENT.fields['Account Type'] = { name: 'Staff' };
  assert.equal(JSON.parse((await sessionFn(asCookie(c))).body).role, 'staff');
  accounts.recPARENT.fields['Account Type'] = { name: 'Existing Student' };
});
test('session: no cookie, tampered cookie, and a deleted account are all 401', async () => {
  assert.equal((await sessionFn({ httpMethod: 'GET', headers: {} })).statusCode, 401);
  const c = cookieOf(await post('parent@example.com', 'parent-pw-1'));
  assert.equal((await sessionFn(asCookie(c.slice(0, -3) + 'AAA'))).statusCode, 401);
  const forged = 'ace_session=' + Buffer.from(JSON.stringify({ rec: 'recADMIN', kind: 'portal', exp: Date.now() + 1e6 })).toString('base64url') + '.AAAA';
  assert.equal((await sessionFn(asCookie(forged))).statusCode, 401);
  const gone = 'ace_session=' + S.signToken({ rec: 'recGONE', kind: 'portal' }, 5);
  assert.equal((await sessionFn(asCookie(gone))).statusCode, 401);
});
test('session: expires after 2 hours', async () => {
  const c = cookieOf(await post('parent@example.com', 'parent-pw-1'));
  const real = Date.now;
  try {
    Date.now = () => real() + 119 * 60 * 1000;
    assert.equal((await sessionFn(asCookie(c))).statusCode, 200);
    Date.now = () => real() + 121 * 60 * 1000;
    assert.equal((await sessionFn(asCookie(c))).statusCode, 401);
  } finally { Date.now = real; }
});
test('admin session expires after 30 minutes', async () => {
  const c = cookieOf(await post('admin@example.com', 'admin-pw-1'));
  const real = Date.now;
  try { Date.now = () => real() + 31 * 60 * 1000; assert.equal((await sessionFn(asCookie(c))).statusCode, 401); } finally { Date.now = real; }
});
test('an admin bearer token is not a portal cookie (different kind)', async () => {
  const tok = S.signToken({ rec: 'recADMIN' });
  assert.equal((await sessionFn(asCookie('ace_session=' + tok))).statusCode, 401);
});
test('sign out clears the cookie', async () => {
  const r = await sessionFn({ httpMethod: 'POST', headers: {} });
  assert.match(r.headers['Set-Cookie'], /Max-Age=0/);
});
test('requireRole allows only the listed roles', async () => {
  const p = asCookie(cookieOf(await post('parent@example.com', 'parent-pw-1')));
  assert.equal(await S.requireRole(p, ['staff', 'admin']), null);
  assert.ok(await S.requireRole(p, ['parent']));
  assert.equal(await S.requireRole({ headers: {} }, ['parent']), null);
});

const proxyWrite = (method, body, path = '/appFVg5UNlwzJMuaY/tblwJ9C1BQIMGMzKx') => proxy({ httpMethod: method, queryStringParameters: { _path: path }, rawQuery: '_path=' + encodeURIComponent(path), body: JSON.stringify(body) });
test('proxy: a browser can register only as New Applicant / Existing Student', async () => {
  for (const t of ['Staff', 'Volunteer', 'Board', 'Administrator', 'Existing Volunteer']) {
    assert.equal((await proxyWrite('POST', { fields: { Email: 'x@y.z', 'Account Type': t } })).statusCode, 403, t);
  }
  assert.equal((await proxyWrite('POST', { fields: { Email: 'x@y.z', 'Account Type': 'New Applicant' } })).statusCode, 200);
  assert.equal((await proxyWrite('PATCH', { fields: { 'Account Type': 'Existing Student' } }, '/appFVg5UNlwzJMuaY/tblwJ9C1BQIMGMzKx/recPARENT')).statusCode, 200);
});
test('proxy: a browser cannot promote itself to Staff by PATCH', async () => {
  const r = await proxyWrite('PATCH', { fields: { 'Account Type': 'Staff' } }, '/appFVg5UNlwzJMuaY/tblwJ9C1BQIMGMzKx/recPARENT');
  assert.equal(r.statusCode, 403);
});
test('proxy: a browser cannot edit or delete Administrator, Staff, Volunteer or Board accounts (any field)', async () => {
  for (const id of ['recADMIN', 'recSTAFF', 'recVOL', 'recBOARD']) {
    for (const method of ['PATCH', 'DELETE']) {
      const r = await proxyWrite(method, { fields: { Email: 'attacker@evil.test' } }, '/appFVg5UNlwzJMuaY/tblwJ9C1BQIMGMzKx/' + id);
      assert.equal(r.statusCode, 403, method + ' ' + id);
    }
  }
});
