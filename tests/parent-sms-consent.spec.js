// Parent/guardian text-message consent checkbox on the student application form.
// Drives the real page in Chromium with the Airtable proxy stubbed; asserts exactly what is written.
const { test, expect } = require('@playwright/test');

const ACCOUNTS = 'tblwJ9C1BQIMGMzKx'; // Portal Accounts
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

async function stubNetwork(page, capture, { existingRecord = null } = {}) {
  const jsonBody = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.route('**/.netlify/functions/airtable\\?**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.searchParams.get('_path') || '');
    const method = route.request().method();
    const isAccounts = path.includes(ACCOUNTS);
    const isIdGen = !!url.searchParams.get('fields[]');
    if (isAccounts) return route.fulfill(jsonBody(method === 'GET' ? { records: [] } : { id: 'accNEW', fields: {} }));
    if (method === 'GET') {
      if (isIdGen) return route.fulfill(jsonBody({ records: [{ fields: { 'Student ID Number': 'STU900' } }] }));
      return route.fulfill(jsonBody({ records: existingRecord ? [existingRecord] : [] }));
    }
    if (method === 'POST' || method === 'PATCH') {
      (capture.writes = capture.writes || []).push({ method, path, fields: route.request().postDataJSON().fields });
      return route.fulfill(jsonBody({ id: 'recNEW', fields: { 'Student ID Number': 'STU901' } }));
    }
    return route.fulfill(jsonBody({}));
  });
  await page.route('**/.netlify/functions/airtable-upload', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await page.route('**/webhook/onboarding-validate-id', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outcome: 'CURRENT', documentType: 'passport', expirationDate: '2032-01-01', isTemporary: false, confidence: 0.98 }) }));
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
}

async function startNewApplication(page, email) {
  await page.goto('/index.html');
  await page.locator('button', { hasText: 'New ACE Student' }).first().click();
  await page.fill('#reg-name', 'Test Parent');
  await page.fill('#reg-email', email);
  await page.fill('#reg-password', 'password123');
  await page.fill('#reg-confirm', 'password123');
  await page.fill('#reg-security-q', 'What city were you born in?');
  await page.fill('#reg-security-a', 'Testville');
  await page.click('#reg-submit-btn');
  await expect(page.locator('#lr-edit-card')).toBeVisible();
}

async function fillAndSubmit(page) {
  await page.fill('#edit-first-name', 'Jamie');
  await page.fill('#edit-last-name', 'Rivera');
  await page.fill('#edit-student-email', 'jamie@example.com');
  await page.selectOption('#edit-grade', '9th');
  await page.fill('#edit-parent-phone', '(404) 555-0100');
  await page.fill('#edit-essay', 'I want to learn to fly.');
  await page.locator('label.attend-option', { hasText: 'AM Session' }).click();
  await page.setInputFiles('input[onchange*="lookup-citizenship"]', { name: 'passport.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await expect(page.locator('#edit-id-exp')).toHaveValue('2032-01-01', { timeout: 15000 });
  await page.click('#edit-save-btn');
  await expect(page.locator('#lr-submitted-card')).toBeVisible({ timeout: 15000 });
}

test('consent box is shown, unchecked by default, with required SMS disclosures and policy links', async ({ page }) => {
  await stubNetwork(page, {});
  await startNewApplication(page, 'p1@example.com');
  const box = page.locator('#edit-sms-consent');
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  const text = await page.locator('#sms-consent-row').innerText();
  for (const phrase of ['Aviation Career Enrichment', 'Message frequency varies', 'Msg & data rates may apply', 'Reply STOP to opt out, HELP for help', 'not a condition of enrollment']) {
    expect(text).toContain(phrase);
  }
  await expect(page.locator('#sms-consent-row a[href="https://www.flyace.org/privacy-policy"]')).toBeVisible();
  await expect(page.locator('#sms-consent-row a[href="https://www.flyace.org/terms-conditions"]')).toBeVisible();
});

test('checked consent is saved with a timestamp', async ({ page }) => {
  const cap = {};
  await stubNetwork(page, cap);
  await startNewApplication(page, 'p2@example.com');
  await page.check('#edit-sms-consent');
  await fillAndSubmit(page);
  const w = cap.writes.find((x) => x.method === 'POST' && !x.path.includes(ACCOUNTS));
  expect(w.fields['Parent SMS Opt-In']).toBe(true);
  expect(w.fields['Parent SMS Opt-In Date']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('unchecked consent writes nothing about consent (not consented)', async ({ page }) => {
  const cap = {};
  await stubNetwork(page, cap);
  await startNewApplication(page, 'p3@example.com');
  await fillAndSubmit(page);
  const w = cap.writes.find((x) => x.method === 'POST' && !x.path.includes(ACCOUNTS));
  expect(w.fields).not.toHaveProperty('Parent SMS Opt-In');
  expect(w.fields).not.toHaveProperty('Parent SMS Opt-In Date');
});

test('Add Another Child carries the consent (and original date) to the sibling form', async ({ page }) => {
  const cap = {};
  await stubNetwork(page, cap);
  await startNewApplication(page, 'p4@example.com');
  await page.check('#edit-sms-consent');
  await fillAndSubmit(page);
  const first = cap.writes.find((x) => x.method === 'POST' && !x.path.includes(ACCOUNTS));
  await page.locator('#lr-submitted-card button', { hasText: 'Add Another Child' }).click();
  await expect(page.locator('#lr-edit-card')).toBeVisible();
  await expect(page.locator('#edit-sms-consent')).toBeChecked();
  // Sibling save keeps the ORIGINAL consent date rather than stamping a new one.
  cap.writes.length = 0;
  await page.fill('#edit-first-name', 'Casey');
  await page.fill('#edit-last-name', 'Rivera');
  await page.fill('#edit-student-email', 'casey@example.com');
  await page.selectOption('#edit-grade', '7th');
  await page.fill('#edit-essay', 'Planes!');
  await page.locator('label.attend-option', { hasText: 'PM Session' }).click();
  await page.setInputFiles('input[onchange*="lookup-citizenship"]', { name: 'passport.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await expect(page.locator('#edit-id-exp')).toHaveValue('2032-01-01', { timeout: 15000 });
  await page.click('#edit-save-btn');
  await expect(page.locator('#lr-submitted-card')).toBeVisible({ timeout: 15000 });
  const sib = cap.writes.find((x) => x.method === 'POST' && !x.path.includes(ACCOUNTS));
  expect(sib.fields['Parent SMS Opt-In']).toBe(true);
  expect(sib.fields['Parent SMS Opt-In Date']).toBe(first.fields['Parent SMS Opt-In Date']);
});
