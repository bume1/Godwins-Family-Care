# Taxes entered by hand, and a timesheet banner that reads live

Owner-directed, 2026-11-14.

## Taxes entered by hand

- On a draft payroll, the Super Admin can **Enter Taxes** for one person: federal, Social Security, Medicare and state withholding, with a required reason. They replace the figured amounts for that paycheck. The form opens prefilled with the figured amounts, or with Social Security at 6.2% and Medicare at 1.45% of gross when nothing could be figured. **Go Back to Figured Taxes** removes it.
- **Employer taxes are still figured** by the app (Social Security, Medicare, FUTA, state unemployment). Taxes higher than the pay are refused.
- **For that person, a missing W-4, G-4 or state certificate no longer holds pay**: the hand entry stands in for them. Their other missing paperwork (SSN, I-9) is listed as **still owed, not holding pay**, since hours worked are paid on payday. How they are paid and a pay rate are still required (P2P covers the first).
- The entry is kept on the run (`manualTaxes`) and the worker (`manualTaxes: { reason, by, at }`), logged, carried through every rebuild, and fixed once the run is approved.

## Timesheet banner

- A draft's "Timesheets not approved" banner is now read **when the run is opened**, not when it was built, so a timesheet approved since then drops off. It names each person's office status (waiting, sent back, changed since approved) and says the employee's own confirmation is optional and never holds payroll.
- **Fixed on the way:** adding a line (bonus, correction, reimbursement) rebuilt the draft without its P2P choice, quietly putting everyone back on direct deposit. Every rebuild now keeps the run's choices.
