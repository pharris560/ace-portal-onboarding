// Smoke test for the Saturday Coverage Schedule (email lookup -> view/sign up/cancel).
const { test, expect } = require('@playwright/test');

const AT_TABLE_STAFF = 'tblylF50qyHNtKHLH';
const AT_TABLE_VOLUNTEERS = 'tbltf83MZS1TEE6Kt';
const AT_TABLE_COVERAGE = 'tbl3DGD8ruJjlblf9';

function nextSaturdayISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const days = (6 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function stubNetwork(page, { staffRecord = null, volunteerRecord = null, signups: initialSignups = [] } = {}) {
  const jsonBody = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  let signups = initialSignups.slice(); // in-memory Coverage Signups, mutated by POST/DELETE
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

  // The portal fires a fire-and-forget call to n8n after creating a signup. Intercept it so tests
  // never touch production, and record the payloads so a test can assert on them.
  page.__signupNotifications = [];
  await page.route('**/webhook/coverage-signup-confirm', async (route) => {
    let body = null;
    try { body = route.request().postDataJSON(); } catch (_) {}
    page.__signupNotifications.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"send":false}' });
  });

  await page.route(/cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
}

test('coverage lookup: unknown email shows an error, no schedule access', async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/index.html');

  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
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

  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
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

test('coverage schedule: choosing Volunteer looks the person up in the Volunteers table', async ({ page }) => {
  await stubNetwork(page, {
    volunteerRecord: { id: 'recVOL1', fields: { 'Full Name': 'Sam Lee', Email: 'sam@example.com', Status: 'Active' } },
  });
  await page.goto('/index.html');

  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm a Volunteer" }).click();
  await page.fill('#coverage-lookup-email', 'sam@example.com');
  await page.click('#coverage-lookup-btn');

  await expect(page.locator('#view-coverage')).toBeVisible();
  await expect(page.locator('#coverage-user-name')).toHaveText('Sam Lee');
});

test('capacity: a class slot with 3 instructors already shows Full and blocks a 4th', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });

  const date = nextSaturdayISO();
  const preSignups = [1, 2, 3].map((i) => ({
    id: 'recEXIST' + i,
    fields: { 'Saturday Date': date, Slot: 'Falcons AM', 'Person Type': 'Staff', 'Signed Up By Name': 'Existing Instructor ' + i, Staff: ['recOTHER' + i] },
  }));

  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFF1', fields: { 'Full Name': 'Taylor Morgan', Email: 'taylor@example.com', Status: 'Active' } },
    signups: preSignups,
  });
  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'taylor@example.com');
  await page.click('#coverage-lookup-btn');
  await expect(page.locator('#view-coverage')).toBeVisible();

  const firstCard = page.locator('#coverage-schedule > div').first();
  await expect(firstCard).toContainText('Falcons AM');
  await expect(firstCard).toContainText('Full');
  await expect(firstCard).toContainText('Existing Instructor 1');
  await expect(firstCard).toContainText('Existing Instructor 3');

  expect(errors, 'no uncaught page errors').toEqual([]);
});

test('capacity: a class slot with 2 instructors + 1 volunteer still allows a 3rd instructor, volunteers stay uncapped', async ({ page }) => {
  const date = nextSaturdayISO();
  const preSignups = [
    { id: 'recEXIST1', fields: { 'Saturday Date': date, Slot: 'Hawks PM', 'Person Type': 'Staff', 'Signed Up By Name': 'Instructor One', Staff: ['recOTHER1'] } },
    { id: 'recEXIST2', fields: { 'Saturday Date': date, Slot: 'Hawks PM', 'Person Type': 'Staff', 'Signed Up By Name': 'Instructor Two', Staff: ['recOTHER2'] } },
    { id: 'recEXIST3', fields: { 'Saturday Date': date, Slot: 'Hawks PM', 'Person Type': 'Volunteer', 'Signed Up By Name': 'Vol Person', Volunteer: ['recVOLOTHER'] } },
  ];

  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFF2', fields: { 'Full Name': 'Jordan Ray', Email: 'jordan@example.com', Status: 'Active' } },
    signups: preSignups,
  });
  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'jordan@example.com');
  await page.click('#coverage-lookup-btn');
  await expect(page.locator('#view-coverage')).toBeVisible();

  const firstCard = page.locator('#coverage-schedule > div').first();
  await expect(firstCard).toContainText('+1 vol');
  await expect(firstCard).not.toContainText('Full');

  const hawksRow = firstCard.locator('div.py-3', { hasText: 'Hawks PM' });
  await hawksRow.locator('button', { hasText: 'Sign Up' }).click();
  await expect(firstCard.getByText('Jordan Ray (You)')).toBeVisible({ timeout: 10000 });
  await expect(hawksRow).toContainText('Cancel');
  await expect(hawksRow).not.toContainText('Sign Up');
});

