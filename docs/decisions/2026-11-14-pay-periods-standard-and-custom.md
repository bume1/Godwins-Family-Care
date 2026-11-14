# Pay periods: standard or custom, and a payday is not a payment

**Date:** 2026-11-14 · **Owner-directed** · Branch `claude/stoic-feynman-ozygr7`

## What changed
- "A date in the pay period" is gone from Runs and Timesheets. Both now offer a **Pay period** list built from the schedule's real periods (Monday to Sunday for caregivers, the two-week cycle for everyone else), two ahead and eight back, plus any custom period a run was drafted for.
- **Custom period…** on Runs: first day, last day, payday, and whether tax is withheld as a weekly or two-week paycheck (inferred from length when left blank). Up to 31 days; payday on or after the last day and within 30 days. Hours already paid in another run are never paid twice (`paidRefs`). Rebuild From Hours keeps a custom run's own dates.
- Custom-period timesheets are their own records (`periodEnd`, `custom: true`, id keyed on start~end) so they never collide with the standard week starting the same day.
- **"paid Nov 13" became "payday Nov 13"** everywhere, followed by where that period's payroll stands: no payroll yet · payroll drafted, not approved · payroll approved, not sent yet · paid · paid in Gusto. Owner read "paid Nov 13" as a payment that had not happened.
- Runs opens on the newest **ended** period that is not approved or paid, which is the one waiting for payroll, rather than the week still running.

## Must not undo
- Approving a timesheet is not a payroll. The timesheet GET returns `run: null` until a payroll exists for that period, and a test asserts the approved hours land in that period's draft with no unapproved warning.
- A Gusto-imported week reads "paid in Gusto", never "no payroll yet".

## Verified
New test in `test/payroll.test.js` (approved hours flow into the draft, period list shape and status, custom validation and listing, Gusto status, page wording). One guard in `test/account_types.test.js` repointed for the extra line in the timesheet-only branch. Full suite 3722 pass, 0 fail. Rendered in Chromium.
