// Admissions Pipeline = student record search (parent + contact details) and collapsible dashboard cards.
const { test, expect } = require('@playwright/test');

const ADMIN = { id: 'recADMIN00000001', fields: { Email: 'pam@example.com', 'Full Name': 'Pam Admin', 'Account Type': { name: 'Administrator' } } };
const F = { first: 'flduMlCg6WQYp1603', last: 'fldaIIUPWQqHMxUbG', id: 'fld83rlR3Ofe9zYFi', status: 'fldN7rJY04UdUoqrn', stage: 'fldoGmKcbKN5q8T0R', cls: 'fld4UyibXcJF6Jma0', ses: 'fldQDbLbNGhcTpf8s', pFirst: 'fldqJs1uDhrOJchi7', pLast: 'fldeQZnY89hXgeK76', pPhone: 'fld4SUbeEjG6Zin5l', pEmail: 'fldHE8GLMmh1GZqz6', email: 'fldoxaHnlJN2wZTXU' };
const student = (n, first, last, status, extra = {}) => ({ id: 'recS' + n, createdTime: '2026-09-01T00:00:00.000Z', fields: { [F.first]: first, [F.last]: last, [F.id]: 'ACE-' + n, [F.status]: status, [F.stage]: 'Complete ', [F.cls]: ['Falcons'], [F.ses]: ['AM Session 9am-11:30am'], ...extra } });
const STUDENTS = [
  student(1, 'Ada', 'Lovelace', 'Active', { [F.pFirst]: 'Byron', [F.pLast]: 'Lovelace', [F.pPhone]: '(404) 555-0101', [F.pEmail]: 'byron@example.com' }),
  student(2, 'Adam', 'Withdrawn', 'Withdrawn', { [F.pFirst]: 'Pat', [F.pLast]: 'Withdrawn' }),
  student(3, '<img src=x onerror=window.__xss=1>', 'Evil', 'Active', { [F.pFirst]: '<b>P</b>', [F.pLast]: 'X' }),
];

async function setup(page) {
  const j = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  let tableCalls = [];
  await page.route('**/.netlify/functions/airtable**', (route) => {
    const url = decodeURIComponent(route.request().url());
    if (url.includes('tbluHnJc9VM6l4U6V')) { tableCalls.push(url); return route.fulfill(j({ records: STUDENTS })); }
    return route.fulfill(j({ records: [ADMIN] }));
  });
  await page.route('**/.netlify/functions/portal-login', (r) => r.fulfill(j({ token: 't', rec: 'recADMIN', role: 'admin', type: 'Administrator', expiresInMinutes: 30, name: 'Pam Admin', email: 'pam@example.com' })));
  await page.route('**/.netlify/functions/base-info', (r) => r.fulfill(j({ name: '2026 - 2027 ACE Student Enrollment', source: 'airtable' })));
  await page.route('**/.netlify/functions/email-admin', (r) => r.fulfill(j({ accounts: [], candidates: { staff: [], board: [] }, roleKeys: {}, licensesUsed: 0, licenseLimit: 300 })));
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  await page.goto('/index.html');
  await page.evaluate(() => showView('login'));
  await page.fill('#login-email', 'pam@example.com');
  await page.fill('#login-password', 'secret-pw-1');
  await page.click('#login-submit-btn');
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#student-count')).toContainText('match the filters');
  return tableCalls;
}

test('no stat tiles or stage board; search starts empty', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#stat-cards')).toHaveCount(0);
  await expect(page.locator('#pipeline-board')).toHaveCount(0);
  await expect(page.locator('.student-row')).toHaveCount(0);
});

test('search by name shows the student; expanding shows parent name, phone and email', async ({ page }) => {
  const calls = await setup(page);
  expect(calls.some((u) => u.includes('returnFieldsByFieldId=true'))).toBe(true);
  await page.fill('#student-search', 'ada');
  await expect(page.locator('.student-row')).toHaveCount(1); // Adam is Withdrawn: hidden by the default Active filter
  await page.locator('.student-head').click();
  const d = page.locator('.student-detail');
  await expect(d).toBeVisible();
  await expect(d).toContainText('Byron Lovelace');
  await expect(d.locator('a[href="tel:4045550101"]')).toHaveText('(404) 555-0101');
  await expect(d.locator('a[href="mailto:byron@example.com"]')).toBeVisible();
});

test('classes show as AM/PM + class; students in both sessions appear under both', async ({ page }) => {
  await setup(page);
  const out = await page.evaluate(() => [
    classLabels(['Hawks'], ['AM Session 9am-11:30am']),
    classLabels(['Falcons'], ['PM Session 12:30pm-3pm']),
    classLabels(['Eagles'], ['PM Session 12:30pm-3pm', 'AM Session 9am-11:30am']),
    classLabels(['Hawks'], []),
    classLabels(['Graduating Senior', 'Sparrows'], ['AM Session 9am-11:30am']),
  ]);
  expect(out).toEqual([['AM Hawks'], ['PM Falcons'], ['AM Eagles', 'PM Eagles'], ['Hawks'], ['Graduating Senior', 'AM Sparrows']]);
  const opts = await page.locator('#class-filter option').allTextContents();
  expect(opts).toEqual(['All Classes', 'AM Falcons']);
});