test('by-person view: groups signups by name, shows dates+slots, allows canceling own', async ({ page }) => {
  const date = nextSaturdayISO();
  const preSignups = [
    { id: 'recA', fields: { 'Saturday Date': date, Slot: 'Sparrows AM', 'Person Type': 'Staff', 'Signed Up By Name': 'Alex Instructor', Staff: ['recSTAFF3'] } },
  ];

  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFF3', fields: { 'Full Name': 'Alex Instructor', Email: 'alex@example.com', Status: 'Active' } },
    signups: preSignups,
  });
  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'alex@example.com');
  await page.click('#coverage-lookup-btn');
  await expect(page.locator('#view-coverage')).toBeVisible();

  await page.click('#coverage-tab-person');
  await expect(page.locator('#coverage-by-person-panel')).toBeVisible();
  await expect(page.locator('#coverage-by-date-panel')).toBeHidden();
  await expect(page.locator('#coverage-by-person')).toContainText('Alex Instructor (You)');
  await expect(page.locator('#coverage-by-person')).toContainText('Sparrows AM');

  await page.locator('#coverage-by-person button', { hasText: 'Cancel' }).click();
  await expect(page.locator('#coverage-by-person')).toContainText('No one has signed up', { timeout: 10000 });
});

test('by-class view: one card per slot, each listing the next 6 Saturdays, sign up works from here too', async ({ page }) => {
  const date = nextSaturdayISO();
  const preSignups = [
    { id: 'recA', fields: { 'Saturday Date': date, Slot: 'Eagles AM', 'Person Type': 'Staff', 'Signed Up By Name': 'Instructor One', Staff: ['recOTHER1'] } },
  ];

  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFF4', fields: { 'Full Name': 'Robin Casey', Email: 'robin@example.com', Status: 'Active' } },
    signups: preSignups,
  });
  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'robin@example.com');
  await page.click('#coverage-lookup-btn');
  await expect(page.locator('#view-coverage')).toBeVisible();

  await page.click('#coverage-tab-class');
  await expect(page.locator('#coverage-by-class-panel')).toBeVisible();
  await expect(page.locator('#coverage-by-date-panel')).toBeHidden();

  // One slot card per COVERAGE_SLOTS entry -- read the live constant rather than hardcoding a
  // count, so adding or removing a slot doesn't require editing this test.
  const slotCount = await page.evaluate(() => COVERAGE_SLOTS.length);
  expect(slotCount).toBeGreaterThanOrEqual(7);
  await expect(page.locator('#coverage-by-class > div')).toHaveCount(slotCount);

  const eaglesCard = page.locator('#coverage-by-class > div', { hasText: 'Eagles AM' }).first();
  await expect(eaglesCard).toContainText('Instructor One');
  await expect(eaglesCard).toContainText('Needs an instructor on');

  // Sign up from the By Class view on a still-open Saturday row.
  await eaglesCard.locator('button', { hasText: 'Sign Up' }).first().click();
  await expect(eaglesCard.getByText('Robin Casey (You)')).toBeVisible({ timeout: 10000 });

  // General slot (ACE Staff) should say it has no cap, not a Saturdays-needing-coverage count.
  const staffCard = page.locator('#coverage-by-class > div', { hasText: 'ACE Staff' }).first();
  await expect(staffCard).toContainText('no instructor cap');
});

/* ===== Role selection on #coverage (2026-09-05) =====
   The lookup used to search Staff then fall through to Volunteers, so the role was inferred.
   It is now chosen explicitly and exactly one table is searched. These cover that behaviour
   and the escape hatch when someone picks the wrong side. */

