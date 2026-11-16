# The Training Library is open to every staff member; Document Links moves to the Admin Hub

**Date:** 2026-11-16 · **Owner direction:** "Move to admin hub. While opening training library to employees where they can see all trainings, with those greyed out that are pending training material. We need to be directing employees to this library to view SOPs with the direct link as supplement."

## What changed

- **Staff Training Library.** `GET /api/onboarding/library` (any staff member, caregivers included) lists every training in the library: the catalog plus anything the office added. Each row carries its area, who it is for, its format, the policy or SOP it ties to with a direct Drive link, and two flags:
  - `ready`: there is material to open;
  - `comingSoon`: it waits on an SOP or material still to be made, the same `waitingOnSop` rule her own Training tab uses.
  
  It also carries `assigned` when the training is on her own onboarding.
- **Opening a training from the library.** `GET /api/onboarding/library/:moduleId/material` and its file route serve any **ready** training, whether or not it is on her track. A pending one answers `MODULE_NO_MATERIAL`, an unknown one 404. Every read is logged as `onboarding_library_read`.
- **Read only.** Nothing in the library records a completion. That stays on her Training tab, under the existing sign-off rules. Office-only fields (next step, office note, review, version flag, who it is assigned to) never reach the staff response; a test pins this.
- **Works before onboarding starts.** A staff member the office has not started yet sees the library on `/onboarding` instead of a dead end.
- **Where staff find it:**
  - a **Library** tab on My Onboarding;
  - `/onboarding#library`;
  - a "Training Library" button on the My GFC onboarding card, shown even before onboarding starts;
  - a Training Library card in the caregiver app's Onboarding tab.
  
  The office can see it as staff do from "Library as Staff See It".
- **Greyed cards still link the policy.** A greyed training shows "Ties to:" as a live link and says to read the linked document in the meantime. The same change was made on the greyed card in her own Training tab.
- **Document Links moved to the Admin Hub** as **Policy & SOP Files**, its own sidebar item. It uses the same routes as before: `GET` for the office, `PUT` for the Super Admin only. It no longer sits inside the office Training Library, which is about trainings, not files.

## Why

The library and the document list read as the same thing to the owner. They are now separated by purpose:
- the library is where staff learn;
- Policy & SOP Files is where the Super Admin points each document at its current Drive file.

## Verification

- `test/staff_training_library.test.js`: 4 tests over the real router. A mutation that turns off the greyed-out flag fails it.
- `test/sop_format.test.js` count guard updated: three cards now label format through `shownFormat`.
- Full suite: 3,934 tests, 0 failing.
- Rendered in Chromium on an iPhone 13 (not-started caregiver; started caregiver via `#library`; a greyed card; an opened training) and at 1280px (Admin Hub Policy & SOP Files; the office's staff view). No page errors.

## Set 1 v2.1

Administrative SOPs Set 1 is reissued as v2.1 (`1Rm4Q9Qk0C6nRh_G4uvM8uWCGF3sB7FQD`, in Current, view-only to anyone with the link) and is now the app's default Set 1 file.
- **SOP-ONB-03** gains The Training Library.
- **SOP-ONB-04** replaces "Manage versions" with issuing a new version through Policy & SOP Files, and adds Library as Staff See It.
- v2.0 (`1QYhVaYr5lawntGbBPZKyFCtNfUCwVQqs`) moved to Superseded and keeps its sharing, so links already sent still open.
