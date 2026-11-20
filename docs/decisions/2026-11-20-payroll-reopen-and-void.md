# Payroll: reopen an approved run, and void a run

Date: 2026-11-20. Owner-directed after the Nov 9–15 caregivers run was approved with taxes entered by hand ($0 federal and GA) before anyone was paid.

## What changed
- **Reopen Payroll** (`POST /api/payroll/admin/runs/:id/reopen`, Super Admin). An approved run goes back to a draft when **no payment is marked yet**. A reason is required and kept in `reopenHistory`. The hours approval locked are unlocked, the payments and liabilities are cleared, and the run is approved again the normal way. Refused for a paid run, for one with any payment marked, and for a Gusto import.
- **Void Payroll** (`POST /api/payroll/admin/runs/:id/void`, Super Admin). Works on an approved **or paid** run. A reason is required. The run is **kept** with status `void`, `voidedAt`, `voidedBy`, `voidReason` and `statusBeforeVoid`, and it is listed as VOID with its note. Drafts are deleted, not voided. Gusto imports are refused.

## What a voided run stops doing (must not undo)
A voided run is treated as never paid everywhere a paid run counts:
- year to date (`ytdFrom`)
- paid hours (`paidRefsFrom`, so its hours can be paid on a new run for the period)
- quarterly and year-end totals (`payrollCalendar`)
- QuickBooks tax splits
- the morning automation's "already approved" check
- the payment sheet and payment marking (`RUN_VOIDED`)
- stub regeneration

Its pay stub rows are stamped `voidedAt` and read "Voided" in My GFC. Any new code that reads `payroll_runs` as "paid" must exclude `void` too.

## Not done by the app
- Voiding does not recover money already sent. That is the Super Admin's to handle and record.
- QuickBooks posts a run's journal once. If it was posted, both actions say so, and the entry is corrected in QuickBooks by hand.

## Verified
- Two new tests in `test/payroll.test.js`: reopen, then clear the hand-entered taxes, and re-approval figures them from the W-4; void a paid run, it drops out of YTD, and the period can be drafted and paid again.
- One guard in `paystub_delivery.test.js` was repointed.
- Full suite passes. Both edited pages compile.
