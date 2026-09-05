// Smoke test for the Staff/Volunteer application forms (no login required — public forms).
// Drives the real page in Chromium with the Airtable proxy stubbed.
const { test, expect } = require('@playwright/test');

const AT_TABLE_STAFF = 'tblylF50qyHNtKHLH';
const AT_TABLE_VOLUNTEERS = 'tbltf83MZS1TEE6Kt';

async function stubNetwork(page, capture) {
  const jsonBody = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  await page.route('**/.netlify/functions/airtable\\?**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.searchParams.get('_path') || '');
    const method = route.request().method();

    if (method === 'POST' && (path.includes(AT_TABLE_STAFF) || path.includes(AT_TABLE_VOLUNTEERS))) {
      capture.path = path;
      capture.body = route.request().postDataJSON();
      return route.fulfill(jsonBody({ id: 'recNEW', fields: capture.body.fields }));
    }
    return route.fulfill(jsonBody({ records: [] }));
  });

  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
}

test('staff application: fill → submit → confirmation, writes Pending to Staff table', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });
  const capture = {};
  await stubNetwork(page, capture);
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'Apply for a Staff Position' }).click();
  await expect(page.locator('#staff-apply-form-card')).toBeVisible();

  await page.fill('#staff-name', 'Jordan Reed');
  await page.fill('#staff-email', 'jordan@example.com');
  await page.fill('#staff-phone', '555-123-4567');
  await page.selectOption('#staff-role', 'Instructor');
  await page.fill('#staff-notes', 'CFI, 5 years teaching experience.');
  await page.check('#staff-sms-optin');
  await page.click('#staff-apply-btn');

  await expect(page.locator('#staff-apply-success')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#staff-apply-success')).toContainText('Application Submitted');
  await expect(page.locator('#staff-apply-form-card')).toBeHidden();

  expect(capture.path).toContain(AT_TABLE_STAFF);
  expect(capture.body.fields['Full Name']).toBe('Jordan Reed');
  expect(capture.body.fields['Email']).toBe('jordan@example.com');
  expect(capture.body.fields['Role']).toBe('Instructor');
  expect(capture.body.fields['Status']).toBe('Pending');
  expect(capture.body.fields['Application Date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(capture.body.fields['SMS Opt-In']).toBe(true);
  expect(capture.body.fields['SMS Opt-In Date']).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('volunteer application: fill → submit → confirmation, writes Pending to Volunteers table', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });
  const capture = {};
  await stubNetwork(page, capture);
  await page.goto('/index.html');

  await page.locator('#view-home button', { hasText: 'Volunteer With Us' }).click();
  await expect(page.locator('#volunteer-apply-form-card')).toBeVisible();

  await page.fill('#volunteer-name', 'Sam Lee');
  await page.fill('#volunteer-email', 'sam@example.com');
  await page.fill('#volunteer-phone', '555-987-6543');
  await page.fill('#volunteer-availability', 'Saturdays AM');
  await page.check('#volunteer-sms-optin');
  await page.click('#volunteer-apply-btn');

  await expect(page.locator('#volunteer-apply-success')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#volunteer-apply-success')).toContainText('Application Submitted');

  expect(capture.path).toContain(AT_TABLE_VOLUNTEERS);
  expect(capture.body.fields['Full Name']).toBe('Sam Lee');
  expect(capture.body.fields['Availability Notes']).toBe('Saturdays AM');
  expect(capture.body.fields['Status']).toBe('Pending');
  expect(capture.body.fields['SMS Opt-In']).toBe(true);
  expect(capture.body.fields['SMS Opt-In Date']).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('validation: submitting with missing fields shows an error, does not call Airtable', async ({ page }) => {
  const capture = {};
  await stubNetwork(page, capture);
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'Apply for a Staff Position' }).click();
  await page.click('#staff-apply-btn');

  await expect(page.locator('#staff-apply-error')).toBeVisible();
  await expect(page.locator('#staff-apply-success')).toBeHidden();
  expect(capture.path).toBeUndefined();
});

test('validation: submitting without SMS opt-in checked shows an error, does not call Airtable', async ({ page }) => {
  const capture = {};
  await stubNetwork(page, capture);
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'Apply for a Staff Position' }).click();
  await page.fill('#staff-name', 'Jordan Reed');
  await page.fill('#staff-email', 'jordan@example.com');
  await page.fill('#staff-phone', '555-123-4567');
  await page.click('#staff-apply-btn');

  await expect(page.locator('#staff-apply-error')).toBeVisible();
  await expect(page.locator('#staff-apply-error')).toContainText('SMS');
  await expect(page.locator('#staff-apply-success')).toBeHidden();
  expect(capture.path).toBeUndefined();
});

