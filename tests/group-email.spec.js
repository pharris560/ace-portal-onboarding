// "Email this group": button, compose window, recipient roles, attachment scanning animation, test send, confirmed send.
const { test, expect } = require('@playwright/test');

const j = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });
const F = { first: 'flduMlCg6WQYp1603', last: 'fldaIIUPWQqHMxUbG', id: 'fld83rlR3Ofe9zYFi', status: 'fldN7rJY04UdUoqrn', stage: 'fldoGmKcbKN5q8T0R', cls: 'fld4UyibXcJF6Jma0', ses: 'fldQDbLbNGhcTpf8s', pFirst: 'fldqJs1uDhrOJchi7', pLast: 'fldeQZnY89hXgeK76', pEmail: 'fldHE8GLMmh1GZqz6' };
const student = (n, first, last, status) => ({ id: 'recS' + n, createdTime: '2026-09-01T00:00:00.000Z', fields: { [F.first]: first, [F.last]: last, [F.id]: 'ACE-' + n, [F.status]: status, [F.stage]: 'Complete ', [F.cls]: ['Falcons'], [F.ses]: ['AM Session 9am-11:30am'], [F.pFirst]: 'P' + n, [F.pLast]: last, [F.pEmail]: 'p' + n + '@example.com' } });
const STUDENTS = [student(1, 'Ada', 'Lovelace', 'Active'), student(2, 'Alan', 'Turing', 'Active'), student(3, 'Gone', 'Away', 'Withdrawn')];

async function setup(page, { scanDelay = 0, attachResult } = {}) {
  const calls = [];
  await page.route('**/.netlify/functions/airtable**', (r) => { const u = decodeURIComponent(r.request().url()); return r.fulfill(j({ records: u.includes('tbluHnJc9VM6l4U6V') ? STUDENTS : [] })); });
  await page.route('**/.netlify/functions/portal-login', (r) => r.fulfill(j({ token: 'tok', rec: 'recADMIN', role: 'admin', type: 'Administrator', expiresInMinutes: 30, name: 'Pam Admin', email: 'pam@example.com' })));
  await page.route('**/.netlify/functions/base-info', (r) => r.fulfill(j({ name: 'x', source: 'airtable' })));
  await page.route('**/.netlify/functions/email-admin', (r) => r.fulfill(j({ accounts: [], candidates: { staff: [], board: [] }, roleKeys: {}, licensesUsed: 0, licenseLimit: 300 })));
  await page.route('**/.netlify/functions/group-email', async (r) => {
    const b = r.request().postDataJSON(); calls.push({ ...b, auth: r.request().headers()['authorization'] });
    if (b.action === 'draft') return r.fulfill(j({ draftId: 'recDRAFT00000001' }));
    if (b.action === 'recipients') {
      const n = b.roles.length ? 2 * b.roles.length : 0;
      return r.fulfill(j({ count: n, byRole: { primary: b.roles.includes('primary') ? 2 : 0, secondary: b.roles.includes('secondary') ? 2 : 0, student: b.roles.includes('student') ? 2 : 0 }, students: b.recordIds.length, noEmail: 0, invalid: 0, duplicatesSkipped: 0, cap: 150, list: [{ name: '<b>Evil</b> parent', email: 'x@example.com' }] }));
    }
    if (b.action === 'attach') {
      if (scanDelay) await new Promise((res) => setTimeout(res, scanDelay));
      if (attachResult) return r.fulfill(attachResult);
      return r.fulfill(j({ scan: 'clean', filename: b.filename, attachments: [{ id: 'att1', filename: b.filename, size: 1234 }] }));
    }
    if (b.action === 'remove') return r.fulfill(j({ attachments: [] }));
    if (b.action === 'send') return r.fulfill(j({ ok: true, queued: b.mode === 'test' ? 1 : 4, mode: b.mode }));
    if (b.action === 'status') return r.fulfill(j({ status: calls.some((c) => c.action === 'send' && c.mode === 'send') ? 'Sent' : 'Test sent', sent: 4, failed: 0, total: 4, error: '', attachments: [] }));
    return r.fulfill(j({}));
  });
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  await page.goto('/index.html');
  await page.evaluate(() => showView('login'));
  await page.fill('#login-email', 'pam@example.com');
  await page.fill('#login-password', 'secret-pw-1');
  await page.click('#login-submit-btn');
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#student-count')).toContainText('match the filters');
  return calls;
}
const open = async (page) => { await page.selectOption('#class-filter', 'AM Falcons'); await page.click('#email-group-btn'); await expect(page.locator('#ge-modal')).toBeVisible(); };

test('the Email this group button only appears once a class is selected', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#email-group-btn')).toBeHidden();
  await page.selectOption('#class-filter', 'AM Falcons');
  await expect(page.locator('#email-group-btn')).toBeVisible();
  await page.selectOption('#class-filter', '');
  await expect(page.locator('#email-group-btn')).toBeHidden();
});

