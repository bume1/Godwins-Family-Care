# View as shows the whole app as that person sees it (owner, 2026-11-08)

Owner: "Why is the view as ability for admin only scoped to the clinical EHR? I want to be able to view as as if I am them."

Driven in a browser before any change. Viewing as a caregiver or a client already worked. Viewing as a **manager or coordinator** went wrong in four ways:
- It **opened the Clinical Workspace**, not their Portal Hub. `viewAsDestination` used `appLinks.homeFor`, an older rule, instead of `accountTypes.landingFor`, which their real sign-in uses.
- Their **Portal Hub read "No Portals Available"**, and **User Management sent them to the login page**. View as handed the page a cut-down profile with no account type, manager flag, hub tiles or landing.
- **Caregiver Management and the Portal Hub showed no banner and no Exit**, because neither page loaded `session-guard.js`.
- The banner called a manager a **"clinician"**, because both are stored as role `user`.

Fixed:
- **`loginProfileFor(user)`** is the one profile a sign-in hands the browser. The real sign-in and View as both use it, so viewing as someone shows what their own sign-in would. View as skips the password-change prompt, since changing their password is blocked anyway.
- **View as lands where their own sign-in would:** `accountTypes.landingFor(u)`, or the Portal Hub.
- **`session-guard.js` is on `caregivers.html` and `login.html` (the Portal Hub).** That brings the banner and Exit, and on Caregiver Management also the idle sign-out it had been missing. Both are added to the every-signed-in-page test.
- **The banner names the account type** (Manager, Care Coordinator, Client), falling back to the old role word.

Unchanged: Super Admin only, never into another admin, 60-minute cap, and signing, OpenEMR and their account settings stay off.

Verified in headless Chromium against the real server, as the Super Admin viewing as each type:
- **Manager and coordinator:** land on their Portal Hub with all six tiles, and Caregiver Management, Scheduling and User Management each load with the banner.
- **Caregiver, client and RN:** land where they should.
- **Exit:** returns to the Super Admin's Admin Hub.

Suite 3229, 0 failing.
