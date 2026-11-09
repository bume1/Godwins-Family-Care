# W-2 staff clock in on the caregiver clock

Owner, 2026-11-08: "all W-2 staff should be clocking in via the site." 1099 staff use other platforms, which will be exported or integrated into the app later. "Use the same clock in clock out wizard we already have on caregiver side. Nothing should be recreated."

## What changed

- **One clock.** A separate staff clock written earlier on this branch was deleted before it was pushed.
  - W-2 staff without shifts use the caregiver schedule component (`public/components/caregiver-schedule.js`) in a new staff mode (`staffOnly: true`). It shows the time clock and My hours, and nothing else.
  - My GFC mounts it under Hours & Pay.
- **The same records.** `POST /api/scheduling/staff-clock/clock-in` and `/clock-out` write `time_logs` rows with no shift and no client (`kind: 'staff'`).
  - So the admin's existing **Time Logs** screen, its corrections with a reason, the adjustment requests and the **payroll export** carry staff hours with no new screen.
  - There is no location check and no visit log, because there is no client.
- **Who:** `employmentType` is W-2 or 1099. It is set on the user form for staff accounts, returned by `GET /api/users`, and carried on `req.user`.
  - **Caregivers keep clocking in on their shifts.**
  - **1099 staff are refused.**
  - The guard is `requireW2Staff`, added to the scheduling route-guard sweep.
- **Playbook F.6 compensation gate:** an out-of-state hire cannot clock in until payroll records the work-state gate (item F.6.02).
- **Payroll and billing:**
  - Payroll includes staff hours. A new **Worker Type** column (Caregiver or W-2 staff) is placed **last**, so an import mapped by column position keeps working.
  - Pay rate resolves to the person's base rate.
  - **Client billing excludes staff hours**, because a staff hour is not a client visit. Before this fix they would have reached the billing export.
- **A real bug found on the way:** `req.user` did not carry `employmentType`, so the clock would have refused every W-2 person. It is now carried and build-guarded.

## Verified

- `test/staff_clock.test.js`, through the real scheduling router:
  - a W-2 clinician and a W-2 coordinator clock in and out
  - a second clock-in is refused
  - a 1099 contractor and a caregiver are refused
  - the F.6 gate holds until payroll records the work state
  - payroll lists the hours as W-2 staff, and billing does not list them
- Three mutations, each caught: the billing exclusion, the W-2 check, and the F.6 gate.
- Full suite passes. Clocked in from My GFC in Chromium.

## Open

- **Set each staff member's employment type** on their account. Until it is set, they see no clock.
- 1099 import or integration is for later.
