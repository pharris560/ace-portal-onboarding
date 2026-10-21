# Sign-in rollout inventory (2026-10-21)

## Browser -> Airtable call sites (`atFetch(` in index.html): 34
Stage 3 gives each one a per-person check; stage 4 replaces the open proxy with allow-listed endpoints.

| Group | Lines (approx.) | What it does | Who should be allowed |
|---|---|---|---|
| Accounts (register/login/reset) | 1136-1340 | email-exists check, create account, reset password, last-login stamp | public (register/reset), the account owner |
| All Students (parent/student) | 1147, 2889-3407 | parent-email lookup, ID generation, enrollment create/update, record load | the parent whose email matches |
| Staff / Volunteers | 1604-1726, 2335-2336 | coverage roster, sign-up as staff/volunteer | staff / volunteer / admin |
| Coverage | 1865-2451 | read schedule, sign up, cancel, admin schedule edits | staff / volunteer (own rows), admin (all) |
| Admin dashboard | 2508, 2684 | pipeline search, activity feed | admin only |

## Deep links into the portal
- `https://portal.flyace.org/#coverage` (22 mentions in repo docs/workflows exports), plus `#coverage-staff` and `#coverage-volunteer` handled in index.html (~line 3427).
- Bare `https://portal.flyace.org`.
- Live n8n workflows were not re-scanned here; the repo exports only contain the links above. Check the SMS/email templates in n8n before stage 6.
- Rule for stage 6: these links must keep working. A signed-out visitor lands on the sign-in step and continues to coverage after the one-time code.
