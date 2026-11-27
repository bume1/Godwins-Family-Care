# Run payroll in full: a per-person switch (owner, 2026-11-27)

**Ask.** In User Management → Modules, let a Super Admin give someone the
ability to run payroll as if they were a Super Admin, not just prepare it, and
turn that on and off per person. For a future financial manager.

**What shipped.**
- A **Run payroll in full** switch under the Payroll row of the Modules grid.
  It only shows when Payroll is ticked. Unticking Payroll turns it off too.
- Stored as `moduleAccess.payrollFull: true`. `moduleAccessOf` keeps it only as
  a literal `true` and only with a Payroll grant, so a stray value never widens
  anyone. Off, nothing new is stored and the record shape is unchanged.
- `accountTypes.hasFullPayroll(u)` is the one answer: the Super Admin, or an
  active team member with Payroll granted and the switch on.
- **Server-enforced.** Every `routes/payroll.js` route that was `requireAdmin`
  is now `requirePayrollRunner` (approve, reopen, void, pay, bank-number reveal,
  settings, tax tables, people's pay setup, Gusto import, year-end release and
  forms, paying a contractor). The four QuickBooks routes too. The screen's
  `superAdmin` flag reads the same answer, so the page and the routes agree.
- Only the Super Admin sets it: the grid routes stay `requireAdmin`, and
  `moduleAccess` is already an access field the user form refuses from anyone
  else. Turning it on or off writes `payroll_full_access_granted` /
  `payroll_full_access_revoked` to the activity log.
- Payroll reminder emails (year-end, etc.) now reach anyone with full payroll
  access as well as the Super Admin.
- A Payroll grant already brings two-step sign-in, so the switch does too.

**Off (the default)** a Payroll grant is unchanged: prepare only.

**Verified.** `test/payroll_full_access.test.js` (5 tests, through the real
payroll router: refused, admitted, revoked on the next request). Two mutations
each caught. Existing guards repointed from `requireAdmin` to
`requirePayrollRunner`. Full suite 4060 pass; the 2 failures (timesheets) fail
on main too.