test('role selection: picking Staff when only a volunteer record exists errors, and the switch link recovers', async ({ page }) => {
  const queried = [];
  await stubNetwork(page, {
    volunteerRecord: { id: 'recVOL9', fields: { 'Full Name': 'Casey Vol', Email: 'casey@example.com', Status: 'Active' } },
  });
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes(AT_TABLE_STAFF)) queried.push('Staff');
    if (u.includes(AT_TABLE_VOLUNTEERS)) queried.push('Volunteer');
  });

  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'casey@example.com');
  await page.click('#coverage-lookup-btn');

  // Wrong side: error shown, no access, and the Volunteers table was never consulted.
  await expect(page.locator('#coverage-lookup-error')).toBeVisible();
  await expect(page.locator('#coverage-lookup-error')).toContainText('No active staff record');
  await expect(page.locator('#view-coverage')).toBeHidden();
  expect(queried).toEqual(['Staff']);

  // The inline switch link re-runs the lookup against the other table.
  await page.locator('#coverage-lookup-error button', { hasText: 'Try as a volunteer' }).click();
  await page.fill('#coverage-lookup-email', 'casey@example.com');
  await page.click('#coverage-lookup-btn');

  await expect(page.locator('#view-coverage')).toBeVisible();
  await expect(page.locator('#coverage-user-name')).toHaveText('Casey Vol');
  expect(queried).toEqual(['Staff', 'Volunteer']);
});

test('role selection: #coverage lands on the chooser, #coverage-volunteer skips straight to the email box', async ({ page }) => {
  await stubNetwork(page, {
    volunteerRecord: { id: 'recVOL8', fields: { 'Full Name': 'Deep Link', Email: 'deep@example.com', Status: 'Active' } },
  });

  await page.goto('/index.html#coverage');
  await expect(page.locator('#view-coverage-role')).toBeVisible();
  await expect(page.locator('#view-coverage-lookup')).toBeHidden();

  // The role-specific hash keeps the texted one-tap flow: no chooser, role already set.
  await page.goto('/index.html#coverage-volunteer');
  await expect(page.locator('#view-coverage-role')).toBeHidden();
  await expect(page.locator('#view-coverage-lookup')).toBeVisible();
  await expect(page.locator('#coverage-role-label')).toHaveText('a volunteer');

  await page.fill('#coverage-lookup-email', 'deep@example.com');
  await page.click('#coverage-lookup-btn');
  await expect(page.locator('#coverage-user-name')).toHaveText('Deep Link');
});

/* Staff timeslots (2026-09-05). Staff who aren't instructing pick a time of day instead of a
   class. Names must stay digit-free -- the CLAIM parser strips letters and reads the leftover
   digits as the date, so a slot named "9am-12pm" would book Sept 12 instead of the real date. */
test('staff timeslots: three digit-free slots exist, with their hours shown in the UI', async ({ page }) => {
  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFFT', fields: { 'Full Name': 'Timeslot Tester', Email: 'ts@example.com', Status: 'Active' } },
  });
  await page.goto('/index.html');

  const { staffSlots, hours, allSlots } = await page.evaluate(() => ({
    staffSlots: STAFF_SLOTS, hours: STAFF_SLOT_HOURS, allSlots: COVERAGE_SLOTS,
  }));

  expect(staffSlots).toEqual(['ACE Staff All Day', 'ACE Staff AM', 'ACE Staff PM']);
  // No digits anywhere in a slot name, or the CLAIM date parser misreads them.
  for (const s of allSlots) expect(s, `slot "${s}" must not contain digits`).not.toMatch(/\d/);
  // Longest first, so "ACE Staff All Day" can't be shadowed by a substring match on "ACE Staff AM".
  expect(staffSlots[0]).toBe('ACE Staff All Day');
  expect(hours['ACE Staff AM']).toBe('9am-12pm');
  expect(hours['ACE Staff PM']).toBe('12pm-3pm');

  // The hours render next to the slot name in the By Class view.
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'ts@example.com');
  await page.click('#coverage-lookup-btn');
  await page.locator('#coverage-tab-class').click();

  const amCard = page.locator('#coverage-by-class > div', { hasText: 'ACE Staff AM' }).first();
  await expect(amCard).toContainText('9am-12pm');
});

