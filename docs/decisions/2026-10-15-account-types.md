# One account type per user, and the lab-era access checkboxes retired

Owner, 2026-10-15: "before we even choose who gets what message, let us get our user account types and permission straight."

**Why:** an account was set up with two pickers that could disagree: a Role dropdown ("Clinical (FNP)", "Case Manager", "Manager" ...) and a separate Clinical role dropdown, plus three lab-era checkboxes. Different parts of the app read different ones. An LMSW set up as "Clinical (FNP)" messaged like a provider; the same LMSW set up as "Case Manager" messaged like a case manager. A care coordinator was quietly stored as a case manager. A clinical account with role Read-only or Care Coordinator had no messaging role at all, and neither did any manager.

## What was decided

- **`accountTypes.js` is the one place that decides what an account is.** Ten types: Super Admin, Manager, Provider, RN, LCSW, LMSW / Case Manager, Care Coordinator, Caregiver, Client, Family. The type sets `role`, `isManager`, `clinicalRole` and `hasClinicalAccess`; the user form never sets those on its own. The stored fields stay because hundreds of readers depend on them.
- **Every case manager is an LMSW** (owner). The LMSW type is role `caseManager` + clinical role `lmsw`.
- **A Manager** runs scheduling, billing and patient account management. Clinical Workspace access is chosen on the user form: **View only (the default)**, No access, or View and edit charts. Stored as the manager's clinical role (`readOnly` / none / `coordinator`), so every existing clinical gate already answers correctly. "Keep the view only designation just in case" is the View only level.
- **A Care Coordinator** is a manager plus chart writing and editing (owner). Stored as role `user` + `isManager` + clinical role `coordinator`, so every manager gate (scheduling, billing, caregiver management, order destinations, document removal) admits them with no second rule. "Unlicensed" is gone from the label. They still never sign: signing is a licence, and that gate is unchanged.
- **Landing on sign-in** (`accountTypes.landingFor`, carried on the login response): Provider, RN, LCSW and LMSW / Case Manager go straight to `/clinical`. Super Admin, Manager and Care Coordinator land on the Portal Hub.
- **Hub tiles** (`accountTypes.hubTilesFor`, carried on the login response): Super Admin sees Admin Hub, Clinical Workspace, Private Home Care, Service Portal, Client Portal Admin. A Care Coordinator sees Clinical Workspace and Private Home Care. A Manager sees Private Home Care, plus Clinical Workspace unless set to No access. **Private Home Care opens to Caregiver Management (`/caregivers`) and Caregiver Scheduling (`/scheduling`).**
- **The Service Portal, Admin Hub and Client Portal Admin checkboxes are removed** (owner). Only a Super Admin opens those three areas "until we revise these areas". `requireAdminHubAccess` and `requireClientPortalAdmin` are admin-only; the admin hub and service portal pages send a non-admin back to `/login`; the client-portal admin view is admin-only; every save clears the three flags; a vendor no longer gets the Service Portal automatically.
- **The boot migration** (`migrateAccountTypes`, after the clinical-role migrations) clears the three flags on everyone, moves a coordinator off the case-manager role, moves an LMSW set up as a clinical account onto LMSW / Case Manager, and writes `accountType`. **A record that does not map cleanly is flagged, never guessed** (a lab-era "team member" with no clinical role, a case manager an admin deliberately set to Read-only, a role-`user` Read-only account). Those show in an amber "need an account type" banner on User Management and keep the landing they had while they wait. Idempotent.
- **The only Super Admin cannot be demoted** (409 `LAST_SUPER_ADMIN`).
- **Messaging, minimal:** `actorRole` now treats a manager or coordinator as the office (`admin`). Before this a manager had no messaging role at all. Who starts, reads and is emailed what is the next pass.

## Must not undo

- The form lists no account type of its own. Types and manager access levels are served by `GET /api/admin/clinical-roles` (`accountTypes`, `managerClinicalAccess`), with each type's `fields`.
- The user routes let `accountType` override `role`, `isManager` and `clinicalRole` in the body, so a request cannot save a combination that disagrees with itself. An unknown type or access level is refused by name.
- No gate may open on `hasAdminHubAccess`, `hasClientPortalAdminAccess` or `hasServicePortalAccess` (build-enforced in `test/mfa_sessions.test.js`).

## Verified

- `test/account_types.test.js`: 21 tests. 8 deliberate breakages, each caught (LMSW stored as `user`, a no-access manager still shown Clinical, the Admin Hub gate reopened to managers, a read-only case manager widened to LMSW, the messaging manager line removed, the login page ignoring server tiles, a coordinator stored as a case manager again, the PUT no longer clearing the checkboxes).
- Three existing tests repointed, not deleted: the coordinator option is now checked in the served catalog; the "form does not restate the role enum" check now covers the account type and manager access pickers; the MFA gate scan now also fails if a gate opens on a retired checkbox.
- Full suite 2492, 0 failing (1 skipped, pre-existing).
- `scripts/verify_account_types.js`: **40/40 through the real routes** on a booted app. Each type stores what it should; a body that also sends `role: 'admin'`, `isManager` and all three checkboxes cannot smuggle any of them in; landings and hub tiles per type; managers and coordinators refused the Admin Hub API but open scheduling and caregiver management; View only reads but edits nothing; a manager granted chart editing can then document; the only Super Admin cannot be demoted.
- The hub rendered in headless Chromium as a manager: Clinical Workspace + Private Home Care, and Private Home Care opens to the two blocks. No page errors.

## Open for the owner

1. **Patient account management for managers.** The enrollment write actions (approve, service line, documents, rate, paper signature) are still Super Admin only. Managers can read enrollment but not change it. Say if managers (and coordinators) should get those.
2. **Billing lives inside the Clinical Workspace**, so a manager set to No access cannot bill from the screen. The server still lets billing read the note it codes.
3. **Anyone flagged "needs an account type"** after the first boot: open each one on User Management, choose the type and save.
4. **Messaging is the next pass.** Today managers and coordinators message as the office, LMSW / Case Managers start Behavioral Escalation and Care Coordination only, and clinicians start their four.