test('compose window: sender is fixed, primary parent is pre-ticked, counts come from the server, names are plain text', async ({ page }) => {
  const calls = await setup(page);
  await open(page);
  await expect(page.locator('#ge-modal')).toContainText('acestaff@flyace.org');
  await expect(page.locator('#ge-role-primary')).toBeChecked();
  await expect(page.locator('#ge-role-secondary')).not.toBeChecked();
  await expect(page.locator('#ge-role-student')).not.toBeChecked();
  await expect(page.locator('#ge-count')).toContainText('2 people will receive this email');
  const rec = calls.filter((c) => c.action === 'recipients').at(-1);
  expect(rec.roles).toEqual(['primary']);
  expect(rec.recordIds.sort()).toEqual(['recS1', 'recS2']); // Active Falcons only (Withdrawn excluded)
  expect(rec.auth).toBe('Bearer tok');
  await page.locator('#ge-role-secondary').check();
  await page.locator('#ge-role-student').check();
  await expect(page.locator('#ge-count')).toContainText('6 people');
  await page.locator('#ge-list-wrap summary').click();
  await expect(page.locator('#ge-list li').first()).toHaveText('<b>Evil</b> parent — x@example.com');
  expect(await page.locator('#ge-list b').count()).toBe(0);
  for (const r of ['primary', 'secondary', 'student']) await page.locator('#ge-role-' + r).uncheck();
  await expect(page.locator('#ge-count')).toContainText('Choose at least one');
  await expect(page.locator('#ge-send')).toBeDisabled();
});

test('attachment: shows the scanning animation, then Scanned clean; infected and unscannable files are rejected with the server message', async ({ page }) => {
  await setup(page, { scanDelay: 600 });
  await open(page);
  await page.setInputFiles('#ge-file', { name: 'flyer.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2000, 'a') });
  const row = page.locator('.ge-file-row').first();
  await expect(row).toContainText('Scanning for viruses…');
  await expect(row.locator('.ace-scan i')).toBeVisible(); // the sweeping scan line
  await expect(page.locator('#ge-send')).toBeDisabled();   // cannot send while a file is still being scanned
  await expect(row).toContainText('Scanned clean');
  await expect(row.locator('.ace-scan')).toHaveCount(0);
  await row.getByRole('button', { name: /Remove/ }).click();
  await expect(page.locator('.ge-file-row')).toHaveCount(0);
});
test('attachment: an infected file shows the block message and is not kept', async ({ page }) => {
  await setup(page, { attachResult: j({ error: 'Blocked: the virus scan found a problem in "x.pdf" (Eicar-Test). It was not attached.', scan: 'infected' }, 422) });
  await open(page);
  await page.setInputFiles('#ge-file', { name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(500, 'a') });
  await expect(page.locator('.ge-file-row.ge-error')).toContainText('Blocked: the virus scan found a problem');
});
test('attachment: wrong type and too-big files are refused in the browser, without calling the server', async ({ page }) => {
  const calls = await setup(page);
  await open(page);
  await page.setInputFiles('#ge-file', { name: 'run.exe', mimeType: 'application/x-msdownload', buffer: Buffer.alloc(100, 'a') });
  await expect(page.locator('.ge-file-row.ge-error').first()).toContainText('not allowed');
  await page.setInputFiles('#ge-file', { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(4 * 1024 * 1024 + 10, 'a') });
  await expect(page.locator('.ge-file-row.ge-error').nth(1)).toContainText('Too large');
  expect(calls.filter((c) => c.action === 'attach')).toHaveLength(0);
});

test('sending needs a subject and message; a test goes first and reports back; the real send asks for confirmation with the exact count', async ({ page }) => {
  const calls = await setup(page);
  await open(page);
  await expect(page.locator('#ge-send')).toBeDisabled();
  await expect(page.locator('#ge-test')).toBeDisabled();
  await page.fill('#ge-subject', 'Picture day');
  await page.fill('#ge-body', 'Hello families,\n\nSee you Saturday.');
  await expect(page.locator('#ge-send')).toBeEnabled();
  await expect(page.locator('#ge-send')).toContainText('Send to 2 people');

  await page.click('#ge-test');
  await expect(page.locator('#ge-msg')).toContainText('Test sent to pam@example.com', { timeout: 15000 });
  const t = calls.filter((c) => c.action === 'send').at(-1);
  expect(t.mode).toBe('test'); expect(t.subject).toBe('Picture day');

  await page.click('#ge-send');
  await expect(page.locator('#ge-confirm')).toBeVisible();
  await expect(page.locator('#ge-confirm-text')).toContainText('about to email 2 people');
  expect(calls.filter((c) => c.action === 'send' && c.mode === 'send')).toHaveLength(0); // nothing sent yet
  await page.click('#ge-confirm-no');
  await expect(page.locator('#ge-confirm')).toBeHidden();
  expect(calls.filter((c) => c.action === 'send' && c.mode === 'send')).toHaveLength(0);

  await page.click('#ge-send');
  await page.click('#ge-confirm-yes');
  await expect(page.locator('#ge-msg')).toContainText('Sent to 4 people', { timeout: 15000 });
  const real = calls.filter((c) => c.action === 'send' && c.mode === 'send');
  expect(real).toHaveLength(1);
  expect(real[0].confirmCount).toBe(2); expect(real[0].roles).toEqual(['primary']); expect(real[0].draftId).toBe('recDRAFT00000001');
  await expect(page.locator('#ge-send')).toBeDisabled(); // cannot be sent twice from this window
  await expect(page.locator('#ge-send')).toHaveText('Done');
});

test('the compose window closes with Escape and the close button, and is not offered to non-admins', async ({ page }) => {
  await setup(page);
  await open(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ge-modal')).toHaveCount(0);
  await open(page);
  await page.click('#ge-close');
  await expect(page.locator('#ge-modal')).toHaveCount(0);
  await page.evaluate(() => { adminAuthenticated = false; window.openGroupEmail(); });
  await expect(page.locator('#ge-modal')).toHaveCount(0);
});
