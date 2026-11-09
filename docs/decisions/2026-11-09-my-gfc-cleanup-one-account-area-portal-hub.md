# My GFC clean-up: one account area, Team Bios moved, a Portal Hub button

**Date:** 2026-11-09 · **Owner-directed**

- **Banners.** The policies note ("These always open the current version…") shows only to the admin team (admin, managers, care coordinators). The shared-folders note was already inside the admin-only "Manage Shared Folders" box.
- **Team Bios removed from My GFC.** Each person's headshot and bio now show read-only on their User Management form, in a "Headshot and Bio" card (`StaffBioSection`, via a new `GET /api/my/admin/bios/:userId`, admin team only). Staff still edit their own in My GFC → My Profile (the Account section, renamed).
- **The blank button.** In the caregiver app, a link styled as a button inherited the host page's link colour: navy text on a navy button. `a.mg-btn` now sets its own colour on every host page. This was confirmed by rendering the page before and after the fix.
- **One account area.** The account cards (password, two-step sign-in, backup codes, signed-in devices, OpenEMR, email) moved into one shared component, `public/account-cards.js`.
  - Staff see it in My GFC → My Profile.
  - A staff member opening `/account`, the admin hub's "Your account" link (now "My Profile (My GFC)"), or the clinical workspace's Account & Security link lands there.
  - `/account` stays for clients and family, who have no My GFC, and renders the same component. The cards exist once.
- **Portal Hub on every staff sidebar.** My GFC (and so the caregiver app), the clinical workspace, and staff onboarding each have a "Portal Hub" button to `/login?hub=1`.
  - Without `?hub=1` the hub sends a clinician, caregiver or liaison straight back to their landing page. A deliberate visit now stays on the hub.
  - The hub now lists tiles for those staff:
    - clinicians: My GFC and the Clinical Workspace
    - caregivers: My GFC, which opens the caregiver app
    - liaisons: My GFC
  - Clients and family still get none.

## Verified
- 6 new tests plus the account suite repointed at the shared component, with 6 of 6 mutations caught.
- `scripts/verify_account_render.js` 33/33, including a staff member redirected to My Profile.
- Full suite 3370 pass, 0 fail.
- My Profile rendered in Chromium.
