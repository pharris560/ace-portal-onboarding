/* Password storage.
   Old accounts hold an unsalted SHA-256 hex in "Password Hash". On the next successful sign-in the
   server also writes a salted, deliberately slow scrypt hash into "Password Hash V2":
       scrypt$<N>$<r>$<p>$<salt b64>$<key b64>$<fingerprint>
   <fingerprint> ties the V2 value to the legacy hash it was made from. If anyone changes the legacy
   hash afterwards (the security-question reset in the browser, or a hash pasted into Airtable),
   the fingerprint stops matching, V2 is ignored, the legacy hash is checked, and V2 is rewritten.
   The Staff Portal's own "scrypt$salt$hash" format in the legacy column is accepted as-is.
   The legacy column is kept for now so a rollback to the previous release still works; once it is
   deliberately blanked (a later cleanup), V2 alone is trusted. */
const crypto = require('crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const HEX64 = /^[0-9a-f]{64}$/i;

const scrypt = (pw, salt, n, r, p, len) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, len, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? reject(e) : resolve(k))));

/* HMAC (keyed from the existing AIRTABLE_PAT) so the stored fingerprint reveals nothing about the legacy hash. */
function fingerprint(legacyHex) {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) throw new Error('AIRTABLE_PAT is not set');
  const key = crypto.createHmac('sha256', pat).update('ace-pw-fingerprint-v1').digest();
  return crypto.createHmac('sha256', key).update(String(legacyHex || '').toLowerCase()).digest('hex').slice(0, 16);
}

async function makeV2(password, legacyHex) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64'), fingerprint(legacyHex)].join('$');
}

const legacyHash = (password) => crypto.createHash('sha256').update(password).digest();

/* Returns { ok, upgrade }. upgrade = a new V2 string the caller should store (only after a correct legacy match). */
async function verifyPassword(password, fields) {
  const legacyHex = String(fields['Password Hash'] || '').trim();

  /* The Staff Portal (staff-portal.flyace.org) shares this column and stores passwords changed there
     as "scrypt$<salt>$<hex>" (salt used as text, scrypt defaults, 32-byte key). Accept it, so one
     password works on both portals. It is already salted and slow, so there is nothing to upgrade. */
  if (legacyHex.startsWith('scrypt$')) {
    const [, salt, expected] = legacyHex.split('$');
    if (!salt || !expected) return { ok: false };
    let actual;
    try { actual = (await scrypt(password, salt, 16384, 8, 1, 32)).toString('hex'); } catch (_) { return { ok: false }; }
    const a = Buffer.from(actual), b = Buffer.from(expected.toLowerCase());
    return { ok: a.length === b.length && crypto.timingSafeEqual(a, b) };
  }

  const v2 = fields['Password Hash V2'] || '';
  const parts = v2.split('$');
  const v2Fresh = parts.length === 7 && parts[0] === 'scrypt' && (legacyHex === '' || parts[6] === fingerprint(legacyHex));

  if (v2Fresh) {
    const [, n, r, p, saltB64, keyB64] = parts;
    const want = Buffer.from(keyB64, 'base64');
    let got;
    try { got = await scrypt(password, Buffer.from(saltB64, 'base64'), +n, +r, +p, want.length); } catch (_) { return { ok: false }; }
    return { ok: got.length === want.length && crypto.timingSafeEqual(got, want) };
  }

  /* No usable V2: check the legacy hash (still runs a comparison when none exists, so timing is similar). */
  const stored = HEX64.test(legacyHex) ? Buffer.from(legacyHex, 'hex') : crypto.randomBytes(32);
  const ok = crypto.timingSafeEqual(legacyHash(password), stored) && HEX64.test(legacyHex);
  if (!ok) return { ok: false };
  return { ok: true, upgrade: await makeV2(password, legacyHex) };
}

module.exports = { verifyPassword, makeV2, fingerprint, N, R, P };
