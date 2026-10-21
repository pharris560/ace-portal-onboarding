// Admissions Pipeline = student record search (parent + contact details) and collapsible dashboard cards.
const { test, expect } = require('@playwright/test');

const ADMIN = { id: 'recADMIN00000001', fields: { Email: 'pam@example.com', 'Full Name': 'Pam Admin', 'Account Type': { name: 'Administrator' } } };
const F = { first: 'flduMlCg6WQYp1603', last: 'fldaIIUPWQqHMxUbG', id: 'fld83rlR3Ofe9zYFi', status: 'fldN7rJY04UdUoqrn', stage: 'fldoGmKcbKN5q8T0R', cls: 'fld4UyibXcJF6Jma0', pFirst: 'fldqJs1uDhrOJchi7', pLast: 'fldeQZnY89hXgeK76', pPhone: 'fld4SUbeEjG6Zin5l', pEmail: 'fldHE8GLMmh1GZqz6', email: 'fldoxaHnlJN2wZTXU' };
const student = (n, first, last, status, extra = {}) => ({ id: 'recS' + n, createdTime: '2026-09-01T00:00:00.000Z', fields: { [F.first]: first, [F.last]: last, [F.id]: 'ACE-' + n, [F.status]: status, [F.stage]: 'Complete ', [F.cls]: ['Falcons'], ...extra } });
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
  await page.route('**/.netlify/functions/admin-login', (r) => r.fulfill(j({ token: 't', name: 'Pam Admin', email: 'pam@example.com' })));
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
  await page.selectOption('#class-filter', 'Falcons');
  await expect(page.locator('.student-row')).toHaveCount(2); // Ada + the evil-named one; Adam is Withdrawn
  await expect(page.locator('#student-count')).toContainText('in Falcons');
  await page.selectOption('#class-filter', 'Sparrows');
  await expect(page.locator('#student-results')).toContainText('No students found');
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
