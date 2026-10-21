// Stage 1 single sign-in: the page asks the server (portal-login) who you are and what role you have.
const { test, expect } = require('@playwright/test');

const j = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

async function stub(page, loginResponse) {
  const calls = { login: [], logout: 0, airtable: [] };
  await page.route('**/.netlify/functions/portal-login', (r) => { calls.login.push(r.request().postDataJSON()); return r.fulfill(typeof loginResponse === 'function' ? loginResponse(r) : loginResponse); });
  await page.route('**/.netlify/functions/portal-session', (r) => { if (r.request().method() === 'POST') calls.logout++; return r.fulfill(j({ ok: true })); });
  await page.route('**/.netlify/functions/airtable**', (r) => { calls.airtable.push(decodeURIComponent(r.request().url())); return r.fulfill(j({ records: [] })); });
  await page.route('**/.netlify/functions/base-info', (r) => r.fulfill(j({ name: 'x', source: 'airtable' })));
  await page.route('**/.netlify/functions/email-admin', (r) => r.fulfill(j({ accounts: [], candidates: { staff: [], board: [] }, roleKeys: {}, licensesUsed: 0, licenseLimit: 300 })));
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  return calls;
}
async function signIn(page, email = 'someone@example.com', pw = 'pw-12345') {
  await page.goto('/index.html');
  await page.evaluate(() => showView('login'));
  await page.fill('#login-email', email);
  await page.fill('#login-password', pw);
  await page.click('#login-submit-btn');
}
const PARENT = { rec: 'recP', role: 'parent', type: 'Existing Student', expiresInMinutes: 120, name: 'Pat Parent', email: 'parent@example.com' };
const ADMIN = { rec: 'recA', role: 'admin', type: 'Administrator', expiresInMinutes: 30, name: 'Pam Admin', email: 'pam@example.com', token: 'tok' };

test('parent signs in through the server: no password hash is read in the browser, and there is no sidebar', async ({ page }) => {
  const calls = await stub(page, j(PARENT));
  await signIn(page, 'parent@example.com', 'parent-pw-1');
  await expect.poll(() => page.evaluate(() => loggedInUser && loggedInUser.role)).toBe('parent');
  await expect(page.locator('#view-login')).toBeHidden();
  expect(calls.login).toEqual([{ email: 'parent@example.com', password: 'parent-pw-1' }]);
  expect(await page.locator('#sidebar').count()).toBe(0);
  const evil = calls.airtable.filter((u) => u.includes('tblwJ9C1BQIMGMzKx') && u.includes('filterByFormula') && !u.includes('/rec'));
  expect(evil).toEqual([]); // login no longer fetches the Portal Accounts row (and its hash) into the page
});

test('administrator: sidebar and dashboard appear, driven by the server role', async ({ page }) => {
  await stub(page, j(ADMIN));
  await signIn(page, 'pam@example.com');
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#sidebar')).toHaveCount(1);
});

test('staff / volunteer / board are told to use an emailed code and are NOT signed in', async ({ page }) => {
  await stub(page, j({ error: 'Staff and volunteers sign in with an emailed code, not a password.', method: 'code' }, 409));
  await signIn(page, 'staff@example.com');
  await expect(page.locator('#login-error')).toContainText('emailed code');
  await expect(page.locator('#view-dashboard')).toBeHidden();
  expect(await page.locator('#sidebar').count()).toBe(0);
});

test('wrong-password message comes from the server', async ({ page }) => {
  await stub(page, j({ error: 'Incorrect password. Please try again.' }, 401));
  await signIn(page);
  await expect(page.locator('#login-error')).toContainText('Incorrect password');
});

test('a server error is shown kindly and nothing is signed in', async ({ page }) => {
  await stub(page, () => j({}, 502));
  await signIn(page);
  await expect(page.locator('#login-error')).toContainText('right now');
  await expect(page.locator('#view-login')).toBeVisible();
});

test('automatic sign-out: parents after 2 hours, administrators after 30 minutes', async ({ page }) => {
  for (const [resp, minutes] of [[PARENT, 120], [ADMIN, 30]]) {
    await page.clock.install();
    const calls = await stub(page, j(resp));
    await signIn(page, 'x@example.com');
    await expect(page.locator('#login-email')).toBeAttached();
    await page.clock.runFor((minutes - 1) * 60 * 1000);
    expect(await page.evaluate(() => loggedInUser && loggedInUser.email)).toBe(resp.email); // still signed in a minute early
    await page.clock.runFor(2 * 60 * 1000);
    expect(await page.evaluate(() => loggedInUser)).toBeNull();
    expect(calls.logout).toBeGreaterThan(0); // the server cookie is cleared too
    await page.unroute('**/*').catch(() => {});
  }
});

test('signing out clears the server cookie', async ({ page }) => {
  const calls = await stub(page, j(PARENT));
  await signIn(page, 'parent@example.com');
  await expect.poll(() => page.evaluate(() => loggedInUser && loggedInUser.role)).toBe('parent');
  await page.evaluate(() => signOut());
  await expect.poll(() => calls.logout).toBe(1);
});

test('administrator dashboard has a card and a sidebar link that open the Staff Portal in a new tab', async ({ page }) => {
  await stub(page, j(ADMIN));
  await signIn(page, 'pam@example.com');
  await expect(page.locator('#view-dashboard')).toBeVisible();
  for (const sel of ['#staff-portal-card', '#staff-portal-link']) {
    const a = page.locator(sel);
    await expect(a).toHaveAttribute('href', 'https://staff-portal.flyace.org');
    await expect(a).toHaveAttribute('target', '_blank');
    await expect(a).toHaveAttribute('rel', /noopener/);
  }
});

test('parents and students never get the Staff Portal link (no sidebar, dashboard not shown)', async ({ page }) => {
  await stub(page, j(PARENT));
  await signIn(page, 'parent@example.com');
  await expect.poll(() => page.evaluate(() => loggedInUser && loggedInUser.role)).toBe('parent');
  expect(await page.locator('#staff-portal-link').count()).toBe(0); // sidebar is removed from the page
  await expect(page.locator('#staff-portal-card')).toBeHidden();
});
