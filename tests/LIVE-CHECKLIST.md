# ACE Onboarding — live pre-flight checklist

**Who does what**
- **Claude (automated):** runs the Playwright smoke test (`npm run test:smoke`) + jsdom checks on the
  front-end before saying a portal change works. These stub Airtable/n8n — they prove UI/logic, not live integrations.
- **You (final live check):** the steps below — anything that writes real data, sends real email, or moves money.

Run this after a portal deploy (Netlify auto-deploys on push to `main`). **Hard-refresh Safari (⌘⇧R) first** —
the portal is a cached single-page app.

---

## A. Portal front-end (portal.flyace.org)

### New student
- [ ] Land on home → logo centered, cards readable, heading says "Onboarding Portal".
- [ ] "New ACE Student" → Sign Up → create account.
- [ ] Form shows **"New Student Application"** and **"Upload Documents"**; New/Returning = **New**; no confirm checkboxes.
- [ ] Attendance: click **AM then PM** → only one stays selected (never both).
- [ ] Upload proof of citizenship → big modal, then the **ID Expiration Date auto-fills** below the upload card → confirm it.
- [ ] Upload a **second** document (medical) right after → it works (no stuck spinner / blocked click).
- [ ] Try to submit with proof missing → blocked with a clear message.
- [ ] Submit → **confirmation screen** ("Application Submitted", Student ID, "ACE Staff will review").
- [ ] Wait ~12s → **auto sign-out** (or click Sign Out).

### Returning student
- [ ] Log in as an existing parent → record **pre-populates** (student + parents + home address).
- [ ] Grade + New/Returning confirm checkboxes appear and block submit until checked.
- [ ] Save → confirmation.

### Add another child
- [ ] From the record view **or** the confirmation screen → "Add Another Child".
- [ ] New blank student form, **parent/home info carried over**, student fields empty.
- [ ] Submit → a **separate** record is created; the first child's record is unchanged.

### Privacy (shared-device)
- [ ] Upload a doc, sign out, start a new application → dropzone shows **"Drop file or click to browse"**
      (no previous filename), all fields blank.

---

## B. Airtable — confirm the write (use the read-only helper)

After a live submit, from `ace-portal/`:
```bash
node tests/verify-record.mjs --email <the parent email you used> --new
# or, if you have the record id:
node tests/verify-record.mjs --id recXXXXXXXXXXXXXX --new
```
- [ ] Helper finds the record and all fresh-submit checks pass (Status=**Pending**, New/Returning=**New**,
      exactly **one** attendance session, **≥1** proof-of-citizenship file).
- [ ] Fields match what you entered (name, grade, parents, home address).
- [ ] **Clean up test data:** delete the throwaway `Status=Pending` record (and its Portal Account) in Airtable.

Base `appFVg5UNlwzJMuaY`, table **All Students** `tbluHnJc9VM6l4U6V`. The helper is read-only (GET only).

---

## C. n8n (n8n.flyace.org) — only when relevant to the change

- [ ] **validate-id vision** (`yQ0uDPEhBJa1ZRZG`): a real ID upload returns an expiration date on the card
      (Executions tab shows a run; portal origin allowed).
- [ ] **Error notifier** (`8VB0zw8l5YI7dN1f`, active): a deliberate failure emails pamela.harris@flyace.org.
- [ ] **ID-expiration reminders** (`hTilG4rJWdmVSl4h`): still **INACTIVE**. Do **not** activate without scoping the
      filter to one test record first — it emails every active student with a missing/expiring ID (~23 families).
- [ ] The 6 **billing** workflows are **FROZEN** — do not touch. Onboarding work never modifies them.

---

## D. Zeffy → billing (frozen system — monitor only)

Only relevant if testing payments; the billing automation is live and unchanged.
- [ ] Registration/tuition payment in Zeffy → **Zeffy watcher** (`ca5xZkr2b5T6NFvB`) matches the parent and
      marks the invoice paid (check its Executions).
- [ ] No duplicate invoices; staff alert only fires on an unmatched real campaign payment.

---

### Notes
- A real submit writes real data and can trigger downstream automation on `Status=Active` — for onboarding tests
  keep records at **Pending** and delete them after.
- If a submit 422s, it's almost always an invalid single-select value (Shirt Size / Grade / Status / New-Returning) —
  the authoritative option lists are in the project memory; the helper flags invalid Status / New-Returning for you.
