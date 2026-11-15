# Care Coordinator onboarding: clinical scope awareness

**Date:** 2026-11-09 · **Owner-directed**

**Before.** Managers and care coordinators were onboarded on Playbook Chapter F (non-clinical, employed), with the staff welcome packet as step 1. Neither had role-specific steps beyond F.7.03 "Role training plan".

**The owner's ask.** A care coordinator needs clinical scope awareness, so they know which clinician to support with what. Managers are unchanged.

## What changed
Three items are added to Chapter F's "Systems & Role Training" phase. They show **only for a care coordinator**:
- **F.CC.01 Clinical scope: who does what**
  - One line each for Provider (FNP, MD, PA), RN, LCSW and LMSW (case manager).
  - Each line names what that role may do. RN and LMSW lines note that their signature authors a note and a provider's or LCSW's addendum makes it billable.
  - The coordinator acknowledges; the Clinical Director records it reviewed.
- **F.CC.02 What a coordinator does, and never does**
  - What they do for a licensed clinician, and what they never do.
  - Also covers the app's own note-signing refusal and the care-plan co-sign rule.
  - The coordinator acknowledges.
- **F.CC.03 Supporting each clinician, observed**
  - A note prepared and signed, a care plan drafted and co-signed, an RN standing-order visit, and an LMSW screening and referral.
  - A supervisor observes and signs off.

## Must not undo
- **The lines are built from `clinicalRoles.ROLE_CAPABILITIES`** (`onboarding/coordinatorScope.js`), the allow-list the app enforces. Onboarding cannot tell a coordinator something the app does not do. Only the plain-English words live there.
- **`careCoordinator` is read from the account** (account type `coordinator`) by the server, the same way a caregiver's license level is. Setup never stores it.
- **These are owner items, not Playbook rows,** and each says so.

## Verified
- `test/onboarding_coordinator_scope.test.js`: 4 tests, 6 of 6 mutations caught.
  - One mutation survived at first: the item could have carried its own copy of the lines. A test now pins it to the generated ones.
- Writing the test caught a real bug: the gate that decides who sees an item ignored the new `careCoordinator` condition, so the items showed for everyone on Chapter F.
- Full suite 3581, 0 failing.
- In Chromium against the real server, the coordinator's checklist shows the three items with their sub-bullets, and the manager's shows none.
