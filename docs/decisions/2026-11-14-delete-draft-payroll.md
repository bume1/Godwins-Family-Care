# Deleting a draft payroll

**Date:** 2026-11-14 · **Owner-directed** ("drafts should be deletable … of payroll") · Branch `claude/stoic-feynman-ozygr7`

## What changed
- A draft run has a **Delete Draft** button (Super Admin only) with a confirm that says what is lost: lines added and taxes entered by hand. `DELETE /api/payroll/admin/runs/:id`.
- A draft has paid nothing, locked no hours and sent no stubs, so it is removed outright. The activity log records who deleted which period.
- **An approved run is never deleted** (409 `RUN_LOCKED`). A mistake there is corrected on the next run, as before.
- The morning automation drafts the last ended period every day, so a deleted draft would come straight back. `payroll_deleted_drafts` records the deleted period and the automation skips it. Drafting that period by hand clears the record and brings it back for the automation too.

## Must not undo
- A deleted draft is removed from `payroll_runs`, never kept with another status: several readers treat any non-draft run as paid (`paidRefsFrom`), so a kept "deleted" run would mark its hours paid.

## Verified
Test in `test/payroll.test.js`: only the Super Admin deletes, the run is gone, the automation skips the period, drafting by hand brings it back, an approved run is refused. Removing the automation skip fails the test. Full suite 3737 pass, 0 fail.
