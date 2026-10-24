/* "Email this group" (Administrators only). Opens from the Admissions Pipeline card once a class is
   selected. Recipients are chosen by role (primary parent / secondary parent / student) and are
   recomputed on the server; attachments are virus-scanned on the server before they are stored.
   All dynamic text is written with textContent, never innerHTML. */
(function () {
  'use strict';
  var API = '/.netlify/functions/group-email';
  var ALLOWED = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'doc', 'docx', 'xls', 'xlsx', 'csv'];
  var MAX_FILES = 5, MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 10 * 1024 * 1024, CAP = 150;
  var SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 5-3.2 8.4-7 10-3.8-1.6-7-5-7-10V6z"/></svg>';

  var st = null; // per-open state

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }
    if (text != null) n.textContent = text;
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  async function call(payload) {
    if (typeof adminToken === 'undefined' || !adminToken) return { ok: false, status: 401, data: { error: 'Please sign out and sign in again as an Administrator.' } };
    try {
      var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken }, body: JSON.stringify(payload) });
      var data = await r.json().catch(function () { return {}; });
      return { ok: r.ok, status: r.status, data: data };
    } catch (e) { return { ok: false, status: 0, data: { error: 'Could not reach the server. Check your connection and try again.' } }; }
  }

  function roles() {
    var out = [];
    ['primary', 'secondary', 'student'].forEach(function (r) { var c = $('ge-role-' + r); if (c && c.checked) out.push(r); });
    return out;
  }

  /* ---------- modal ---------- */
  function build() {
    var m = $('ge-modal'); if (m) m.remove();
    m = el('div', { id: 'ge-modal', class: 'ge-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ge-title' });
    var card = el('div', { class: 'ge-card' });
    var head = el('div', { class: 'ge-head' });
    head.appendChild(el('h3', { id: 'ge-title' }, 'Email this group'));
    var x = el('button', { type: 'button', class: 'ge-x', id: 'ge-close', 'aria-label': 'Close' }, '×');
    head.appendChild(x); card.appendChild(head);
    card.appendChild(el('p', { class: 'ge-aud', id: 'ge-aud' }));

    card.appendChild(el('p', { class: 'ge-label' }, 'Send to'));
    var rolesBox = el('div', { class: 'ge-roles' });
    [['primary', 'Primary parent', true], ['secondary', 'Secondary parent', false], ['student', 'Student', false]].forEach(function (r) {
      var lab = el('label', { class: 'ge-check' });
      var c = el('input', { type: 'checkbox', id: 'ge-role-' + r[0] }); c.checked = r[2];
      lab.appendChild(c); lab.appendChild(el('span', null, r[1])); rolesBox.appendChild(lab);
      c.addEventListener('change', refreshRecipients);
    });
    card.appendChild(rolesBox);
    card.appendChild(el('p', { class: 'ge-count', id: 'ge-count', 'aria-live': 'polite' }, 'Counting recipients…'));
    var det = el('details', { class: 'ge-list', id: 'ge-list-wrap' });
    det.appendChild(el('summary', null, 'View the recipient list'));
    det.appendChild(el('ul', { id: 'ge-list' }));
    card.appendChild(det);

    card.appendChild(el('p', { class: 'ge-label' }, 'From / Reply-to'));
    card.appendChild(el('p', { class: 'ge-fixed' }, 'Aviation Career Enrichment <acestaff@flyace.org>'));

    var sl = el('label', { class: 'ge-label', for: 'ge-subject' }, 'Subject');
    card.appendChild(sl);
    card.appendChild(el('input', { type: 'text', id: 'ge-subject', class: 'ge-input', maxlength: '200', autocomplete: 'off' }));
    card.appendChild(el('label', { class: 'ge-label', for: 'ge-body' }, 'Message'));
    card.appendChild(el('textarea', { id: 'ge-body', class: 'ge-input', rows: '9', maxlength: '10000' }));

    card.appendChild(el('p', { class: 'ge-label' }, 'Attachments (optional)'));
    card.appendChild(el('p', { class: 'ge-hint' }, 'Up to 5 files, 4 MB each, 10 MB total. PDF, images, Word, Excel or CSV. Every file is scanned for viruses before it is attached.'));
    var pick = el('label', { class: 'ge-btn ge-btn-sub', for: 'ge-file' }, '＋ Add attachment');
    var fi = el('input', { type: 'file', id: 'ge-file', multiple: 'multiple', class: 'ge-file', accept: ALLOWED.map(function (e) { return '.' + e; }).join(',') });
    card.appendChild(pick); card.appendChild(fi);
    card.appendChild(el('ul', { class: 'ge-files', id: 'ge-files' }));

    card.appendChild(el('p', { class: 'ge-msg', id: 'ge-msg', role: 'status', 'aria-live': 'polite' }));
    var foot = el('div', { class: 'ge-foot' });
    foot.appendChild(el('button', { type: 'button', class: 'ge-btn ge-btn-sub', id: 'ge-test' }, 'Send a test to me'));
    foot.appendChild(el('button', { type: 'button', class: 'ge-btn ge-btn-main', id: 'ge-send' }, 'Send…'));
    card.appendChild(foot);
    var confirm = el('div', { class: 'ge-confirm hidden', id: 'ge-confirm' });
    confirm.appendChild(el('p', { id: 'ge-confirm-text' }));
    var cf = el('div', { class: 'ge-foot' });
    cf.appendChild(el('button', { type: 'button', class: 'ge-btn ge-btn-sub', id: 'ge-confirm-no' }, 'Go back'));
    cf.appendChild(el('button', { type: 'button', class: 'ge-btn ge-btn-danger', id: 'ge-confirm-yes' }, 'Yes, send now'));
    confirm.appendChild(cf); card.appendChild(confirm);

    m.appendChild(card); document.body.appendChild(m);
    x.addEventListener('click', close);
    m.addEventListener('mousedown', function (e) { if (e.target === m) close(); });
    document.addEventListener('keydown', onKey);
    fi.addEventListener('change', function () { var fs = Array.prototype.slice.call(fi.files); fi.value = ''; fs.forEach(addFile); });
    $('ge-test').addEventListener('click', sendTest);
    $('ge-send').addEventListener('click', askConfirm);
    $('ge-confirm-no').addEventListener('click', function () { $('ge-confirm').classList.add('hidden'); updateButtons(); });
    $('ge-confirm-yes').addEventListener('click', sendReal);
    ['ge-subject', 'ge-body'].forEach(function (id) { $(id).addEventListener('input', updateButtons); });
  }
  function onKey(e) { if (e.key === 'Escape' && !(st && st.busy)) close(); }
  function close() { var m = $('ge-modal'); if (m) m.remove(); document.removeEventListener('keydown', onKey); st = null; }

  function msg(text, kind) { var n = $('ge-msg'); if (!n) return; n.textContent = text || ''; n.className = 'ge-msg' + (kind ? ' ge-' + kind : ''); }

  function updateButtons() {
    if (!st || !$('ge-send')) return;
    var ok = $('ge-subject').value.trim() && $('ge-body').value.trim();
    var scanning = st.files.some(function (f) { return f.state === 'scanning'; });
    var n = st.count || 0;
    var sendable = ok && !scanning && !st.busy && n > 0 && n <= CAP;
    $('ge-send').disabled = !sendable;
    $('ge-send').textContent = n > 0 ? 'Send to ' + n + ' ' + (n === 1 ? 'person' : 'people') + '…' : 'Send…';
    $('ge-test').disabled = !(ok && !scanning && !st.busy);
  }

  /* ---------- recipients ---------- */
  async function refreshRecipients() {
    if (!st) return;
    var token = ++st.recipientsToken;
    var rs = roles();
    $('ge-count').textContent = rs.length ? 'Counting recipients…' : 'Choose at least one: primary parent, secondary parent or student.';
    $('ge-list').textContent = '';
    if (!rs.length) { st.count = 0; updateButtons(); return; }
    var r = await call({ action: 'recipients', recordIds: st.ids, roles: rs });
    if (!st || token !== st.recipientsToken) return;
    if (!r.ok) { st.count = 0; $('ge-count').textContent = r.data.error || 'Could not count recipients.'; updateButtons(); return; }
    var d = r.data; st.count = d.count;
    var parts = [d.count + (d.count === 1 ? ' person' : ' people') + ' will receive this email'];
    var by = []; if (d.byRole.primary) by.push(d.byRole.primary + ' primary parent' + (d.byRole.primary === 1 ? '' : 's')); if (d.byRole.secondary) by.push(d.byRole.secondary + ' secondary'); if (d.byRole.student) by.push(d.byRole.student + ' student' + (d.byRole.student === 1 ? '' : 's'));
    var txt = parts[0] + (by.length ? ' (' + by.join(', ') + ')' : '') + ' from ' + d.students + ' student record' + (d.students === 1 ? '' : 's') + '.';
    if (d.noEmail) txt += ' ' + d.noEmail + ' selected address' + (d.noEmail === 1 ? ' is' : 'es are') + ' blank and skipped.';
    if (d.invalid) txt += ' ' + d.invalid + ' invalid address' + (d.invalid === 1 ? '' : 'es') + ' skipped.';
    if (d.duplicatesSkipped) txt += ' ' + d.duplicatesSkipped + ' duplicate' + (d.duplicatesSkipped === 1 ? '' : 's') + ' removed so nobody gets it twice.';
    if (d.count > CAP) txt += ' A single send is limited to ' + CAP + ' people. Narrow the group.';
    $('ge-count').textContent = txt;
    var ul = $('ge-list'); (d.list || []).forEach(function (p) { ul.appendChild(el('li', null, p.name + ' — ' + p.email)); });
    updateButtons();
  }

  /* ---------- attachments ---------- */
  async function ensureDraft() {
    if (st.draftId) return true;
    var r = await call({ action: 'draft' });
    if (!r.ok) { msg(r.data.error || 'Could not start the email.', 'bad'); return false; }
    st.draftId = r.data.draftId; return true;
  }
  function renderFiles() {
    var ul = $('ge-files'); if (!ul) return; ul.textContent = '';
    st.files.forEach(function (f) {
      var li = el('li', { class: 'ge-file-row ge-' + f.state });
      var icon = el('span', { class: 'ge-ficon' });
      if (f.state === 'scanning') { icon.innerHTML = '<span class="ace-scan">' + SHIELD + '<i></i></span>'; }
      else if (f.state === 'clean') icon.textContent = '✓';
      else icon.textContent = '✕';
      li.appendChild(icon);
      var info = el('span', { class: 'ge-finfo' });
      info.appendChild(el('b', null, f.name));
      var sub = f.state === 'scanning' ? 'Scanning for viruses…' : f.state === 'clean' ? 'Scanned clean · ' + kb(f.size) : f.error;
      info.appendChild(el('span', null, sub));
      li.appendChild(info);
      if (f.state !== 'scanning') {
        var rm = el('button', { type: 'button', class: 'ge-rm', 'aria-label': 'Remove ' + f.name }, f.state === 'clean' ? 'Remove' : 'Dismiss');
        rm.addEventListener('click', function () { removeFile(f); });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
    updateButtons();
  }
  async function removeFile(f) {
    if (f.state === 'clean' && f.attId && st.draftId) {
      var r = await call({ action: 'remove', draftId: st.draftId, attachmentId: f.attId });
      if (!r.ok) { msg(r.data.error || 'Could not remove it.', 'bad'); return; }
    }
    st.files = st.files.filter(function (x) { return x !== f; }); renderFiles();
  }
  function readB64(file) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(file); });
  }
  async function addFile(file) {
    if (!st) return;
    var f = { name: file.name, size: file.size, state: 'scanning', error: '' };
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var total = st.files.filter(function (x) { return x.state === 'clean'; }).reduce(function (n, x) { return n + x.size; }, 0);
    var fail = null;
    if (ALLOWED.indexOf(ext) < 0) fail = 'That file type is not allowed. Allowed: PDF, PNG, JPG, GIF, Word, Excel, CSV.';
    else if (file.size > MAX_FILE) fail = 'Too large (' + kb(file.size) + '). Each file can be up to 4 MB.';
    else if (st.files.filter(function (x) { return x.state !== 'error'; }).length >= MAX_FILES) fail = 'You can attach up to ' + MAX_FILES + ' files.';
    else if (total + file.size > MAX_TOTAL) fail = 'Attachments can total up to 10 MB.';
    st.files.push(f);
    if (fail) { f.state = 'error'; f.error = fail; renderFiles(); return; }
    renderFiles();
    if (!(await ensureDraft())) { f.state = 'error'; f.error = 'Could not start the email.'; renderFiles(); return; }
    var b64; try { b64 = await readB64(file); } catch (e) { f.state = 'error'; f.error = 'Could not read that file.'; renderFiles(); return; }
    var r = await call({ action: 'attach', draftId: st.draftId, filename: file.name, contentType: file.type, base64: b64 });
    if (!st) return;
    if (r.ok) {
      f.state = 'clean';
      var list = r.data.attachments || [];
      var mine = list.filter(function (a) { return a.filename === file.name; });
      f.attId = mine.length ? mine[mine.length - 1].id : '';
    } else { f.state = 'error'; f.error = r.data.error || 'Could not attach that file.'; }
    renderFiles();
  }

  /* ---------- sending ---------- */
  function payload(mode) {
    var rs = roles();
    return { action: 'send', draftId: st.draftId, mode: mode, subject: $('ge-subject').value.trim(), body: $('ge-body').value, recordIds: st.ids, roles: rs, confirmCount: st.count,
      audience: st.label + ' · ' + rs.join('+') };
  }
  async function poll(expectTotal) {
    for (var i = 0; i < 120 && st; i++) {
      await new Promise(function (r) { setTimeout(r, 2000); });
      if (!st) return null;
      var r = await call({ action: 'status', draftId: st.draftId });
      if (!r.ok) continue;
      var s = r.data;
      if (s.status === 'Sending' || s.status === 'Queued') { msg('Sending… ' + s.sent + ' of ' + (s.total || expectTotal) + ' sent', ''); continue; }
      return s;
    }
    return null;
  }
  async function sendTest() {
    if (!st || st.busy) return;
    if (!(await ensureDraft())) return;
    st.busy = true; updateButtons(); msg('Sending a test to ' + (loggedInUser && loggedInUser.email || 'you') + '…', '');
    var r = await call(payload('test'));
    if (!r.ok) { st.busy = false; updateButtons(); msg(r.data.error || 'The test could not be sent.', 'bad'); return; }
    var s = await poll(1);
    if (!st) return; st.busy = false; updateButtons();
    if (s && s.status === 'Test sent') msg('Test sent to ' + (loggedInUser && loggedInUser.email || 'you') + '. Check your inbox, then send to the group.', 'ok');
    else msg(s ? 'The test failed: ' + (s.error || s.status) : 'The test is taking longer than expected. Check your inbox in a minute.', 'bad');
  }
  function askConfirm() {
    if (!st || st.busy) return;
    var n = st.count, rs = roles().join(', ').replace('primary', 'primary parents').replace('secondary', 'secondary parents').replace('student', 'students');
    $('ge-confirm-text').textContent = 'You are about to email ' + n + ' ' + (n === 1 ? 'person' : 'people') + ' (' + rs + ' — ' + st.label + '). This cannot be undone. Have you sent yourself a test and read it?';
    $('ge-confirm').classList.remove('hidden');
    $('ge-send').disabled = true; $('ge-test').disabled = true;
  }
  async function sendReal() {
    if (!st || st.busy) return;
    if (!(await ensureDraft())) return;
    var total = st.count;
    st.busy = true; $('ge-confirm').classList.add('hidden'); updateButtons(); msg('Starting the send…', '');
    var r = await call(payload('send'));
    if (!r.ok) { st.busy = false; updateButtons(); msg(r.data.error || 'Could not send. Nothing was sent.', 'bad'); return; }
    var s = await poll(total);
    if (!st) return; st.busy = false;
    if (s && (s.status === 'Sent' || s.status === 'Partly sent')) {
      msg(s.status === 'Sent' ? 'Sent to ' + s.sent + ' ' + (s.sent === 1 ? 'person' : 'people') + '.' : 'Sent to ' + s.sent + '; ' + s.failed + ' could not be sent. ' + (s.error || ''), s.status === 'Sent' ? 'ok' : 'bad');
      $('ge-send').disabled = true; $('ge-test').disabled = true; $('ge-send').textContent = 'Done'; // one send per draft: it cannot be sent twice
    } else {
      updateButtons();
      msg(s ? 'The send failed: ' + (s.error || s.status) : 'The send is taking longer than expected. It continues in the background; check the Group Emails table in Airtable for the result.', 'bad');
    }
  }

  /* ---------- open ---------- */
  window.openGroupEmail = function () {
    var sel = window.pipelineSelection;
    if (typeof adminAuthenticated === 'undefined' || !adminAuthenticated) return;
    if (!sel || !sel.classLabel || !sel.recordIds || !sel.recordIds.length) return;
    build();
    st = { ids: sel.recordIds.slice(0, 500), label: sel.classLabel + (sel.status ? ' · ' + sel.status : ''), draftId: null, files: [], count: 0, busy: false, recipientsToken: 0 };
    $('ge-aud').textContent = 'Group: ' + st.label + ' (' + st.ids.length + ' student' + (st.ids.length === 1 ? '' : 's') + ')';
    $('ge-subject').focus();
    updateButtons();
    refreshRecipients();
  };
  document.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('#email-group-btn'); if (b) window.openGroupEmail(); });
})();
