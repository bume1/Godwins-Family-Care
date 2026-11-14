# Correcting how past Gusto payments were actually sent

**Date:** 2026-11-14 · **Owner-directed** ("some of the previous gusto payments were marked check but also sent via p2p as a work around … clear between zelle and cash app") · Branch `claude/stoic-feynman-ozygr7`

## What changed
- On a Gusto-imported run, the Super Admin has **Correct How It Was Paid** beside each person. It records how the pay date was actually sent (Zelle, Cash App, direct deposit or paper check), with an optional receipt number, the date sent and a required reason. The same correction can be ticked onto that person's other Gusto paydays.
- The person's stub for each corrected payday is filed again in the Finance folder. Nobody is emailed. The payment line states the correction openly: "Payment: Zelle (P2P) · Receipt … · sent …. Payroll run in Gusto, which recorded it as a paper check; corrected by the office on …". Zelle and Cash App print distinctly.
- The register CSV shows the corrected method and receipt, plus "Recorded In Gusto As" and "Payment Correction" (the reason, who and when).
- Corrections live in `payroll_payment_corrections` (append-only, registered in `dataMigration.js`). The latest one for a run and person is in force, and each row names the one it replaces. Re-importing the Gusto file never wipes them. Every correction goes to the activity log.

## Must not undo
- **Gusto history only** (409 `PAYMENT_CORRECTION_GUSTO_ONLY` on an app run). In the app, the method and receipt are recorded when the payment is marked paid, so there is nothing to correct.
- Amounts, hours and taxes never change through this, only the payment line, and the stub always says it was corrected.

## Not used for this
- **Redo Pay Stubs** only refiles app runs with what they already recorded. It cannot change a method and does not apply to Gusto runs.

## Verified
New test in `test/paystub_delivery.test.js`:
- two paydays corrected to Zelle, then one to Cash App;
- the stub text read back, with the amount unchanged and no email sent;
- the history appended;
- the register columns;
- the correction survives a re-import;
- an app run, a missing reason and a bad method are refused.

Both guardrails are mutation-checked. The form was rendered in Chromium. Full suite 3746 pass, 0 fail.
