/* Email Accounts card (Administrator dashboard). Talks only to /.netlify/functions/email-admin
   with the signed session token from admin-login (adminToken in index.html). All text is
   written with textContent, never innerHTML, so names from Airtable can't inject markup. */
(function () {
  const API = '/.netlify/functions/email-admin';
  const ROLE_BY_BOARD = { 'Chair': 'boardchair', 'Vice Chair': 'boardvicechair', 'Treasurer': 'boardtreasurer', 'Secretary': 'boardsecretary' };
  let state = { accounts: [], candidates: { staff: [], board: [] }, roleKeys: {}, licensesUsed: 0, licenseLimit: 300 };
  let draft = [];      /* people waiting to be previewed/created */
  let previewRows = null;
  let tab = 'accounts';
  let openPanel = null; /* {id, kind} */

  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'class') e.className = attrs[k];
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    kids.flat(Infinity).forEach(c => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return e;
  }
  const btn = (label, fn, cls) => h('button', { class: 'neu-btn px-3 py-1.5 rounded-lg text-[11px] ' + (cls || 'neon-text-subtle'), onclick: fn, type: 'button' }, label);
  const input = (ph, val, cls) => { const i = h('input', { class: 'neu-input px-3 py-2 rounded-lg text-xs ' + (cls || ''), placeholder: ph, type: 'text' }); i.value = val || ''; return i; };
  const toast = (m, t) => (typeof showToast === 'function' ? showToast(m, t || 'success') : console.log(m));

  async function call(body) {
    if (typeof adminToken === 'undefined' || !adminToken) return { error: 'Please sign out and sign in again as an Administrator.' };
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || 'Request failed' };
    } catch (_) { return { error: 'Could not reach the server.' }; }
  }

  async function load() {
    const root = $('email-accounts-card'); if (!root) return;
    const res = await call({ action: 'overview' });
    if (res.error) { root.replaceChildren(h('p', { class: 'text-sm text-red-400 text-center py-6' }, res.error)); return; }
    state = res; render();
  }

  /* ---------- rendering ---------- */
  function render() {
    const root = $('email-accounts-card'); if (!root) return;
    const tabs = [['accounts', 'Accounts'], ['add', 'Add people'], ['upload', 'Upload spreadsheet']].map(([k, l]) =>
      h('button', { type: 'button', onclick: () => { tab = k; previewRows = null; render(); }, class: 'px-3 py-1.5 rounded-lg text-xs ' + (tab === k ? 'neu-btn neon-text' : 'text-gray-400') }, l));
    root.replaceChildren(
      h('div', { class: 'flex items-center justify-between mb-2 flex-wrap gap-2' },
        h('h3', { class: 'font-display text-base font-bold neon-text' }, 'Email Accounts (@flyace.org)'),
        h('div', { class: 'flex items-center gap-3' },
          h('span', { class: 'text-[11px] text-gray-400' }, `${state.licensesUsed} of ${state.licenseLimit} free licenses in use`),
          h('a', { class: 'text-[11px] underline neon-text-subtle', href: 'email-setup.html', target: '_blank', rel: 'noopener' }, 'Setup guide for new users'),
          btn('↻ Refresh', load))),
      h('p', { class: 'text-xs text-gray-500 mb-4' }, 'Requests are saved here and carried out in Microsoft by the email workflow. "Waiting" means it has not been processed yet. Temporary passwords are texted to the person; they are never shown or stored here.'),
      h('div', { class: 'flex gap-2 mb-4' }, tabs),
      tab === 'accounts' ? renderAccounts() : tab === 'add' ? renderAdd() : renderUpload());
  }

  const badge = (a) => {
    const txt = a.pending ? (a.status === 'Waiting for move' ? 'Waiting: ' : 'Queued: ') + a.pending : a.status || '—';
    const col = a.status === 'Error' ? '#ef4444' : a.pending ? '#eab308' : a.status === 'Active' ? '#22c55e' : '#9ca3af';
    return h('span', { class: 'text-[10px] px-2 py-0.5 rounded-full', style: `border:1px solid ${col};color:${col}` }, txt);
  };

  function renderAccounts() {
    if (!state.accounts.length) return h('p', { class: 'text-sm text-gray-500 text-center py-8' }, 'No accounts requested yet. Use "Add people" or "Upload spreadsheet".');
    const rows = state.accounts.map(a => [
      h('tr', { class: 'border-b border-gray-800' },
        h('td', { class: 'py-2 px-2' }, h('div', { class: 'text-white text-xs' }, a.address), h('div', { class: 'text-[10px] text-gray-500' }, a.displayName)),
        h('td', { class: 'py-2 px-2 text-xs text-gray-400' }, a.kind === 'Role' ? 'Role' : a.holderType || 'Personal'),
        h('td', { class: 'py-2 px-2' }, badge(a), a.lastError ? h('div', { class: 'text-[10px] text-red-400 mt-1' }, a.lastError) : null),
        h('td', { class: 'py-2 px-2 text-[11px] text-gray-400' }, a.forwarding ? 'Forwards to ' + a.forwardTo : '—'),
        h('td', { class: 'py-2 px-2' }, h('div', { class: 'flex flex-wrap gap-1.5' },
          btn('Forwarding', () => toggle(a.id, 'fwd')),
          a.kind === 'Role' ? btn('Hand over', () => toggle(a.id, 'hand')) : btn('Offboard', () => toggle(a.id, 'off')),
          btn('Reset password', () => simple(a, 'reset', 'Send a new temporary password by text to ' + a.address + '?')),
          btn('Resend welcome', () => simple(a, 'resend')),
          a.status === 'Disabled' ? btn('Re-enable', () => simple(a, 'reenable')) : btn('Disable', () => simple(a, 'disable', 'Block sign-in for ' + a.address + '? Mail is kept.'))))),
      openPanel && openPanel.id === a.id ? h('tr', {}, h('td', { colspan: 5, class: 'p-3' }, panel(a))) : null]);
    return h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-sm' },
      h('thead', {}, h('tr', { class: 'text-[10px] text-gray-500 uppercase tracking-widest border-b border-gray-800' },
        ['Address', 'Type', 'Status', 'Forwarding', 'Actions'].map(t => h('th', { class: 'text-left py-2 px-2 font-medium' }, t)))),
      h('tbody', {}, rows)));
  }
  function toggle(id, kind) { openPanel = openPanel && openPanel.id === id && openPanel.kind === kind ? null : { id, kind }; render(); }

  async function simple(a, action, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    const r = await call({ action, id: a.id });
    r.error ? toast(r.error, 'error') : (toast('Queued', 'success'), load());
  }

  function panel(a) {
    const wrap = h('div', { class: 'neu-raised rounded-xl p-4 space-y-3' });
    const done = async (body) => { const r = await call(body); if (r.error) toast(r.error, 'error'); else { toast('Saved', 'success'); openPanel = null; load(); } };
    if (openPanel.kind === 'fwd') {
      const on = h('input', { type: 'checkbox' }); on.checked = a.forwarding;
      const to = input('Forward to (any email address)', a.forwardTo, 'w-full');
      const keep = h('input', { type: 'checkbox' }); keep.checked = true;
      wrap.append(h('label', { class: 'flex items-center gap-2 text-xs text-gray-300' }, on, 'Forward new mail'), to,
        h('label', { class: 'flex items-center gap-2 text-xs text-gray-300' }, keep, 'Also keep a copy in this mailbox'),
        btn('Save forwarding', () => done({ action: 'forwarding', id: a.id, enabled: on.checked, forwardTo: to.value, keepCopy: keep.checked })));
    } else if (openPanel.kind === 'off') {
      const sel = h('select', { class: 'neu-input px-3 py-2 rounded-lg text-xs w-full' }, h('option', { value: '' }, 'Choose a teammate to receive this mail…'),
        state.accounts.filter(x => x.id !== a.id && x.address && x.status !== 'Disabled').map(x => h('option', { value: x.address }, `${x.displayName || x.address} (${x.address})`)));
      const reply = h('textarea', { class: 'neu-input px-3 py-2 rounded-lg text-xs w-full', rows: 3, placeholder: 'Optional auto-reply, e.g. "Jane has left ACE. Please contact Tom at tom@flyace.org."' });
      wrap.append(h('p', { class: 'text-xs text-gray-400' }, `Blocks sign-in for ${a.address}, forwards new mail to the teammate, and gives them access to the old mailbox and its history.`), sel, reply,
        btn('Offboard', () => sel.value ? done({ action: 'offboard', id: a.id, forwardTo: sel.value, autoReply: reply.value }) : toast('Choose a teammate first', 'error')));
    } else if (openPanel.kind === 'hand') {
      const f = input('First name'), l = input('Last name'), e = input('Personal email'), m = input('Mobile (for the temporary password)');
      const pick = h('select', { class: 'neu-input px-3 py-2 rounded-lg text-xs w-full' }, h('option', { value: '' }, 'Or pick a board member from Airtable…'),
        state.candidates.board.map((p, i) => h('option', { value: i }, `${p.first} ${p.last}`)));
      let holderId = '';
      pick.addEventListener('change', () => { const p = state.candidates.board[pick.value]; if (!p) return; f.value = p.first; l.value = p.last; e.value = p.personalEmail; m.value = p.mobile; holderId = p.holderId; });
      wrap.append(h('p', { class: 'text-xs text-gray-400' }, `Hands ${a.address} (currently ${a.holderName || 'unassigned'}) to a new person. The previous holder is signed out everywhere and locked out; the new holder gets a temporary password by text.`),
        pick, h('div', { class: 'grid grid-cols-2 gap-2' }, f, l, e, m),
        btn('Hand over', () => window.confirm('Lock out the current holder of ' + a.address + '?') && done({ action: 'handover', id: a.id, newHolder: { first: f.value, last: l.value, personalEmail: e.value, mobile: m.value, holderId } })));
    }
    return wrap;
  }

  /* ---------- adding people ---------- */
  function renderAdd() {
    const box = h('div', { class: 'space-y-5' });
    const mk = (p, group) => {
      const roleSel = group === 'board' ? h('select', { class: 'neu-input px-2 py-1 rounded-lg text-[11px]' },
        h('option', { value: '' }, 'Personal address'), Object.entries(state.roleKeys).map(([k, v]) => h('option', { value: k, selected: ROLE_BY_BOARD[p.boardRole] === k }, k + '@ (' + v + ')'))) : null;
      const cb = h('input', { type: 'checkbox' });
      return { cb, p, roleSel, el: h('label', { class: 'flex items-center gap-3 text-xs text-gray-300 py-1' }, cb, `${p.first} ${p.last}`, h('span', { class: 'text-gray-500' }, p.boardRole || ''), roleSel) };
    };
    const staff = state.candidates.staff.map(p => mk(p, 'staff')), board = state.candidates.board.map(p => mk(p, 'board'));
    const section = (title, list, empty) => h('div', {}, h('p', { class: 'text-[10px] text-gray-500 uppercase tracking-widest mb-2' }, title),
      list.length ? list.map(x => x.el) : h('p', { class: 'text-xs text-gray-500' }, empty));
    box.append(section('Active Staff without an ACE address', staff, 'Everyone active in Staff already has an address (or the Staff table is empty — use Upload spreadsheet).'),
      section('Active Board Members without an ACE address', board, 'No board members waiting. Add them to the Board Members table in Airtable first.'));
    const f = input('First name'), l = input('Last name'), e = input('Personal email'), m = input('Mobile');
    const type = h('select', { class: 'neu-input px-3 py-2 rounded-lg text-xs' }, h('option', { value: 'Staff' }, 'Staff'), h('option', { value: 'Board Member' }, 'Board Member'));
    box.append(h('div', {}, h('p', { class: 'text-[10px] text-gray-500 uppercase tracking-widest mb-2' }, 'Or add one person by hand'), h('div', { class: 'grid grid-cols-2 md:grid-cols-5 gap-2' }, f, l, e, m, type)));
    box.append(btn('Review addresses →', () => {
      draft = [];
      [...staff, ...board].filter(x => x.cb.checked).forEach(x => draft.push({ ...x.p, roleKey: x.roleSel ? x.roleSel.value : '' }));
      if (f.value || l.value || e.value || m.value) draft.push({ first: f.value, last: l.value, personalEmail: e.value, mobile: m.value, holderType: type.value });
      draft.length ? runPreview() : toast('Tick at least one person or fill in the form', 'error');
    }, 'neon-text'));
    if (previewRows) box.append(renderPreview());
    return box;
  }

  const TEMPLATE = 'first,last,personalEmail,mobile,type,role\nJane,Doe,jane@gmail.com,404-555-0123,staff,\nSam,Lee,sam@yahoo.com,404-555-0199,board,boardtreasurer\n';
  function renderUpload() {
    const ta = h('textarea', { class: 'neu-input px-3 py-2 rounded-lg text-xs w-full font-mono', rows: 6, placeholder: 'Paste rows here, or choose a .csv file below' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'neu-input text-xs' });
    file.addEventListener('change', () => { const r = new FileReader(); r.onload = () => { ta.value = String(r.result); }; file.files[0] && r.readAsText(file.files[0]); });
    const tpl = h('a', { class: 'text-xs underline neon-text-subtle', href: 'data:text/csv;charset=utf-8,' + encodeURIComponent(TEMPLATE), download: 'ace-email-accounts-template.csv' }, 'Download the template');
    const box = h('div', { class: 'space-y-3' },
      h('p', { class: 'text-xs text-gray-400' }, 'Columns: first, last, personalEmail, mobile, type (staff or board), role (optional: boardchair, boardvicechair, boardtreasurer, boardsecretary). Up to 100 rows.'),
      tpl, file, ta,
      btn('Review addresses →', () => {
        draft = parseCsv(ta.value);
        draft.length ? runPreview() : toast('No rows found', 'error');
      }, 'neon-text'));
    if (previewRows) box.append(renderPreview());
    return box;
  }
  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some(x => x.trim())) rows.push(row);
    if (rows[0] && /^first/i.test(rows[0][0].trim())) rows.shift();
    return rows.slice(0, 100).map(r => ({ first: r[0] || '', last: r[1] || '', personalEmail: r[2] || '', mobile: r[3] || '',
      holderType: /^b/i.test((r[4] || '').trim()) ? 'Board Member' : 'Staff', roleKey: (r[5] || '').trim().toLowerCase() }));
  }

  async function runPreview() {
    const r = await call({ action: 'preview', people: draft });
    if (r.error) { toast(r.error, 'error'); return; }
    previewRows = r.rows; render();
  }
  function renderPreview() {
    const addrInputs = [];
    const body = previewRows.map((r, i) => {
      const a = input('address', r.address.replace(/@flyace\.org$/, ''), 'w-40'); a.disabled = r.kind === 'Role'; addrInputs.push(a);
      return h('tr', { class: 'border-b border-gray-800 align-top' },
        h('td', { class: 'py-2 px-2 text-xs text-white' }, `${r.first} ${r.last}`, h('div', { class: 'text-[10px] text-gray-500' }, r.kind === 'Role' ? 'Role address' : r.holderType)),
        h('td', { class: 'py-2 px-2' }, h('div', { class: 'flex items-center gap-1 text-xs text-gray-300' }, a, '@flyace.org')),
        h('td', { class: 'py-2 px-2 text-[11px]' }, r.problems.map(p => h('div', { class: 'text-red-400' }, '✗ ' + p)), r.notes.map(p => h('div', { class: 'text-yellow-400' }, p)), !r.problems.length && !r.notes.length ? h('span', { class: 'text-green-500' }, '✓ Ready') : null));
    });
    const okCount = previewRows.filter(r => !r.problems.length).length;
    return h('div', { class: 'neu-raised rounded-xl p-4 mt-2' },
      h('p', { class: 'text-xs text-gray-400 mb-2' }, `${okCount} of ${previewRows.length} ready. Rows with a ✗ will be skipped. You can edit an address before creating.`),
      h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full' }, h('tbody', {}, body))),
      h('div', { class: 'flex gap-2 mt-3' },
        btn(`Create ${okCount} account${okCount === 1 ? '' : 's'}`, async () => {
          const people = draft.map((p, i) => ({ ...p, address: previewRows[i].kind === 'Role' ? '' : addrInputs[i].value }));
          const r = await call({ action: 'create', people });
          if (r.error) { toast(r.error, 'error'); return; }
          toast(`${r.created} requested${r.skipped ? ', ' + r.skipped + ' skipped' : ''}`, r.skipped ? 'error' : 'success');
          previewRows = null; draft = []; tab = 'accounts'; load();
        }, okCount ? 'neon-text' : 'text-gray-500'),
        btn('Cancel', () => { previewRows = null; render(); })));
  }

  window.loadEmailAccounts = load;
})();
