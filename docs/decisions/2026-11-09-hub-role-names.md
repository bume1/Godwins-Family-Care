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