/* ===== Cross-role guard (2026-09-05) =====
   One human must not hold both a Staff and a Volunteer record: the SMS reply handler matches an
   inbound text by phone and checks Staff first, so a person in both tables always resolves to
   Staff and their signups under the other role become unreachable by text. The forms block it. */

async function stubWithExisting(page, { staff = [], volunteers = [] }, capture = {}) {
  const jsonBody = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.route('**/.netlify/functions/airtable\\?**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.searchParams.get('_path') || '');
    const method = route.request().method();
    if (method === 'POST') {
      capture.path = path;
      capture.body = route.request().postDataJSON();
      return route.fulfill(jsonBody({ id: 'recNEW', fields: capture.body.fields }));
    }
    if (path.includes(AT_TABLE_STAFF)) return route.fulfill(jsonBody({ records: staff }));
    if (path.includes(AT_TABLE_VOLUNTEERS)) return route.fulfill(jsonBody({ records: volunteers }));
    return route.fulfill(jsonBody({ records: [] }));
  });
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
}

test('cross-role guard: applying as staff is blocked when a volunteer record shares the email', async ({ page }) => {
  const capture = {};
  await stubWithExisting(page, {
    volunteers: [{ id: 'recV1', fields: { 'Full Name': 'Pat Doe', Email: 'Pat.Doe@example.com', Phone: '555-000-1111' } }],
  }, capture);
  await page.goto('/index.html');

  await page.locator('#view-home button', { hasText: 'Apply for a Staff Position' }).click();
  await page.fill('#staff-name', 'Pat Doe');
  await page.fill('#staff-email', 'pat.doe@example.com'); // different case -> still a match
  await page.fill('#staff-phone', '555-222-3333');        // different phone
  await page.check('#staff-sms-optin');
  await page.click('#staff-apply-btn');

  await expect(page.locator('#staff-apply-error')).toBeVisible();
  await expect(page.locator('#staff-apply-error')).toContainText('already have a volunteer record');
  await expect(page.locator('#staff-apply-error')).toContainText('email address');
  await expect(page.locator('#staff-apply-success')).toBeHidden();
  expect(capture.body, 'no record should have been written').toBeUndefined();
});

test('cross-role guard: applying as a volunteer is blocked when a staff record shares the phone', async ({ page }) => {
  const capture = {};
  await stubWithExisting(page, {
    staff: [{ id: 'recS1', fields: { 'Full Name': 'Pam Harris', Email: 'pam@flyace.org', Phone: '4049312252' } }],
  }, capture);
  await page.goto('/index.html');

  await page.locator('#view-home button', { hasText: 'Volunteer With Us' }).click();
  await page.fill('#volunteer-name', 'Pam Harris');
  await page.fill('#volunteer-email', 'someone.else@example.com');   // email differs
  await page.fill('#volunteer-phone', '+1 (404) 931-2252');          // same number, formatted differently
  await page.check('#volunteer-sms-optin');
  await page.click('#volunteer-apply-btn');

  await expect(page.locator('#volunteer-apply-error')).toBeVisible();
  await expect(page.locator('#volunteer-apply-error')).toContainText('already have a staff record');
  await expect(page.locator('#volunteer-apply-error')).toContainText('phone number');
  await expect(page.locator('#volunteer-apply-success')).toBeHidden();
  expect(capture.body, 'no record should have been written').toBeUndefined();
});

test('cross-role guard: an unrelated person is still allowed through', async ({ page }) => {
  const capture = {};
  await stubWithExisting(page, {
    staff: [{ id: 'recS1', fields: { 'Full Name': 'Pam Harris', Email: 'pam@flyace.org', Phone: '4049312252' } }],
  }, capture);
  await page.goto('/index.html');

  await page.locator('#view-home button', { hasText: 'Volunteer With Us' }).click();
  await page.fill('#volunteer-name', 'Brand New');
  await page.fill('#volunteer-email', 'brand.new@example.com');
  await page.fill('#volunteer-phone', '555-777-8888');
  await page.check('#volunteer-sms-optin');
  await page.click('#volunteer-apply-btn');

  await expect(page.locator('#volunteer-apply-success')).toBeVisible({ timeout: 10000 });
  expect(capture.path).toContain(AT_TABLE_VOLUNTEERS);
  expect(capture.body.fields['Full Name']).toBe('Brand New');
  expect(capture.body.fields.Status).toBe('Pending');
});
