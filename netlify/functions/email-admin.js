/* flyace.org email administration — Administrator-only (signed token from admin-login).
   The browser never touches the Email tables directly; every change goes through here and is
   (1) validated, (2) recorded as an Email Accounts row with a Pending Action, and
   (3) logged in Email Activity. Microsoft is changed later by the n8n email workflow, which
   works through rows whose Pending Action is set. Temporary passwords are never stored. */
const { BASE_ID, requireAdmin, airtable, json } = require('./lib/session');

const T = { accounts: 'tbljFURQrugQGgZOE', activity: 'tblcHVVOwvXRAH64L', board: 'tblJMfsctvEKNdEp8', staff: 'tblylF50qyHNtKHLH' };
const DOMAIN = 'flyace.org';
const ROLE_KEYS = { boardchair: 'Board Chair', boardvicechair: 'Board Vice Chair', boardtreasurer: 'Board Treasurer', boardsecretary: 'Board Secretary' };
/* Mailboxes that already exist in the Microsoft tenant but are not in the Email Accounts table. */
const EXISTING = ['acefoundation', 'acestaff', 'admin', 'geoffrey.mckenzie', 'pamela.harris', 'patrick.alexander', 'stephanie.smith'];
const RESERVED = ['postmaster', 'abuse', 'root', 'webmaster', 'hostmaster', 'noreply', 'no-reply', 'info', 'support', 'billing', 'security'];
const MAX_BATCH = 100;

const clean = (s) => String(s ?? '').trim();
const slug = (s) => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isEmail = (s) => /^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]{2,}$/.test(s) && s.length <= 254;
const isLocal = (s) => /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/.test(s);
function phone(s) {
  const d = clean(s).replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}
const name = (v) => v?.name ?? v ?? '';

async function listAll(table, query = '') {
  let out = [], offset = '';
  do {
    const d = await airtable('GET', `/${BASE_ID}/${table}?pageSize=100${query}${offset ? '&offset=' + offset : ''}`);
    if (!d) throw new Error('Could not read Airtable');
    out = out.concat(d.records || []);
    offset = d.offset || '';
  } while (offset);
  return out;
}
async function createRows(table, rows) {
  const made = [];
  for (let i = 0; i < rows.length; i += 10) {
    const d = await airtable('POST', `/${BASE_ID}/${table}`, { records: rows.slice(i, i + 10).map(fields => ({ fields })), typecast: false });
    if (!d) throw new Error('Could not write to Airtable');
    made.push(...d.records);
  }
  return made;
}
const patch = (id, fields) => airtable('PATCH', `/${BASE_ID}/${T.accounts}/${encodeURIComponent(id)}`, { fields });
const log = (action, summary, address, by, details, accountId) => createRows(T.activity, [{
  Summary: summary, Action: action, 'Email Address': address || '', 'Performed By': by,
  When: new Date().toISOString(), Details: details ? JSON.stringify(details) : '',
  ...(accountId ? { 'Email Account': [accountId] } : {})
}]);

function shapeAccount(r) {
  const f = r.fields;
  return {
    id: r.id, address: f['Email Address'] || '', displayName: f['Display Name'] || '', kind: name(f['Account Kind']),
    holderType: name(f['Holder Type']), holderName: f['Holder Name'] || '', roleKey: name(f['Role Key']),
    personalEmail: f['Personal Email'] || '', mobile: f.Mobile || '', status: name(f.Status),
    forwarding: !!f['Forwarding Enabled'], forwardTo: f['Forward To'] || '', autoReply: f['Auto-reply'] || '',
    pending: name(f['Pending Action']), lastError: f['Last Error'] || ''
  };
}

/* Normalises one requested person and flags problems. `taken` = set of local-parts already in use. */
function evaluate(p, taken) {
  const out = { first: clean(p.first), last: clean(p.last), personalEmail: clean(p.personalEmail).toLowerCase(), mobile: phone(p.mobile),
    holderType: p.holderType === 'Board Member' ? 'Board Member' : 'Staff', holderId: /^rec\w{14}$/.test(p.holderId || '') ? p.holderId : '',
    roleKey: '', kind: 'Personal', problems: [], notes: [] };
  const rk = slug(p.roleKey);
  if (rk) {
    if (!ROLE_KEYS[rk]) out.problems.push('Unknown role address');
    else if (out.holderType !== 'Board Member') out.problems.push('Role addresses are for board members');
    else { out.roleKey = rk; out.kind = 'Role'; }
  }
  if (!out.first || !out.last) out.problems.push('First and last name are required');
  if (!isEmail(out.personalEmail)) out.problems.push('Personal email is missing or invalid (the welcome email goes there)');
  if (!out.mobile) out.problems.push('Mobile number is missing or invalid (the temporary password is texted)');
  if (/@(flyace\.org|.*\.onmicrosoft\.com)$/i.test(out.personalEmail)) out.problems.push('Personal email must not be an ACE address');

  let local = out.kind === 'Role' ? out.roleKey : clean(p.address).toLowerCase().replace(/@flyace\.org$/, '') || (slug(out.first) + '.' + slug(out.last));
  if (!isLocal(local)) out.problems.push('Address is not valid');
  else if (RESERVED.includes(local)) out.problems.push(`"${local}" is reserved`);
  else if (taken.has(local)) {
    if (out.kind === 'Role') out.problems.push(`${local}@${DOMAIN} already exists`);
    else { let n = 2; while (taken.has(local + n)) n++; out.notes.push(`${local}@ is taken, suggested ${local}${n}@`); local += n; }
  }
  out.address = local + '@' + DOMAIN;
  out.displayName = out.kind === 'Role' ? `${out.first} ${out.last} – ${ROLE_KEYS[out.roleKey] || ''}`.trim() : `${out.first} ${out.last}`;
  if (!out.problems.length) taken.add(local);
  return out;
}

