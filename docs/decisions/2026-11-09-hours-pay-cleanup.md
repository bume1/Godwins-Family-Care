# Hours & Pay cleanup: private availability, two pay schedules, exports moved

**Date:** 2026-11-09 · **Owner-directed** (screenshots of Pay Setup, Staff Hours and Availability)

## What changed

1. **Availability is per account.** `GET /api/scheduling/availability` returns the caller's own rows by default, for every role. The office-wide list is asked for by name (`?scope=all` or `?caregiverId=`) and only the office may ask; anyone else asking still gets their own. The personal Availability card on My GFC asked with no parameters, so an admin, manager or care coordinator saw every caregiver's rows under "Submitted". The scheduling board now asks for `scope=all`.
2. **Two pay schedules.** Caregivers weekly, everyone else every two weeks (`tax.PAY_SCHEDULES`, `settings.schedules`). Each has its own frequency, first Monday and payday. A run carries `schedule` and pays only the people on it (`pp.scheduleFor`: the owner's pin, else caregivers for a caregiver, staff otherwise). Settings saved before this read as the staff schedule, so nothing existing moved. A run saved before has no schedule and is read as staff. Period close drafts each schedule separately and skips one with nobody to pay. `buildRun` divides by the period's own frequency (52 or 26).
3. **Exports live with the money.** The payroll hours CSV is on Payroll → Runs; the client hours CSV is on Billing → Home Care Invoices (Super Admin). Scheduling shows hours and exports none. Its tab is "Time logs".
4. **Pay Setup is pay and tax only.** Offer letter and handbook removed (they are in the welcome packet and clinician onboarding). Rows grouped "Tax forms" / "Getting paid". When `PAYROLL_ENCRYPTION_KEY` is not set, staff are told SSN and bank numbers can be added later, and the SSN and W-9 buttons wait.
5. **The app files 2026 W-2s, not Gusto.** Year End's Gusto note says those wages belong on the app's W-2s and to turn off Gusto's own filing.

## Must not undo

- The availability list's default is the caller's own rows. Never widen the default; an office view is an explicit ask.
- A run belongs to exactly one schedule; two runs can share a start date.

## Open for the owner

- Set `PAYROLL_ENCRYPTION_KEY` on the server (`openssl rand -hex 32`) and rebuild the container.
- Staff scheduling for all non-provider staff (not built in this change).
