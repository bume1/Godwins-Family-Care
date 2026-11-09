# Past pay from Gusto becomes pay stubs and year-to-date

**Date:** 2026-11-09 · **Owner-directed:** "here is our ytd payroll summary … for those with accounts listed, def use to generate previous paystubs."

## What was built
- `payrollGustoImport.js` (pure) reads Gusto's **Payroll Journal** CSV. It reads only the per-pay-date sections; the summary at the top is a total and is never imported.
  - Each section ends at its totals row or at a blank line.
  - Lines are netted per person, pay date and period, so Gusto's reversal-plus-replacement corrections cancel out.
  - People are matched to app accounts by name, and only an unambiguous match counts.
- `POST /api/payroll/admin/import/gusto` (admin) has two modes:
  - **preview** writes nothing.
  - **commit** writes one `status: 'paid'`, `source: 'gusto'` run per pay date and period.
- Each imported run has stubs in `staff_paystubs` (source `gusto`), written through the same `writeStubs` with `notify: false`, so nobody gets an email per past pay date.
- Imported runs are run IDs like any other, so `ytdFrom`, `cal.yearEnd` and the quarter figures all include them. The run engine's YTD caps are right from the first app run.
- Payroll → Runs → **Import Past Pay From Gusto** has preview and import. Imported runs carry a GUSTO chip.

## Must not undo
- **The file is never stored or committed.** It holds real names, addresses and wages, and the repo is public. The test fixture is synthetic.
- **Gusto's deposits are Gusto's.** `cal.calendar` skips `source: 'gusto'` runs, so the app never says those taxes are owed.
- **Never paid twice.**
  - The app's time logs and visits inside an imported period go into the run's `refs` and are locked (`payroll_run_id`).
  - A pay date an app run already paid is left out of the import and named.
  - Re-importing replaces by run id (`gusto:<payDate>:<start>:<end>`) and never doubles.
- **Non-Georgia workers are blocked, not mis-taxed.** The import records Gusto's work state on the payroll profile, and `buildRun` blocks anyone whose `workState` is not `GA` by name. The real file had one Texas employee.
- **Georgia unemployment is 2.64% plus a 0.06% administrative assessment in Gusto.** The import keeps both (`employer.gaSuta` is the combined total; `employer.gaAdmin` is the assessment).

## Verified
- 10 tests and 15 mutations, all caught. Four survived the first pass, and tests were added for:
  - ambiguous names
  - Additional Medicare
  - the summary section
  - a section running straight into the next label
- The real export was checked in memory only, never written. It read 12 employee lines, and per-person totals matched Gusto's own summary to the cent.
- Full suite: 0 failing.

## Open for the owner
- **Who files the 2026 W-2s, Gusto or the app?** The app's Year End figures now include Gusto-paid wages. If Gusto is also filing 2026 W-2s, releasing in the app would report those wages twice. The Year End page warns about this.
- **Two pay schedules.** Gusto runs caregivers weekly and everyone else biweekly. The app has one pay frequency.
- **Texas.** The Texas employee is paid outside the app until Texas unemployment (and a no-income-tax state) is added.
