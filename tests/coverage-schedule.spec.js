// Smoke test for the Saturday Coverage Schedule (email lookup -> view/sign up/cancel).
const { test, expect } = require('@playwright/test');

const AT_TABLE_STAFF = 'tblylF50qyHNtKHLH';
const AT_TABLE_VOLUNTEERS = 'tbltf83MZS1TEE6Kt';
const AT_TABLE_COVERAGE = 'tbl3DGD8ruJjlblf9';

async function stubNetwork(page, { staffRecord = null, volunteerRecord = null } = {}) {
  const jsonBody = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  let signups = []; // in-memory Coverage Signups, mutated by POST/DELETE
  let nextId = 1;

  await page.route('**/.netlify/functions/airtable\\?**', async (route) => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.searchParams.get('_path') || '');
    const method = route.request().method();

    if (path.includes(AT_TABLE_STAFF) && method === 'GET') {
      return route.fulfill(jsonBody({ records: staffRecord ? [staffRecord] : [] }));
    }
    if (path.includes(AT_TABLE_VOLUNTEERS) && method === 'GET') {
      return route.fulfill(jsonBody({ records: volunteerRecord ? [volunteerRecord] : [] }));
    }
    if (path.includes(AT_TABLE_COVERAGE)) {
      if (method === 'GET') return route.fulfill(jsonBody({ records: signups }));
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        const rec = { id: 'recSIGNUP' + (nextId++), fields: body.fields };
        signups.push(rec);
        return route.fulfill(jsonBody(rec));
      }
      if (method === 'DELETE') {
        const id = path.split('/').pop();
        signups = signups.filter((r) => r.id !== id);
        return route.fulfill(jsonBody({ id, deleted: true }));
      }
    }
    return route.fulfill(jsonBody({ records: [] }));
  });

  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
}

test('coverage lookup: unknown email shows an error, no schedule access', async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'View / Sign Up for Saturday Schedule' }).click();
  await page.fill('#coverage-lookup-email', 'nobody@example.com');
  await page.click('#coverage-lookup-btn');

  await expect(page.locator('#coverage-lookup-error')).toBeVisible();
  await expect(page.locator('#view-coverage')).toBeHidden();
});

test('coverage schedule: sign up for a slot then cancel it', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });

  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFF1', fields: { 'Full Name': 'Taylor Morgan', Email: 'taylor@example.com', Status: 'Active' } },
  });
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'View / Sign Up for Saturday Schedule' }).click();
  await page.fill('#coverage-lookup-email', 'taylor@example.com');
  await page.click('#coverage-lookup-btn');

  await expect(page.locator('#view-coverage')).toBeVisible();
  await expect(page.locator('#coverage-user-name')).toHaveText('Taylor Morgan');

  // First slot on the first upcoming Saturday card should show "No one yet" and a Sign Up button.
  const firstCard = page.locator('#coverage-schedule > div').first();
  await expect(firstCard).toContainText('No one yet');
  await firstCard.locator('button', { hasText: 'Sign Up' }).first().click();

  await expect(firstCard.getByText('Taylor Morgan (You)')).toBeVisible({ timeout: 10000 });
  await expect(firstCard.locator('button', { hasText: 'Cancel' }).first()).toBeVisible();

  // Cancel it back.
  await firstCard.locator('button', { hasText: 'Cancel' }).first().click();
  await expect(firstCard.getByText('Taylor Morgan (You)')).toBeHidden({ timeout: 10000 });

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('coverage schedule: volunteer lookup works the same as staff (checks both tables)', async ({ page }) => {
  await stubNetwork(page, {
    volunteerRecord: { id: 'recVOL1', fields: { 'Full Name': 'Sam Lee', Email: 'sam@example.com', Status: 'Active' } },
  });
  await page.goto('/index.html');

  await page.locator('button', { hasText: 'View / Sign Up for Saturday Schedule' }).click();
  await page.fill('#coverage-lookup-email', 'sam@example.com');
  await page.click('#coverage-lookup-btn');

  await expect(page.locator('#view-coverage')).toBeVisible();
  await expect(page.locator('#coverage-user-name')).toHaveText('Sam Lee');
});