test('staff timeslots: class slots stay capped, staff slots do not', async ({ page }) => {
  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFFC', fields: { 'Full Name': 'Cap Tester', Email: 'cap@example.com', Status: 'Active' } },
  });
  await page.goto('/index.html');
  const { classSlots, staffSlots } = await page.evaluate(() => ({ classSlots: CLASS_SLOTS, staffSlots: STAFF_SLOTS }));
  // The cap is an instructor-coverage limit on classes only; the general staff slots are uncapped.
  for (const s of staffSlots) expect(classSlots).not.toContain(s);
  expect(classSlots).toHaveLength(6);
});

/* "View My Schedule" card (2026-09-06). Replaced the small text link that used to sit under the
   Join Our Team row -- staff kept clicking the neon-green admin card instead of the link. */
test('home page: View My Schedule is a card in Join Our Team, and the old text link is gone', async ({ page }) => {
  await stubNetwork(page, {});
  await page.goto('/index.html');

  const card = page.locator('#view-home button', { hasText: 'View My Schedule' });
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(card).toContainText('No password needed');

  // It sits inside the card grid, not as a link below it.
  const grid = page.locator('#view-home .grid').filter({ hasText: 'View My Schedule' });
  await expect(grid).toHaveCount(1);
  await expect(grid.locator('> button:visible')).toHaveCount(4);

  // The old link text must not survive anywhere on the page.
  await expect(page.locator('text=Already on the team? View / Sign Up for Saturday Schedule')).toHaveCount(0);

  // Neon green, matching the admin card's treatment.
  await expect(card.locator('h3')).toHaveClass(/neon-text-green/);

  await card.click();
  await expect(page.locator('#view-coverage-role')).toBeVisible();
});

/* Instant signup confirmation (2026-09-06). Signing up in the portal used to send nothing until
   the Friday before; claiming by text got an immediate reply. The portal now pings n8n, which
   owns the dedup and Active/phone checks. The call is fire-and-forget: it must never block the
   UI or turn a successful sign-up into a visible error. */
test('signup confirmation: the portal notifies n8n with the new record id', async ({ page }) => {
  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFFN', fields: { 'Full Name': 'Notify Tester', Email: 'n@example.com', Status: 'Active' } },
  });
  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'n@example.com');
  await page.click('#coverage-lookup-btn');

  const firstCard = page.locator('#coverage-schedule > div').first();
  await firstCard.locator('button', { hasText: 'Sign Up' }).first().click();
  await expect(firstCard.getByText('Notify Tester (You)')).toBeVisible({ timeout: 10000 });

  await expect.poll(() => page.__signupNotifications.length).toBeGreaterThan(0);
  // It must send the id Airtable returned for the row it just created -- nothing else.
  expect(page.__signupNotifications[0]).toEqual({ signupId: 'recSIGNUP1' });
});

test('signup confirmation: a failing notify call does not break the sign-up', async ({ page }) => {
  await stubNetwork(page, {
    staffRecord: { id: 'recSTAFFF', fields: { 'Full Name': 'Resilient Tester', Email: 'r@example.com', Status: 'Active' } },
  });
  // Override the notify route with a hard failure.
  await page.route('**/webhook/coverage-signup-confirm', (route) => route.abort('failed'));
  const errors = [];
  page.on('pageerror', (e) => { if (!/tailwind is not defined/.test(String(e))) errors.push(String(e)); });

  await page.goto('/index.html');
  await page.locator('#view-home button', { hasText: 'View My Schedule' }).click();
  await page.locator('#view-coverage-role button', { hasText: "I'm on Staff" }).click();
  await page.fill('#coverage-lookup-email', 'r@example.com');
  await page.click('#coverage-lookup-btn');

  const firstCard = page.locator('#coverage-schedule > div').first();
  await firstCard.locator('button', { hasText: 'Sign Up' }).first().click();

  // The signup still lands and the confirmation still shows.
  await expect(firstCard.getByText('Resilient Tester (You)')).toBeVisible({ timeout: 10000 });
  expect(errors, 'a failed notify must not surface as a page error').toEqual([]);
});
