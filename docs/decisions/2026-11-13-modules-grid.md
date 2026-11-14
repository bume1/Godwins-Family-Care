# A Modules grid on Edit User (2026-11-13)

**Owner request:** "an option grid in the user mgmt area where employees automatically get access to certain modules based on permissions (checked off in the grid) while others can be customized … a super admin gives special permission to billing vs. payroll."

**Owner answers before the build:**
- **Defaults are removable.** A module the account type includes comes ticked, and a Super Admin can untick it.
- **A Payroll grant is prepare only.**
- **Every module is grantable,** within the limits below.

## How it works
- **One answer.** `accountTypes.hasModule(user, id)` decides every module. The Portal Hub, the staff bar and each module's route gate all read it, so a tile and the screen behind it cannot disagree.
- **Defaults** (`moduleDefault`) are the hub as it stood before the grid, unchanged. Nobody gained or lost anything when this shipped.
- **Storage.** Overrides are stored on the user as `moduleAccess: { granted, removed }`. Only differences from the role are kept.
- **Fresh on every request.** `req.user.moduleAccess` is read each time, so a change applies on the person's next click.
- **The grid.** Edit User → Modules, Super Admin only. It reads and writes `GET/PUT /api/users/:id/modules` (both `requireAdmin`) and restates no rule of its own.
- **Audit trail.** Each save writes `user_modules_changed` with the before and after.

## Locked, and why
- **My GFC and Messages:** everyone on the team has them.
- **Admin Hub:** Super Admin only. It holds User Management and this grid, so whoever could open it could give themselves anything. The grid routes are `requireAdmin`, and `moduleAccess` is an access field that `checkUserWrite` strips from a non-admin's user form.
- **Service Portal and Client Portal Admin:** lab-era screens, kept Super Admin only.

## Narrower grants
- **Clinical Workspace: view only.** A grant resolves to `readOnly` in `clinicalRoles.resolveClinicalRole`. A removal resolves to no clinical role at all.
- **Payroll: prepare only.**
  - A preparer can draft and rebuild runs, add lines, read the register and payment sheet (last four digits only), record tax deposits and filings, view the quarter figures, build examiner payouts and export the hours file.
  - A preparer cannot approve a run, mark a payment paid, see full bank numbers, change settings or people's pay setup, approve tax tables or contractor invoices, run the Gusto import or release year-end forms.
  - `routes/payroll.js` uses `requirePayrollPreparer` vs `requireAdmin`, and the page hides the Super Admin's buttons.
- **IME:** the exam-day list. The AI case review stays with examiners.

## Also changed
- **MFA follows a grant.** A granted module brings two-step sign-in, even for a caregiver (`mfa.mfaRequiredFor`).
- **Landing.** A caregiver or liaison with a grant lands on the Portal Hub, where the tile is.
- **Gates repointed to `hasModule`:**
  - billing (`canSubmitBilling`), scheduling (`isScheduleManager`, the availability recorder)
  - onboarding (`isOffice`), Home Care Oversight (`isCaregiverOffice`, the office half of `isReviewStaff`)
  - Incident Log (its own reader/office gates), clients (`canManageEnrollment`, the office half of `requireEnrollmentStaff`)
  - IME (`requireVeteranStaff`), User Management (GET `/api/users`, `checkUserWrite`, `canManageAccountType`), Audit Log (`requireAuditReader`)
- **Pages.** The Admin Hub and the Clients page read the record's `modules`. `staff-nav.js` refreshes it from `/api/staff/hub`.

## Verified
- **Tests.** `test/module_access.test.js` has 9 tests. Ten older tests were repointed, not deleted; each pinned a gate that moved onto the module.
- **Mutations.** 12 mutations: 11 caught. One survived and is a deliberate belt-and-braces line (`hasModule`'s locked check, which `moduleAccessOf` already enforces), noted in the code.
- **Suite.** Full suite: 3698 pass, 0 fail.
- **Browser.** The grid was rendered in Chromium against the real `moduleGridFor`. It granted Billing and Payroll to an RN, took IME away, and saved; the Admin Hub row is disabled.
- **Real bug caught by an existing test.** One edit landed in two places, in `migrationRoleFor` as well as `resolveClinicalRole`, and the 4.8 migration test caught it. Fixed.

## Not proven here
A live grant through the deployed app. Try it on a test account after the rebuild.
