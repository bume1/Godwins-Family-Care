# Clinician availability

Owner, 2026-11-08: clinicians need a way to send availability, built in the scheduling area. A visit booked outside it is **warned, not blocked** (owner chose "warn").

## What changed

- **Same form, same records.** Clinicians use the caregiver availability form: the shared schedule component, mounted with `onlyTabs: ['availability']`.
  - It sits in a **My Availability** card in the clinical workspace's Schedule view.
  - Submissions go to `caregiver_availability`, with the same lead-time rules, append-only. The newest submission is the one in force.
  - In the clinician view the form says booked visits don't change, not the caregiver's shift wording.
- **One rule:** `schedulingRepository.availabilityVerdict(rows, personId, start, end)` returns NONE, INSIDE or OUTSIDE. It reads the newest submission and uses the existing `availabilityCoversShift`, in Eastern time.
- **Booking and rescheduling** a clinical visit (`clinicianAvailabilityCheck` in `server.js`) find the clinician by `openEmrProviderId` and check the visit against their availability before the slot-conflict check.
  - **Outside**, with no reason: 409 `APPOINTMENT_OUTSIDE_AVAILABILITY`. The form shows the warning, a reason box and "Book Anyway".
  - **With a reason**, the visit books. The reason goes to the activity log and comes back as a warning.
  - **No availability on file** is a warning only.
- **Why warn and not block:** home visits move. A hard block would push bookings straight into OpenEMR, where the day-before reminders never fire.

## Verified

- `test/clinician_availability.test.js`: the verdict covers the newest submission, a window overrun, a blackout date and none on file. The booking and reschedule wiring and the page wiring are covered.
- The "newest wins" rule was broken on purpose and the tests caught it.
- Full suite passes.
- The form rendered in availability-only mode in Chromium.

## Not proven here

- A live booking against OpenEMR. The check runs before the OpenEMR write and needs the clinician's `openEmrProviderId` set on their account.