async function takenLocals() {
  const rows = await listAll(T.accounts);
  const set = new Set([...EXISTING, ...rows.map(r => (r.fields['Email Address'] || '').split('@')[0].toLowerCase()).filter(Boolean)]);
  return { set, rows };
}

const ACTIONS = {
  async overview() {
    const { rows } = await takenLocals();
    const accounts = rows.map(shapeAccount).sort((a, b) => a.address.localeCompare(b.address));
    const has = new Set(rows.map(r => r.fields['Holder Record ID']).filter(Boolean));
    const person = (r, type, nm, em, ph) => ({ holderId: r.id, holderType: type, first: clean(nm).split(/\s+/)[0] || '', last: clean(nm).split(/\s+/).slice(1).join(' '), personalEmail: em || '', mobile: ph || '' });
    const staff = (await listAll(T.staff)).filter(r => name(r.fields.Status) === 'Active' && !has.has(r.id))
      .map(r => person(r, 'Staff', r.fields['Full Name'], r.fields.Email, r.fields.Phone));
    const board = (await listAll(T.board)).filter(r => name(r.fields.Status) === 'Active' && !has.has(r.id))
      .map(r => ({ ...person(r, 'Board Member', r.fields['Full Name'], r.fields['Personal Email'], r.fields.Mobile), boardRole: name(r.fields['Board Role']) }));
    return { accounts, candidates: { staff, board }, licensesUsed: accounts.filter(a => a.status !== 'Disabled').length + EXISTING.length, licenseLimit: 300, roleKeys: ROLE_KEYS, existingMailboxes: EXISTING.map(x => x + '@flyace.org') };
  },

  async preview(body) {
    const people = Array.isArray(body.people) ? body.people.slice(0, MAX_BATCH) : [];
    if (!people.length) return { error: 'No people supplied' };
    const { set } = await takenLocals();
    return { rows: people.map(p => evaluate(p, set)) };
  },

  async create(body, admin) {
    const people = Array.isArray(body.people) ? body.people : [];
    if (!people.length || people.length > MAX_BATCH) return { error: `Send between 1 and ${MAX_BATCH} people` };
    const { set } = await takenLocals();
    const results = [], good = [];
    for (const p of people) {
      const e = evaluate(p, set);
      if (e.problems.length) { results.push({ address: e.address, ok: false, problems: e.problems }); continue; }
      /* An address the admin edited must still be free: evaluate() added it to `set`, so duplicates in-batch fail above. */
      good.push(e);
    }
    if (good.length) {
      const made = await createRows(T.accounts, good.map(e => ({
        'Email Address': e.address, 'Display Name': e.displayName, 'Account Kind': e.kind, 'Holder Type': e.holderType,
        'Holder Name': `${e.first} ${e.last}`, 'Holder Record ID': e.holderId, 'Personal Email': e.personalEmail, Mobile: e.mobile,
        Status: 'Waiting for move', 'Pending Action': 'Create', 'Requested By': admin.email, 'Created At': new Date().toISOString(),
        ...(e.roleKey ? { 'Role Key': e.roleKey } : {}),
        ...(e.holderType === 'Board Member' && e.holderId ? { 'Board Member': [e.holderId] } : {})
      })));
      await createRows(T.activity, good.map((e, i) => ({
        Summary: `Requested ${e.address} for ${e.first} ${e.last}`, Action: 'Create', 'Email Address': e.address,
        'Performed By': admin.email, When: new Date().toISOString(), 'Email Account': [made[i].id]
      })));
      good.forEach(e => results.push({ address: e.address, ok: true }));
    }
    return { results, created: good.length, skipped: people.length - good.length };
  },

  async forwarding(body, admin) {
    const acct = await loadAccount(body.id); if (acct.error) return acct;
    const enable = !!body.enabled, to = clean(body.forwardTo).toLowerCase();
    if (enable && !isEmail(to)) return { error: 'Enter a valid address to forward to' };
    if (enable && to === (acct.fields['Email Address'] || '').toLowerCase()) return { error: 'Cannot forward a mailbox to itself' };
    await patch(acct.id, { 'Forwarding Enabled': enable, 'Forward To': enable ? to : '', 'Pending Action': 'Forwarding', 'Action Details': JSON.stringify({ keepCopy: body.keepCopy !== false }) });
    await log(enable ? 'Forward on' : 'Forward off', `${enable ? 'Forward ' + acct.fields['Email Address'] + ' to ' + to : 'Stop forwarding ' + acct.fields['Email Address']}`, acct.fields['Email Address'], admin.email, null, acct.id);
    return { ok: true };
  },

  async offboard(body, admin) {
    const acct = await loadAccount(body.id); if (acct.error) return acct;
    if (name(acct.fields['Account Kind']) === 'Role') return { error: 'Role addresses are handed over, not offboarded' };
    const to = clean(body.forwardTo).toLowerCase();
    if (!isEmail(to) || !to.endsWith('@' + DOMAIN)) return { error: 'Choose a teammate with a flyace.org address' };
    if (to === (acct.fields['Email Address'] || '').toLowerCase()) return { error: 'Choose a different teammate' };
    const autoReply = clean(body.autoReply).slice(0, 2000);
    await patch(acct.id, { 'Forwarding Enabled': true, 'Forward To': to, 'Auto-reply': autoReply, 'Pending Action': 'Offboard',
      'Action Details': JSON.stringify({ blockSignIn: true, grantMailboxAccessTo: to, history: true }) });
    await log('Offboard', `Offboard ${acct.fields['Email Address']}; mail and history go to ${to}`, acct.fields['Email Address'], admin.email, { to, autoReply: !!autoReply }, acct.id);
    return { ok: true };
  },

  async handover(body, admin) {
    const acct = await loadAccount(body.id); if (acct.error) return acct;
    if (name(acct.fields['Account Kind']) !== 'Role') return { error: 'Only role addresses can be handed over' };
    const n = body.newHolder || {};
    const first = clean(n.first), last = clean(n.last), pe = clean(n.personalEmail).toLowerCase(), mob = phone(n.mobile);
    if (!first || !last) return { error: 'New holder needs a first and last name' };
    if (!isEmail(pe)) return { error: "New holder's personal email is invalid" };
    if (!mob) return { error: "New holder's mobile number is invalid" };
    const roleKey = name(acct.fields['Role Key']);
    const previous = { holder: acct.fields['Holder Name'] || '', personalEmail: acct.fields['Personal Email'] || '' };
    const holderId = /^rec\w{14}$/.test(n.holderId || '') ? n.holderId : '';
    await patch(acct.id, { 'Holder Name': `${first} ${last}`, 'Display Name': `${first} ${last} – ${ROLE_KEYS[roleKey] || ''}`, 'Personal Email': pe, Mobile: mob,
      'Holder Record ID': holderId, 'Board Member': holderId ? [holderId] : [], 'Pending Action': 'Hand over',
      'Action Details': JSON.stringify({ previous, lockOutPrevious: true, revokeSessions: true, removeMfa: true }) });
    await log('Hand over', `${acct.fields['Email Address']}: ${previous.holder || 'previous holder'} → ${first} ${last}`, acct.fields['Email Address'], admin.email, { previous }, acct.id);
    return { ok: true };
  },

  async simple(body, admin, action, pending, newStatus, summary) {
    const acct = await loadAccount(body.id); if (acct.error) return acct;
    await patch(acct.id, { 'Pending Action': pending });
    await log(action, `${summary} ${acct.fields['Email Address']}`, acct.fields['Email Address'], admin.email, null, acct.id);
    return { ok: true };
  }
};

