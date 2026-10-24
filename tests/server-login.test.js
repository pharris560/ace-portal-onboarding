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
let failPatch = false;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  const m = u.pathname.match(/\/v0\/appFVg5UNlwzJMuaY\/tblwJ9C1BQIMGMzKx(?:\/(rec\w+))?$/);
  if (!m) return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
  if (opts.method && opts.method !== 'GET') {
    writes.push({ method: opts.method, url, body: opts.body });
    if (opts.method === 'PATCH' && m[1] && accounts[m[1]] && !failPatch) Object.assign(accounts[m[1]].fields, JSON.parse(opts.body).fields);
    if (failPatch) return { ok: false, status: 422, json: async () => ({}), text: async () => '{}' };
    return ok({ id: m[1] || 'recNEW', fields: {} });
  }
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

/* ---------- stage 2: salted slow hashes with silent upgrade ---------- */
const P = require('../netlify/functions/lib/password');

test('first sign-in with an old SHA-256 account silently stores a salted scrypt hash', async () => {
  add('recOLD', 'old@example.com', 'Existing Student', 'old-pw-1');
  assert.equal(accounts.recOLD.fields['Password Hash V2'], undefined);
  const r = await post('old@example.com', 'old-pw-1');
  assert.equal(r.statusCode, 200);
  const v2 = accounts.recOLD.fields['Password Hash V2'];
  const parts = v2.split('$');
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '16384', '8', '1']);
  assert.equal(parts.length, 7);
  assert.equal(Buffer.from(parts[4], 'base64').length, 16); // 16-byte random salt
  assert.equal(Buffer.from(parts[5], 'base64').length, 64);
  assert.ok(!v2.includes(sha('old-pw-1')) && !v2.includes('old-pw-1'));
  assert.ok(!JSON.parse(r.body).hasOwnProperty('password'));
});
test('two upgrades of the same password get different salts and different hashes', async () => {
  const a = await P.makeV2('same-pw', 'x'), b = await P.makeV2('same-pw', 'x');
  assert.notEqual(a.split('$')[4], b.split('$')[4]);
  assert.notEqual(a.split('$')[5], b.split('$')[5]);
});
test('after the upgrade the scrypt hash alone is enough (the legacy column can be cleaned up later)', async () => {
  delete accounts.recOLD.fields['Password Hash'];
  assert.equal((await post('old@example.com', 'wrong-pw')).statusCode, 401);
  assert.equal((await post('old@example.com', 'old-pw-1')).statusCode, 200);
});
test('upgraded account: right password works, wrong one fails', async () => {
  add('recUP', 'up@example.com', 'Existing Student', 'up-pw-1');
  assert.equal((await post('up@example.com', 'up-pw-1')).statusCode, 200); // upgrades
  assert.ok(accounts.recUP.fields['Password Hash V2']);
  assert.equal((await post('up@example.com', 'up-pw-1')).statusCode, 200); // verified via scrypt
  assert.equal((await post('up@example.com', 'wrong-pw')).statusCode, 401);
  const writesBefore = writes.length;
  await post('up@example.com', 'up-pw-1');
  assert.equal(writes.length, writesBefore); // no rewrite once upgraded
});
test('changing the legacy hash later (browser reset, or pasted in Airtable) wins over a stale V2', async () => {
  add('recRST', 'rst@example.com', 'Existing Student', 'first-pw-1');
  await post('rst@example.com', 'first-pw-1'); // upgrade
  accounts.recRST.fields['Password Hash'] = sha('reset-pw-2'); // what the old reset flow / a manual edit does
  assert.equal((await post('rst@example.com', 'first-pw-1')).statusCode, 401, 'old password must stop working');
  assert.equal((await post('rst@example.com', 'reset-pw-2')).statusCode, 200);
  assert.equal((await post('rst@example.com', 'reset-pw-2')).statusCode, 200); // now verified by the refreshed V2
});
test('a failed upgrade write never blocks sign-in', async () => {
  add('recFAIL', 'fail@example.com', 'Existing Student', 'fail-pw-1');
  failPatch = true;
  try { assert.equal((await post('fail@example.com', 'fail-pw-1')).statusCode, 200); } finally { failPatch = false; }
});
test('administrator accounts upgrade too', async () => {
  add('recADM2', 'adm2@example.com', 'Administrator', 'adm-pw-1');
  const r = await post('adm2@example.com', 'adm-pw-1');
  assert.ok(JSON.parse(r.body).token);
  assert.ok(accounts.recADM2.fields['Password Hash V2']);
});
test('an account with no password at all cannot sign in with an empty-hash trick', async () => {
  add('recNOPW', 'nopw@example.com', 'Existing Student', null);
  assert.equal((await post('nopw@example.com', 'anything')).statusCode, 401);
  accounts.recNOPW.fields['Password Hash'] = sha('');
  assert.equal((await post('nopw@example.com', 'anything')).statusCode, 401);
});
test('hashing cost is real but fast enough for sign-in (well under a second)', async () => {
  const t = Date.now(); await P.makeV2('timing-test', 'x'); const ms = Date.now() - t;
  assert.ok(ms > 5 && ms < 1000, 'took ' + ms + 'ms');
});

/* proxy: hashes never reach the browser */
const proxyGet = async (rec) => {
  const fetch0 = global.fetch;
  global.fetch = async (url, o) => (String(url).includes('filterByFormula') || /tblwJ9C1BQIMGMzKx\/rec/.test(String(url)))
    ? { ok: true, status: 200, text: async () => JSON.stringify({ records: [{ id: rec.id, fields: rec.fields }] }), json: async () => ({}) } : fetch0(url, o);
  try {
    return await proxy({ httpMethod: 'GET', queryStringParameters: { _path: '/appFVg5UNlwzJMuaY/tblwJ9C1BQIMGMzKx' }, rawQuery: "_path=%2FappFVg5UNlwzJMuaY%2FtblwJ9C1BQIMGMzKx&filterByFormula=" + encodeURIComponent("LOWER({Email})='x@y.z'") });
  } finally { global.fetch = fetch0; }
};
test('proxy: password hashes are removed from every Portal Accounts read (parents, staff, admins)', async () => {
  for (const id of ['recUP', 'recPARENT', 'recADMIN']) {
    const r = await proxyGet(accounts[id]);
    assert.equal(r.statusCode, 200);
    const f = JSON.parse(r.body).records[0].fields;
    assert.equal(f['Password Hash'], undefined, id); assert.equal(f['Password Hash V2'], undefined, id);
    assert.ok(f.Email, 'other fields still come through');
  }
});
test('proxy: a browser can never write the V2 hash field (create or edit)', async () => {
  assert.equal((await proxyWrite('POST', { fields: { Email: 'q@y.z', 'Account Type': 'New Applicant', 'Password Hash V2': 'x' } })).statusCode, 403);
  assert.equal((await proxyWrite('PATCH', { fields: { 'Password Hash V2': 'x' } }, '/appFVg5UNlwzJMuaY/tblwJ9C1BQIMGMzKx/recPARENT')).statusCode, 403);
});
