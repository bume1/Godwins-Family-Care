# A patient's account type is locked, and a clashing email offers the next step

Owner, 2026-10-20, trying the POA move on a live patient: changing the account type on a patient's record made their care team and patient sections disappear, and "Add a patient" on a new POA account appeared to do nothing.

- **A patient's account type cannot be changed** (`PUT /api/users/:id` → 409 `PATIENT_TYPE_LOCKED`, checked before anything is written; the Account Type select is disabled on a patient's form). Turning a patient into Family hid their care team, schedule and records and took them off every patient list. A POA using the patient's login is handled with "Move this login to the POA" instead.
- **Creating a user on an email that is already a login now says whose it is** (`existingUser: { id, name, kind }`). The form shows the reason and the next step right above the buttons, not only at the top of a long form:
  - a family login → "Add These Patients to Their Account" (merges the new links into the existing account) or "Open Their Account";
  - a patient's own login → "Move the Login to <POA>", which opens the move dialog with the name, phone and relationship filled in.
- **Not a bug, but worth knowing:** the form's Cancel/Update buttons stay pinned to the bottom, so Client Settings (with the POA tick) sits just below them and needs a scroll.
- Verified: `test/family_links.test.js` 17, `scripts/verify_family_multi_patient.js` 57/57, the lock mutation-checked (removing it fails both), the form driven in Chromium (clash panel, prefilled move dialog, locked type), full suite green.
