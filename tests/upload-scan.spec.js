// Parent/student document uploads: scanning animation while the server virus-scans, clean/blocked outcomes.
const { test, expect } = require('@playwright/test');
const j = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

async function setup(page, uploadHandler) {
  const calls = [];
  await page.route('**/.netlify/functions/airtable**', (r) => r.fulfill(j({ records: [] })));
  // registered AFTER the broad airtable** stub so it takes precedence for the upload function
  await page.route('**/.netlify/functions/airtable-upload', async (r) => { calls.push(r.request().postDataJSON()); return uploadHandler(r); });
  await page.route('https://n8n.flyace.org/**', (r) => r.fulfill(j({})));
  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  await page.goto('/index.html');
  await page.evaluate(() => { currentLookupRecordId = 'recABCDEFGHIJKLMN'; isCreateMode = false; });
  return calls;
}
const upload = (page) => page.evaluate(() => {
  const s = document.getElementById('status-lookup-citizenship') || (() => { const d = document.createElement('div'); d.id = 'status-lookup-citizenship'; document.body.appendChild(d); return d; })();
  const f = new File([new Uint8Array(300)], 'birth-certificate.pdf', { type: 'application/pdf' });
  return uploadDocToAirtable(f, AT_FIELD_ATTACHMENTS, 'status-lookup-citizenship');
});

test('while the server scans, the pop-up shows the scanning animation; a clean file then shows Scanned clean', async ({ page }) => {
  const calls = await setup(page, async (r) => { await new Promise((res) => setTimeout(res, 800)); return r.fulfill(j({ id: 'recX', fields: {} })); });
  const done = upload(page);
  await expect(page.locator('#ace-mtitle')).toHaveText('Scanning for viruses…');
  await expect(page.locator('#ace-msub')).toContainText('birth-certificate.pdf');
  await expect(page.locator('#ace-micon .ace-bigscan i')).toBeVisible();   // sweeping scan line
  await expect(page.locator('#ace-micon .ace-bigscan svg')).toBeVisible(); // shield
  await expect(page.locator('#status-lookup-citizenship')).toContainText('for viruses');
  await done;
  await expect(page.locator('#ace-mtitle')).toHaveText('Scanned clean — uploaded!');
  await expect(page.locator('#status-lookup-citizenship')).toContainText('Scanned clean');
  expect(calls).toHaveLength(1);
});

test('a file the scan blocks shows the server message and is reported as failed', async ({ page }) => {
  await setup(page, (r) => r.fulfill(j({ error: { message: 'This file was blocked because the virus scan found a problem (Eicar-Test). Please do not upload it.' }, scan: 'infected' }, 422)));
  await upload(page);
  await expect(page.locator('#ace-mtitle')).toHaveText('Upload failed');
  await expect(page.locator('#ace-msub')).toContainText('virus scan found a problem');
  await expect(page.locator('#status-lookup-citizenship')).toContainText('blocked');
});

test('if the scanner is unavailable the upload is not accepted and the family is told to retry', async ({ page }) => {
  await setup(page, (r) => r.fulfill(j({ error: { message: 'We could not scan this file for viruses right now, so it was not uploaded. Please try again in a few minutes.' }, scan: 'unavailable' }, 503)));
  await upload(page);
  await expect(page.locator('#ace-msub')).toContainText('not uploaded');
});
