# ACE Portal — Playwright smoke test

End-to-end smoke test that drives the real `index.html` in a headless Chromium browser with **all
network stubbed** (no live Airtable, n8n, or Netlify functions are called). It walks the full
new-student journey and guards the interactions that have bitten us before.

## What it covers
- Register a new applicant → lands on the **New Student Application** create form
- Card copy is create-mode ("New Student Application", "Upload Documents")
- New/Returning defaults to **New**
- **Attendance is a single choice** — clicking AM then PM leaves only PM selected
- Uploading proof-of-citizenship stages the file and the **vision auto-read** fills the ID expiration date
- Submit → **confirmation screen** ("Application Submitted", Student ID, "ACE Staff will review")
- **Add Another Child** → fresh create form with parent info carried over and student fields blank
- **Privacy**: after Sign Out, the next user's dropzone shows no previous filename

## Run it
```bash
cd ace-portal
npm install            # installs @playwright/test (node_modules is git-ignored)
npm run test:install   # one-time Chromium download
npm run test:smoke
```
Requires `python3` on PATH (used to serve the static file on http://127.0.0.1:8848 — a loopback
secure context so the page's `crypto.subtle` password hashing works).

## Notes
- Stubs live in `smoke.spec.js` (`stubNetwork`). To point the test at a different data shape,
  adjust the `route.fulfill` responses there.
- The test intentionally ignores the harmless `tailwind is not defined` console error (Tailwind is a
  CDN script we stub out; styling is not under test).
- This does **not** hit production. To test against the live site, that's a separate (careful) task —
  a real submit creates a real `Status=Pending` record in Airtable that must be cleaned up.
