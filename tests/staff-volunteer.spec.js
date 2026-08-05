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

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('volunteer application: fill → submit → confirmation, writes Pending to Volunteers table', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });
  const capture = {};
  await stubNetwork(page, capture);
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'Volunteer With Us' }).click();
  await expect(page.locator('#volunteer-apply-form-card')).toBeVisible();

  await page.fill('#volunteer-name', 'Sam Lee');
  await page.fill('#volunteer-email', 'sam@example.com');
  await page.fill('#volunteer-phone', '555-987-6543');
  await page.fill('#volunteer-availability', 'Saturdays AM');
  await page.click('#volunteer-apply-btn');

  await expect(page.locator('#volunteer-apply-success')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#volunteer-apply-success')).toContainText('Application Submitted');

  expect(capture.path).toContain(AT_TABLE_VOLUNTEERS);
  expect(capture.body.fields['Full Name']).toBe('Sam Lee');
  expect(capture.body.fields['Availability Notes']).toBe('Saturdays AM');
  expect(capture.body.fields['Status']).toBe('Pending');

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
