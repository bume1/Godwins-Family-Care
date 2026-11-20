# Submitted availability names who sent it, and when (2026-11-20)

Owner report: a submitted availability showed no caregiver name (Tasha Green's)
and little else.

- `GET /api/scheduling/availability` now reads the person's name and licence
  level from the current roster, falling back to the name stored on the row,
  then the email. An older row with no stored name no longer reads blank.
- The office list (Staff Scheduling, Availability tab) shows the name, licence,
  start date, hours, submitted time, who reviewed it and when, the note, and the
  days off. The note was stored and never shown.
- The personal list (My GFC, clinical workspace, caregiver app) shows the same,
  with the person's name at the top of each row.
- Test: `test/availability_list_details.test.js` (route driven; dropping the
  roster lookup fails it).
