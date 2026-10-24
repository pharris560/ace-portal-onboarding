// Email Accounts card (Administrator dashboard): server-verified admin sign-in, list, add people, preview, create.
const { test, expect } = require('@playwright/test');

const ADMIN = { id: 'recADMIN00000001', fields: { Email: 'pam@example.com', 'Full Name': 'Pam Admin', 'Account Type': { name: 'Administrator' } } }; // no hash: proxy scrubs it

async function stub(page, { loginOk = true, baseSource = 'airtable' } = {}) {
  const j = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });
  const calls = [];
  const accounts = [
    { id: 'recACCT0000000001', address: 'boardchair@flyace.org', displayName: 'Dana Cole – Board Chair', kind: 'Role', holderType: 'Board Member', holderName: 'Dana Cole', roleKey: 'boardchair', status: 'Waiting for move', pending: 'Create', forwarding: false, forwardTo: '', autoReply: '', lastError: '' },
    { id: 'recACCT0000000002', address: '<img src=x onerror=window.__xss=1>@flyace.org', displayName: '<b>Bad</b> Name', kind: 'Personal', holderType: 'Staff', holderName: 'Bad', roleKey: '', status: 'Active', pending: '', forwarding: true, forwardTo: 'x@y.com', autoReply: '', lastError: '' }
  ];
  await page.route('**/.netlify/functions/airtable\\?**', (route) => route.fulfill(j({ records: [ADMIN] })));
  await page.route('**/.netlify/functions/portal-login', async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ fn: 'portal-login', body });
    return route.fulfill(loginOk ? j({ token: 'tok123', rec: 'recADMIN', role: 'admin', type: 'Administrator', expiresInMinutes: 30, name: 'Pam Admin', email: 'pam@example.com' }) : j({ error: 'Incorrect password. Please try again.' }, 401));
  });
  await page.route('**/.netlify/functions/base-info', (route) => route.fulfill(j({ name: '2026 - 2027 ACE Student Enrollment', baseId: 'appFVg5UNlwzJMuaY', source: baseSource })));
  await page.route('**/.netlify/functions/email-admin', async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ fn: 'email-admin', auth: route.request().headers()['authorization'], body });
    if (body.action === 'overview') return route.fulfill(j({ accounts, candidates: { staff: [], board: [{ holderId: 'recBOARD00000001', holderType: 'Board Member', first: 'Nia', last: 'Hart', personalEmail: 'nia@gmail.com', mobile: '+14045550199', boardRole: 'Secretary' }] }, roleKeys: { boardchair: 'Board Chair', boardvicechair: 'Board Vice Chair', boardtreasurer: 'Board Treasurer', boardsecretary: 'Board Secretary' }, licensesUsed: 9, licenseLimit: 300, existingMailboxes: ['acestaff@flyace.org', 'admin@flyace.org'] }));
    if (body.action === 'preview') return route.fulfill(j({ rows: body.people.map(p => ({ ...p, address: (p.roleKey || 'nia.hart') + '@flyace.org', kind: p.roleKey ? 'Role' : 'Personal', problems: [], notes: [] })) }));
    if (body.action === 'create') return route.fulfill(j({ results: [{ ok: true }], created: 1, skipped: 0 }));
    return route.fulfill(j({ ok: true }));
  });
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  return calls;
}
async function signIn(page, pw = 'secret-pw-1') {
  await page.goto('/index.html');
  await page.evaluate(() => showView('login'));
  await page.fill('#login-email', 'pam@example.com');
  await page.fill('#login-password', pw);
  await page.click('#login-submit-btn');
}

test('admin sign-in is verified by the server and unlocks the email card', async ({ page }) => {
  const calls = await stub(page);
  await signIn(page);
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#email-accounts-card')).toContainText('9 of 300 free licenses in use');
  expect(calls.find(c => c.fn === 'portal-login').body).toEqual({ email: 'pam@example.com', password: 'secret-pw-1' });
  expect(calls.find(c => c.fn === 'email-admin').auth).toBe('Bearer tok123');
});

test('wrong admin password: no dashboard, no email calls', async ({ page }) => {
  const calls = await stub(page, { loginOk: false });
  await signIn(page, 'wrong');
  await expect(page.locator('#login-error')).toBeVisible();
  await expect(page.locator('#view-dashboard')).toBeHidden();
  expect(calls.some(c => c.fn === 'email-admin')).toBe(false);
});

