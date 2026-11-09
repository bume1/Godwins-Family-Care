# Hours & Pay cleanup: private availability, two pay schedules, exports moved

**Date:** 2026-11-09 · **Owner-directed** (screenshots of Pay Setup, Staff Hours and Availability)

## What changed

1. **Availability is per account.** `GET /api/scheduling/availability` returns the caller's own rows by default, for every role. The office-wide list is asked for by name (`?scope=all` or `?caregiverId=`) and only the office may ask; anyone else asking still gets their own. The personal Availability card on My GFC asked with no parameters, so an admin, manager or care coordinator saw every caregiver's rows under "Submitted". The scheduling board now asks for `scope=all`.
2. **Two pay schedules.** Caregivers weekly, everyone else every two weeks (`tax.PAY_SCHEDULES`, `settings.schedules`). Each has its own frequency, first Monday and payday. A run carries `schedule` and pays only the people on it (`pp.scheduleFor`: the owner's pin, else caregivers for a caregiver, staff otherwise). Settings saved before this read as the staff schedule, so nothing existing moved. A run saved before has no schedule and is read as staff. Period close drafts each schedule separately and skips one with nobody to pay. `buildRun` divides by the period's own frequency (52 or 26).
3. **Exports live with the money.** The payroll hours CSV is on Payroll → Runs; the client hours CSV is on Billing → Home Care Invoices (Super Admin). Scheduling shows hours and exports none. Its tab is "Time logs".
4. **Pay Setup is pay and tax only.** Offer letter and handbook removed (they are in the welcome packet and clinician onboarding). Rows grouped "Tax forms" / "Getting paid". When `PAYROLL_ENCRYPTION_KEY` is not set, staff are told SSN and bank numbers can be added later, and the SSN and W-9 buttons wait.
5. **The app files 2026 W-2s, not Gusto.** Year End's Gusto note says those wages belong on the app's W-2s and to turn off Gusto's own filing.

6. **Staff shifts by role (owner: "We will assign shifts per role. Outside of caregivers. And RN and LMSW are both").** A shift can name a role (`staff_role`: rn, lmsw, lcsw, coordinator, manager, liaison) and is assigned to one person whose account type is that role. RN, LMSW and LCSW shifts can be a client visit or office time; the office roles never carry a client. **Providers are refused** (`STAFF_ROLE_PROVIDER`): they are on the EHR's clinical calendar. A 1099 contractor is never given one. Staff shifts never appear in a caregiver's open pool, are not bulk-posted, need no caregiver visit log to clock out, and office time has no geofence (`not_applicable`, no flag). Their time log is `kind: 'staff'`, so payroll pays it at the payroll profile rate and it is never a client invoice line. A person runs one clock at a time (the staff clock and a staff shift cannot both be open). Managers and coordinators still request time adjustments after any shift, staff shifts included. Staff see their shifts in My GFC → Hours & Pay (Time clock, My shifts, Offers, My hours). The page is now "Staff Scheduling".
7. **Exports match the app.** The payroll hours export uses the person's own pay schedule for the pay period, staff rows use the payroll profile rate (a salary is not paid by the hour), staff shift rows show the role, and two columns are appended: Pay Schedule and Paid In Payroll Run. A new **run register CSV** (Payroll → a run → Download Register CSV) is built from the run itself; its TOTAL row is the run's own totals. A payroll run no longer pays a clinician's hourly visit time when they were already on the clock (that was the same hour paid twice).

## Must not undo

- The availability list's default is the caller's own rows. Never widen the default; an office view is an explicit ask.
- A run belongs to exactly one schedule; two runs can share a start date.
- A staff shift is never claimable by a caregiver and never a client invoice line; providers are never scheduled here.
- The register CSV reads the run; never recompute its figures.

## Open for the owner

- Set `PAYROLL_ENCRYPTION_KEY` on the server (`openssl rand -hex 32`) and rebuild the container.
- Give each RN, LMSW, LCSW, coordinator, manager and liaison the right account type in User Management, or they will not show up in the "Who works it" list.