test('phone numbers display as (404) 555-0101 however they are stored', async ({ page }) => {
  await setup(page);
  const out = await page.evaluate(() => ['4045550101', '+1 404-555-0101', '1.404.555.0101', '(404) 555-0101', '555-0101', '', '+44 20 7946 0958'].map(formatPhone));
  expect(out).toEqual(['(404) 555-0101', '(404) 555-0101', '(404) 555-0101', '(404) 555-0101', '555-0101', '', '+44 20 7946 0958']);
});

test('status filter: All Statuses reveals withdrawn students; searching by parent name works', async ({ page }) => {
  await setup(page);
  await page.fill('#student-search', 'ada');
  await page.selectOption('#status-filter', '');
  await expect(page.locator('.student-row')).toHaveCount(2);
  await page.fill('#student-search', 'byron');
  await expect(page.locator('.student-row')).toHaveCount(1);
  await page.fill('#student-search', 'zzzz');
  await expect(page.locator('#student-results')).toContainText('No students found');
});

test('picking a Class alone lists that class\'s active students (no typing needed)', async ({ page }) => {
  await setup(page);
  await page.selectOption('#class-filter', 'AM Falcons');
  await expect(page.locator('.student-row')).toHaveCount(2); // Ada + the evil-named one; Adam is Withdrawn
  await expect(page.locator('#student-count')).toContainText('in AM Falcons');
  await expect(page.locator('.student-row').first()).toContainText('AM Falcons');
  await page.fill('#student-search', 'zzzz');
  await expect(page.locator('#student-results')).toContainText('No students found');
  await page.fill('#student-search', '');
  await page.selectOption('#class-filter', '');
  await expect(page.locator('.student-row')).toHaveCount(0);
});

test('record values render as text (no HTML injection)', async ({ page }) => {
  await setup(page);
  await page.fill('#student-search', 'evil');
  await expect(page.locator('.student-row')).toHaveCount(1);
  await expect(page.locator('.student-row')).toContainText('<img src=x onerror=window.__xss=1>');
  await page.locator('.student-head').click();
  await expect(page.locator('.student-detail')).toContainText('<b>P</b> X');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('Admissions Pipeline and Coverage Schedule cards collapse, and the choice is remembered', async ({ page }) => {
  await setup(page);
  const pipeBtn = page.locator('.collapse-btn', { hasText: 'Admissions Pipeline' });
  const covBtn = page.locator('.collapse-btn', { hasText: 'Coverage Schedule' });
  await expect(page.locator('#student-search')).toBeVisible();
  await pipeBtn.click();
  await expect(page.locator('#student-search')).toBeHidden();
  await expect(pipeBtn).toHaveAttribute('aria-expanded', 'false');
  await covBtn.click();
  await expect(page.locator('#admin-coverage-schedule')).toBeHidden();
  await page.reload();
  await expect(page.locator('#view-home')).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ace-collapsed')));
  expect(saved).toEqual({ 'Admissions Pipeline': true, 'Coverage Schedule': true });
  await page.evaluate(() => { adminAuthenticated = true; showView('dashboard'); });
  await expect(page.locator('#student-search')).toBeHidden();
  await page.locator('.collapse-btn', { hasText: 'Admissions Pipeline' }).click();
  await expect(page.locator('#student-search')).toBeVisible();
});

test('heading shows the student total on the same line, in the same font size as the heading', async ({ page }) => {
  await setup(page);
  const total = page.locator('#pipeline-total');
  await expect(total).toHaveText('· 2 students'); // Status: Active (Adam is Withdrawn)
  const h3 = page.locator('#view-dashboard h3', { hasText: 'Admissions Pipeline' });
  const cls = async (l) => (await l.getAttribute('class')).split(/\s+/);
  const sizeOf = (c) => c.filter((x) => /^text-(xs|sm|base|lg|xl|\dxl)$/.test(x));
  expect(sizeOf(await cls(total))).toEqual(sizeOf(await cls(h3)));
  const a = await h3.boundingBox(), b = await total.boundingBox();
  expect(Math.abs((a.y + a.height / 2) - (b.y + b.height / 2))).toBeLessThanOrEqual(2); // vertically centred on the heading, same line
  await page.selectOption('#status-filter', '');
  await expect(total).toHaveText('· 3 students');
});

test('selecting a class shows its student count big and bold; clearing the class hides it', async ({ page }) => {
  await setup(page);
  const big = page.locator('#class-total');
  await expect(big).toBeHidden();
  await page.selectOption('#class-filter', 'AM Falcons');
  await expect(big).toBeVisible();
  await expect(big).toHaveText('2 students in AM Falcons');
  const c = await big.getAttribute('class');
  expect(c).toMatch(/text-3xl/); expect(c).toMatch(/font-extrabold/);
  await page.selectOption('#status-filter', '');
  await expect(big).toHaveText('3 students in AM Falcons');
  await page.selectOption('#class-filter', '');
  await expect(big).toBeHidden();
});

test('selecting a class shows the note about student details and group email (Staff Portal link); hidden otherwise', async ({ page }) => {
  await setup(page);
  const note = page.locator('#class-note');
  await expect(note).toBeHidden();
  await page.selectOption('#class-filter', 'AM Falcons');
  await expect(note).toBeVisible();
  await expect(note).toContainText("For more details, select the student's name.");
  await expect(note).toContainText('To send a group email, please log in to the Staff Portal.');
  const link = note.locator('a');
  await expect(link).toHaveAttribute('href', 'https://staff-portal.flyace.org');
  await expect(link).toHaveAttribute('target', '_blank');
  await page.selectOption('#class-filter', '');
  await expect(note).toBeHidden();
});
