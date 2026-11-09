# The staff welcome packet comes first

**Date:** 2026-11-09 · **Owner-directed**

## What changed
- **Signing in opens the welcome packet** (My GFC → Welcome Packet, `/my#welcome`) for any staff member who has not signed theirs: admin (the Super Admin included), manager, coordinator, provider, RN, LCSW, LMSW and liaison. Existing staff too.
- **It is the first screen, not a lock.** The Portal Hub button (`/login?hub=1`) skips it. The next sign-in opens it again until it is signed.
- **Caregivers are unchanged.** Their packet lives in the caregiver app, which already opens on it.
- **It is step 1 of every onboarding checklist** except Chapter A (caregivers, whose packet already feeds Chapter A's items). The item, `WELCOME` ("Welcome packet signed"), sits in the first phase. It has no steps and ticks itself when the packet is signed. There is no new onboarding section.

## Must not undo
- **The server decides the landing** (`staffWelcomePending` in `server.js`, set on the unified login's `userResponse.landing` before `finishLogin`, so the MFA challenge carries it too). A failed read of the packet store sends nobody anywhere new.
- **The step is read from `staff_welcome_packets`, never stored.** No door ticks it and it cannot be marked not applicable (both answer 404, since there is no catalog item behind it). Only `status: 'submitted'` counts.
- **`buildTrack` adds it only when the route passes packet rows**, so a caller with no rows gets the chapter exactly as the Playbook writes it.

## Verified
- 6 tests in `test/staff_welcome_first.test.js` (the server helper lifted out and run). 1 new route test in `test/onboarding_routes.test.js`, plus 1 repointed because item 0 is now the packet.
- 8 of 8 mutations caught.
- Full suite 3463, 0 failing. `login.html` and `onboarding.html` compile.
- Not rendered in a browser this pass.