async function loadAccount(id) {
  if (!/^rec\w{14}$/.test(id || '')) return { error: 'Unknown account' };
  const r = await airtable('GET', `/${BASE_ID}/${T.accounts}/${id}`);
  if (!r) return { error: 'Unknown account' };
  if (name(r.fields['Pending Action'])) return { error: 'This account already has a change waiting. Let it finish first.' };
  return r;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Please sign in again as an Administrator.' });
  let body; try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Bad request' }); }
  try {
    const a = body.action;
    let res;
    if (['overview', 'preview', 'create', 'forwarding', 'offboard', 'handover'].includes(a)) res = await ACTIONS[a](body, admin);
    else if (a === 'reset') res = await ACTIONS.simple(body, admin, 'Reset password', 'Reset password', null, 'Reset password for');
    else if (a === 'resend') res = await ACTIONS.simple(body, admin, 'Resend welcome', 'Resend welcome', null, 'Resend welcome for');
    else if (a === 'disable') res = await ACTIONS.simple(body, admin, 'Disable', 'Disable', null, 'Disable');
    else if (a === 'reenable') res = await ACTIONS.simple(body, admin, 'Re-enable', 'Re-enable', null, 'Re-enable');
    else return json(400, { error: 'Unknown action' });
    return json(res.error ? 400 : 200, res);
  } catch (e) {
    return json(502, { error: 'Something went wrong talking to Airtable. Nothing was changed if this was a create.' });
  }
};
