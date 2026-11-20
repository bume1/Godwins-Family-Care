# A draft payroll reads the paperwork as it is now (2026-11-20)

**Owner report:** "Our employee completed the W-4 via the form system we built, inputted the #s on her W4 and it didn't populate on her account to allow us to run payroll."

## What was wrong

- The W-4 itself saved correctly. Pay Setup (`PUT /api/my/pay-setup/w4`) writes it to `payroll_profiles[userId].w4`, which is what payroll reads.
- **A draft run was a snapshot.** Each worker's `missing` list and figured pay were stored when the draft was built (by hand or by the morning automation). Opening the draft only refreshed the unapproved-timesheet warning. So someone who signed their W-4 after the draft existed still read "Missing: W-4" and "Not figured until the W-4 and their state form are on file", until somebody happened to press Rebuild From Hours.
- Approve already figured the draft afresh, so the screen could also show different numbers from what Approve would pay.

## What changed

- `GET /api/payroll/admin/runs/:id` figures a draft again with `draftFor` (the same call Approve makes), keeping its adjustments, channels and hand-entered taxes, and saves it so the run list agrees. Not saved if the draft changed while it was being figured. If it cannot be figured (no approved tax tables), the stored draft is shown, with the timesheet warning read live as before. Gusto runs and approved runs are untouched.

## Must not undo

- What a draft shows is what Approve pays. Do not go back to showing the stored snapshot.

## Verified

- New test in `test/payroll.test.js`: drafted before the W-4, the W-4 signed, the draft opened shows her figured and unblocked; fails with the old route. Full suite 4006 pass, 0 fail.
