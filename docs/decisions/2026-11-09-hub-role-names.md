# The Portal Hub shows each person's real role (2026-11-09)

Owner: "make sure roles on the portal hub for employees match their actual roles".

## What was wrong

The hub's role badge and its "Your Account" card worked the role out in the page from lab-era fields (`role`, `isManager`). So:

- Every Provider, RN, LCSW and LMSW / case manager read **Team Member**.
- Every caregiver read **Vendor** in the badge and **External Vendor** on the card.
- A Community Care Liaison read their raw stored role.

## What changed

- `accountTypes.accountTypeLabel(u)` names the role from the ONE account type, using the same labels as the user form. A caregiver carries their licence level ("Caregiver (CNA)"). An account with no type reads "Account type not set", so an admin can see it needs fixing.
- The login response and `GET /api/staff/hub` both return `accountTypeLabel`. The hub shows it and re-reads it on each visit, so a role changed by an admin shows next time without signing in again.
- The page no longer derives a role name itself.
- Left alone on purpose: the legacy Service Portal (Super Admin only) still says "Vendor".

## Verification

- `test/staff_hub.test.js`: 2 new tests (every type's name, the page reading the server's name). One mutation (licence level dropped) confirmed caught.
- Full suite: 3,543, 0 failing. `login.html` compiles.

## Follow-up the same day: User Management (owner screenshot)

- **Portal Access column** showed a lab-era "Client" badge on every row, staff included. It now lists what the person can open, from `accountTypes.accessSummaryFor` (the same landing and hub areas they get): for example "Portal Hub · Clinical" for a clinician, "Caregiver app", "Patient portal". A caregiver with no licence level reads "No access yet".
- **"Clinical role still needs confirming" banner** listed the Super Admin as "provider". That flag is the 2026 clinical-role migration's guess. It now shows only for a clinician account whose account type nobody has chosen (`accountTypes.clinicalRoleNeedsConfirming`). A Super Admin's, manager's or coordinator's access comes from the account type, so the guess decides nothing for them.
- **Role badge** colours follow the account type and the badge no longer wraps.
- 2 more tests in `test/staff_hub.test.js`. Full suite: 3,545, 0 failing. `admin-hub.html` compiles.
