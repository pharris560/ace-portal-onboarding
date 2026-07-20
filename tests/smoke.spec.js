// End-to-end smoke test for the ACE onboarding portal.
// Drives the REAL page in Chromium with all data endpoints stubbed (no live Airtable / n8n / uploads),
// walking the full new-student flow: register -> fill form -> single-select attendance -> stage a
// proof-of-citizenship doc (vision auto-read) -> submit -> confirmation -> Add Another Child.
//
// Run:  npm run test:install   (once, downloads Chromium)
//       npm run test:smoke
const { test, expect } = require('@playwright/test');

const ACCOUNTS = 'tblwJ9C1BQIMGMzKx'; // Portal Accounts
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

// Install network stubs so the page never touches live services.
async function stubNetwork(page, { existingAccount = null, parentHasRecord = false } = {}) {
  const jsonBody = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

  // Airtable goes through the Netlify proxy: /.netlify/functions/airtable?_path=/{base}/{table}...&...
  await page.route('**/.netlify/functions/airtable\\?**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.searchParams.get('_path') || '');
    const method = route.request().method();
    const isAccounts = path.includes(ACCOUNTS);
    const isIdGen = !!url.searchParams.get('fields[]'); // generateStudentId query

    if (isAccounts) {
      if (method === 'GET') return route.fulfill(jsonBody({ records: existingAccount ? [existingAccount] : [] }));
      if (method === 'POST') return route.fulfill(jsonBody({ id: 'accNEW', fields: {} }));
      if (method === 'PATCH') return route.fulfill(jsonBody({ id: 'accNEW', fields: {} }));
    }
    // All Students table
    if (method === 'GET') {
      if (isIdGen) return route.fulfill(jsonBody({ records: [{ fields: { 'Student ID Number': 'STU900' } }] }));
      return route.fulfill(jsonBody({ records: parentHasRecord ? [{ id: 'recEXIST', fields: { 'First Name': 'Existing', 'Primary Parent Email': 'parent@example.com' } }] : [] }));
    }
    if (method === 'POST') return route.fulfill(jsonBody({ id: 'recNEW', fields: { 'Student ID Number': 'STU901' } }));
    if (method === 'PATCH') return route.fulfill(jsonBody({ id: 'recNEW', fields: {} }));
    return route.fulfill(jsonBody({}));
  });

  // Attachment upload
  await page.route('**/.netlify/functions/airtable-upload', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  // Claude-vision expiration read
  await page.route('**/webhook/onboarding-validate-id', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ outcome: 'CURRENT', documentType: 'passport', expirationDate: '2032-01-01', isTemporary: false, confidence: 0.98 }) }));

  // Keep it hermetic: satisfy external CDNs with empty 200s (styling isn't under test).
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
}

async function fillNewApplicantRegistration(page, email) {
  await page.locator('button', { hasText: 'New ACE Student' }).first().click();
  await expect(page.locator('#reg-name')).toBeVisible();
  await page.fill('#reg-name', 'Test Parent');
  await page.fill('#reg-email', email);
  await page.fill('#reg-password', 'password123');
  await page.fill('#reg-confirm', 'password123');
  await page.fill('#reg-security-q', 'What city were you born in?');
  await page.fill('#reg-security-a', 'Testville');
  await page.click('#reg-submit-btn');
}

test('new-student application: register → fill → submit → confirmation → add another child', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });

  await stubNetwork(page, { parentHasRecord: false });
  await page.goto('/index.html');

  // Register a brand-new applicant → lands on the create form
  await fillNewApplicantRegistration(page, 'parent@example.com');

  const editCard = page.locator('#lr-edit-card');
  await expect(editCard).toBeVisible();
  await expect(page.locator('#edit-card-title')).toHaveText('New Student Application');
  await expect(page.locator('#uploads-card-title')).toHaveText('Upload Documents');
  await expect(page.locator('#edit-new-returning')).toHaveValue('New');

  // Fill required student fields
  await page.fill('#edit-first-name', 'Jamie');
  await page.fill('#edit-last-name', 'Rivera');
  await page.fill('#edit-student-email', 'jamie@example.com');
  await page.selectOption('#edit-grade', '9th');
  await page.fill('#edit-essay', 'I want to learn to fly and build a career in aviation.');

  // Attendance is a SINGLE choice — click AM then PM, only PM should remain selected
  await page.locator('label.attend-option', { hasText: 'AM Session' }).click();
  await expect(page.locator('#edit-attend-am')).toBeChecked();
  await page.locator('label.attend-option', { hasText: 'PM Session' }).click();
  await expect(page.locator('#edit-attend-pm')).toBeChecked();
  await expect(page.locator('#edit-attend-am')).not.toBeChecked(); // mutually exclusive

  // Stage the proof-of-citizenship doc → vision auto-read fills the ID expiration date
  await page.setInputFiles('input[onchange*="lookup-citizenship"]', { name: 'passport.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await expect(page.locator('#edit-id-exp')).toHaveValue('2032-01-01', { timeout: 15000 });

  // Submit → confirmation screen
  await page.click('#edit-save-btn');
  const confirm = page.locator('#lr-submitted-card');
  await expect(confirm).toBeVisible({ timeout: 15000 });
  await expect(confirm).toContainText('Application Submitted');
  await expect(confirm).toContainText('ACE Staff will review');
  await expect(page.locator('#lr-submitted-id')).toContainText('STU');
  await expect(confirm.locator('button', { hasText: 'Add Another Child' })).toBeVisible();

  // Add Another Child → fresh create form, parent carried over, student blank
  await confirm.locator('button', { hasText: 'Add Another Child' }).click();
  await expect(editCard).toBeVisible();
  await expect(page.locator('#edit-card-title')).toHaveText('New Student Application');
  await expect(page.locator('#edit-parent-email')).toHaveValue('parent@example.com');
  await expect(page.locator('#edit-first-name')).toHaveValue('');
  await expect(page.locator('#edit-new-returning')).toHaveValue('New');

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('privacy: signing out clears the uploaded-doc status for the next user', async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/index.html');
  await fillNewApplicantRegistration(page, 'parent2@example.com');
  await expect(page.locator('#lr-edit-card')).toBeVisible();

  // Upload a doc, then sign out
  await page.setInputFiles('input[onchange*="lookup-citizenship"]', { name: 'passport.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG });
  await expect(page.locator('#status-lookup-citizenship')).not.toHaveText('Drop file or click to browse');
  await page.click('#user-indicator button, button:has-text("Sign Out")');

  // Back on home; re-enter the flow → the dropzone must be reset (no prior filename)
  await fillNewApplicantRegistration(page, 'parent3@example.com');
  await expect(page.locator('#lr-edit-card')).toBeVisible();
  await expect(page.locator('#status-lookup-citizenship')).toHaveText('Drop file or click to browse');
});
