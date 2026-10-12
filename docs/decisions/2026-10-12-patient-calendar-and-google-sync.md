# Patient calendar like the clinical workspace, and the Google clinical calendar

**Date:** 2026-10-12 · **Owner-directed**

## What changed
- **The patient's Appointments screen is the clinicians' Day / Week time grid**
  (7am to 7pm, blocks placed by time, Previous / Today / Next), filled ONLY with
  this patient's own visits: their published clinical visits and their own
  caregiver shifts, in two colours. Week on a desk, Day on a phone. A visit
  outside 7am to 7pm is listed under the grid. "Coming up" stays below.
- **App-booked clinical visits are mirrored to the Google Workspace clinical
  calendar** (`googleCalendar.js`, collection `google_calendar_events`, PHI).
  Book inserts, reschedule moves the same event (keyed on the OLD eid, as the
  reminders are), no-show re-titles it "No-show:", cancel deletes it. The event
  carries the patient's name and, for a home visit, the address (Calendar is in
  the Workspace BAA), never anything clinical.

## Must not undo
- **One way, written when the app changes a visit.** No background job can read
  OpenEMR (Session 5.2), so a visit made or moved directly in OpenEMR does not
  reach Google, and an event added in Google does not reach OpenEMR. Book clinical
  visits in the app (the same rule the visit reminders already need).
- **Best-effort.** A Google failure is logged and never blocks or undoes a visit.
- **Patient self-booking is on hold** (owner, 2026-10-12). Not built.

## Setup (owner, in Google admin)
1. Add `https://www.googleapis.com/auth/calendar.events` to the service account's
   existing domain-wide delegation (keep the Gmail and Drive scopes on the same line).
2. Set `GOOGLE_CLINICAL_CALENDAR_ID` (the calendar's ID from its settings page).
3. Optional: `GOOGLE_CALENDAR_IMPERSONATE` (falls back to `GMAIL_SEND_AS`); that
   user must be able to edit the clinical calendar.
The boot log says whether it is configured; only a real booking proves Google accepts it.

## Coordination
Video visits on Google Meet are being built in another chat, which will also
create calendar events. Both should use ONE event per visit: the Meet work should
patch the event this module made (eid → event id in `google_calendar_events`),
not insert a second one.

## Verified
`test/google_calendar.test.js` (5) with a fake Google client; dropping the cancel
step is caught. Full suite 2084/0; portal render probe 21/21 (schedule check
repointed from the month grid to the day labels). Not proven: a live Google write.