test('account list renders names as text (no HTML injection)', async ({ page }) => {
  await stub(page);
  const errors = []; page.on('pageerror', e => { if (!/tailwind/.test(String(e))) errors.push(String(e)); });
  await signIn(page);
  await expect(page.locator('#email-accounts-card')).toContainText('<b>Bad</b> Name');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('#email-accounts-card')).toContainText('Waiting: Create');
  expect(errors).toEqual([]);
});

test('add a board member: review addresses, then create sends the right request', async ({ page }) => {
  const calls = await stub(page);
  await signIn(page);
  await page.locator('#email-accounts-card button', { hasText: 'Add people' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('Nia Hart');
  await page.locator('#email-accounts-card input[type=checkbox]').first().check();
  await page.locator('#email-accounts-card select').first().selectOption('boardsecretary'); // role address
  await page.locator('#email-accounts-card button', { hasText: 'Review addresses' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('✓ Ready');
  await page.locator('#email-accounts-card button', { hasText: 'Create 1 account' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('Create Email Accounts');
  const create = calls.find(c => c.body && c.body.action === 'create').body;
  expect(create.people[0]).toMatchObject({ first: 'Nia', last: 'Hart', holderType: 'Board Member', holderId: 'recBOARD00000001', roleKey: 'boardsecretary' });
});

test('spreadsheet upload parses quoted CSV rows into the review step', async ({ page }) => {
  const calls = await stub(page);
  await signIn(page);
  await page.locator('#email-accounts-card button', { hasText: 'Upload spreadsheet' }).click();
  await page.fill('#email-accounts-card textarea', 'first,last,personalEmail,mobile,type,role\n"Ann ""AJ""",Lee,aj@gmail.com,404-555-0101,staff,\nSam,Ng,sam@yahoo.com,404-555-0102,board,boardtreasurer\n');
  await page.locator('#email-accounts-card button', { hasText: 'Review addresses' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('2 of 2 ready');
  const prev = calls.find(c => c.body && c.body.action === 'preview').body.people;
  expect(prev[0].first).toBe('Ann "AJ"');
  expect(prev[1]).toMatchObject({ holderType: 'Board Member', roleKey: 'boardtreasurer' });
});

test('signing out drops the admin token', async ({ page }) => {
  await stub(page);
  await signIn(page);
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.evaluate(() => signOut());
  expect(await page.evaluate(() => adminToken)).toBeNull();
});

test('dashboard shows which Airtable database is in use (confirmed live)', async ({ page }) => {
  await stub(page);
  await signIn(page);
  await expect(page.locator('#base-name')).toHaveText('2026 - 2027 ACE Student Enrollment');
  await expect(page.locator('#base-note')).toContainText('Confirmed live from Airtable');
});

test('dashboard warns when the database name could not be confirmed by Airtable', async ({ page }) => {
  await stub(page, { baseSource: 'recorded' });
  await signIn(page);
  await expect(page.locator('#base-name')).toHaveText('2026 - 2027 ACE Student Enrollment');
  await expect(page.locator('#base-note')).toContainText('did not confirm');
});

test('Caps Lock warning shows on the login password box and hides on blur', async ({ page }) => {
  await stub(page);
  await page.goto('/index.html');
  await page.evaluate(() => showView('login'));
  const pw = page.locator('#login-password');
  const hint = pw.locator('xpath=following-sibling::p[1]');
  await expect(hint).toBeHidden();
  await pw.focus();
  await pw.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', modifierCapsLock: true, bubbles: true })));
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Caps Lock is ON');
  await pw.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keyup', { key: 'CapsLock', modifierCapsLock: false, bubbles: true })));
  await expect(hint).toBeHidden();
  await pw.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', modifierCapsLock: true, bubbles: true })));
  await pw.blur();
  await expect(hint).toBeHidden();
});

test('every password box (register, login, reset) gets the Caps Lock warning', async ({ page }) => {
  await stub(page);
  await page.goto('/index.html');
  const n = await page.evaluate(() => [...document.querySelectorAll('input[type=password]')].filter(i => i.nextElementSibling && /Caps Lock/.test(i.nextElementSibling.textContent)).length);
  const total = await page.evaluate(() => document.querySelectorAll('input[type=password]').length);
  expect(total).toBeGreaterThanOrEqual(5);
  expect(n).toBe(total);
});

test('sample CSV template downloads, and its example rows are skipped on upload', async ({ page }) => {
  const calls = await stub(page);
  await signIn(page);
  await page.locator('#email-accounts-card button', { hasText: 'Upload spreadsheet' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#email-accounts-card button', { hasText: 'Download sample CSV template' }).click()]);
  expect(dl.suggestedFilename()).toBe('ace-email-accounts-template.csv');
  const text = (await require('fs').promises.readFile(await dl.path(), 'utf8'));
  expect(text.charCodeAt(0)).toBe(0xFEFF); // BOM so Excel reads it as UTF-8
  expect(text).toContain('first,last,personalEmail,mobile,type,role');
  // uploading the untouched template leaves nothing to review
  await page.fill('#email-accounts-card textarea', text);
  await page.locator('#email-accounts-card button', { hasText: 'Review addresses' }).click();
  await expect(page.locator('#email-accounts-card')).not.toContainText('ready.');
  expect(calls.some(c => c.body && c.body.action === 'preview')).toBe(false);
  // a real row mixed in with the examples still goes through
  await page.fill('#email-accounts-card textarea', text + 'Real,Person,real@gmail.com,404-555-0100,staff,\r\n');
  await page.locator('#email-accounts-card button', { hasText: 'Review addresses' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('1 of 1 ready');
});

test('Find a user: shows who already has an @flyace.org address, with status', async ({ page }) => {
  await stub(page);
  await signIn(page);
  const find = page.locator('#ea-find');
  await expect(find).toBeVisible();
  await expect(page.locator('#ea-find-results')).toBeEmpty();
  await find.fill('dana');
  const res = page.locator('#ea-find-results');
  await expect(res).toContainText('Already has an @flyace.org address (1)');
  await expect(res).toContainText('boardchair@flyace.org');
  await expect(res).toContainText('Dana Cole – Board Chair');
  await expect(res).toContainText('Waiting: Create');
  await find.fill('BOARDCHAIR');            // case-insensitive, matches the role key / address
  await expect(res).toContainText('boardchair@flyace.org');
  await find.fill('dana board');            // every word must match
  await expect(res).toContainText('boardchair@flyace.org');
  await find.fill('dana treasurer');
  await expect(res).toContainText('No match');
});

test('Find a user: a person in Board Members without an address can be sent straight to review', async ({ page }) => {
  const calls = await stub(page);
  await signIn(page);
  await page.locator('#ea-find').fill('hart');
  const res = page.locator('#ea-find-results');
  await expect(res).toContainText('no @flyace.org address yet (1)');
  await expect(res).toContainText('Nia Hart');
  await res.getByRole('button', { name: 'Create address' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('✓ Ready');
  const prev = calls.filter(c => c.body && c.body.action === 'preview').at(-1).body;
  expect(prev.people[0]).toMatchObject({ first: 'Nia', last: 'Hart', holderType: 'Board Member', holderId: 'recBOARD00000001' });
  expect(calls.filter(c => c.body && c.body.action === 'create')).toHaveLength(0); // review only, nothing created
});

test('Find a user: finds the existing pre-move mailboxes, never shows markup, and says when nobody matches', async ({ page }) => {
  await stub(page);
  const errors = []; page.on('pageerror', e => { if (!/tailwind/.test(String(e))) errors.push(String(e)); }); // tailwind is stubbed in tests
  await signIn(page);
  const find = page.locator('#ea-find'), res = page.locator('#ea-find-results');
  await find.fill('acestaff');
  await expect(res).toContainText('Existing mailbox from before the move');
  await expect(res).toContainText('acestaff@flyace.org');
  await find.fill('bad');
  await expect(res).toContainText('<b>Bad</b> Name');             // shown as text
  expect(await res.locator('b').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await find.fill('zzzzzz');
  await expect(res).toContainText('No match');
  await res.getByRole('button', { name: 'Add by hand' }).click();
  await expect(page.locator('#email-accounts-card')).toContainText('Or add one person by hand');
  await expect(find).toHaveValue('zzzzzz');                        // the search text survives switching tabs
  await find.fill('');
  await expect(res).toBeEmpty();
  expect(errors).toEqual([]);
});

test('the card and its sidebar link are named Create Email Accounts', async ({ page }) => {
  await stub(page);
  await signIn(page);
  await expect(page.locator('#email-accounts-card h3')).toHaveText('Create Email Accounts');
  await expect(page.locator('#sidebar [data-nav="Email Accounts"]')).toContainText('Create Email Accounts');
});
