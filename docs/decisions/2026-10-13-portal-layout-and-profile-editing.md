# Portal layout at every screen size, and patients edit their own profile

**Date:** 2026-10-13 · **Owner-directed** ("this header banner photo doesn't stretch as it
should... the screen size issue is across the board", "allow patients to edit their profile
and contact details, ensure it carries across all areas of the app")

## Layout
- **The banner is one layer that always covers the width and fades out by itself**
  (`.gfc-main.home::before`, `background-size: cover` plus a CSS mask). It used to be a
  fixed-size photo pinned right with a separate gradient, so on wide screens its left edge
  showed as a hard line. Desktop height follows the width (`clamp(320px, 27vw, 520px)`).
- Desktop content is centred (`max-width: 1240px`) instead of stuck to the left.
- Tablets (640 to 1023px) use the room: an 820px column, four tiles in a row, a wider
  bottom menu. Before, a tablet showed the phone layout in a narrow strip.
- Checked in Chromium at 360, 768, 1024, 1440, 1920 and 2560px.

## Greeting
- "Good evening, Ms" came from cutting the name to its first word. A preferred name is now
  used whole; otherwise the first name, skipping a title (`portalProfile.greetingName`).

## Patients edit their own contact details
- `PUT /api/gfc/profile`, client or designated POA. Allowed: preferred name, phone,
  address parts, primary contact; the client (not a POA) may change their sign-in email.
  Name, date of birth, insurance and everything clinical stay with the office
  (`portalProfile.PATIENT_EDITABLE_PATHS`; anything else in the body is ignored).
- **One writer:** it goes through the same `applyEnrollmentEdits` allow-list,
  `validateClientCoreFields` and `commitEnrollmentSubmission` the staff editor uses, so the
  change reaches the enrollment record, the client profile mirror, the face sheet and the
  clinical banner, and a signed consent that now prints differently is flagged for
  re-signature. `enrollment_admin_edit` now expects exactly three callers of the commit
  helper (staff, accepted extraction, patient) and holds the third to the same rules.
- **OpenEMR:** a patient has no OpenEMR sign-in, so the change is marked
  `emrContactPendingSince` and sent (`openemr.updatePatientContact`, which reads the row,
  keeps the identity fields and checks for `validationErrors`) by the next licensed
  clinician or admin who opens the chart. Not proven against live OpenEMR.
- The audit log records which fields changed, never the values.

## Open for the owner
- A changed address does not move the caregiver geofence coordinates. Re-enter them at
  Scheduling → Locations after a patient moves.

## Verified
- `test/patient_profile_edit.test.js` (5); 6 mutations each caught.
- `scripts/verify_patient_profile.js` 23/23 through the real routes.
- Portal render probe: new profile edit check in Chromium; the Home checks were updated for
  the "Read Summary & Note" label that changed on main.
