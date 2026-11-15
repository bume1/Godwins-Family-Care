# The Training Library serves every team member, scoped to each person

**Date:** 2026-11-10 · **Owner-directed:** "a training area that is accessible and usable by all employees and scopes to each employee. It shouldn't just be clinical training."

Owner choices, the same day:
- Share the general modules with every role.
- A training the office adds is required in onboarding for the roles it is scoped to.
- Trainings show inside Onboarding only, with no separate My GFC section.

## What changed
- **The Library is the whole team's** (`onboarding/libraryTrainings.js`).
- **Clinical modules stay with clinicians.** Chapter C, D and E keep their own curriculum unchanged.
- **Six general modules go to every role:**
  - TRN-001 the organization
  - TRN-002 the role card
  - TRN-004 the GFC app
  - TRN-005 privacy and security
  - TRN-216 mandatory reporting
  - TRN-217 incidents
- **Where they sit:** a role that does not already carry one gets it in its chapter's training phase (`TRAINING_PHASE`: A.7, B.7, C.7, D.6, E→C.7, F.7, G.2, H.5). R1, a supervising physician under agreement, takes none.
- **The office adds trainings in Library → Add a Training:**
  - name, description, the staff roles it is for (any of the nine account types), who marks it complete (the person, or the office after checking), and minutes
  - It is required in the onboarding of everyone in those roles, in their training phase, and counts toward that phase.
  - Its material goes in through Manage Material, like any module. With no material it shows greyed out and the server refuses completion.
  - Stored in `onboarding_library_trainings` (not PHI, registered). Removing keeps the row and every completion.
- **The Library page now shows:**
  - who each module is for: Clinicians, Everyone, or the chosen roles
  - a "Show what <role> gets" filter
  - Remove on office-added trainings
- **One training can reach several roles:** one row, one set of material, one completion per person.

## Must not undo
- **Scope is the person's account type,** read fresh from their user record for each track.
- **Nothing appears twice.** A module a chapter already carries is not added again.
- **Office-added ids resolve on every door:** completion, sign-off, material and the library. The routes read the library before any lookup, so a fresh server never 404s one.

## Verified
- `test/onboarding_library_all_staff.test.js`: 4 tests through the real routes. A caregiver, an LCSW and an RN show scoping, the material gate, self-completion, the library's audience labels, and soft removal.
- Five existing tests repointed, not deleted (chapters D, F, G, B, H). They asserted "no Training Library modules" for non-clinical roles, the rule the owner reversed.
- 6 of 6 mutations caught:
  - role scope ignored
  - shared modules dropped
  - added trainings not required
  - the role never passed
  - a roleless training accepted
  - a removed training still applying
- Full suite 3610 pass, 0 fail. `onboarding.html` compiles.
- Not rendered in a browser this pass.

## Open for the owner
- The six general modules have no SOP or material for non-clinical staff yet, so they show greyed out ("Coming Soon") until material is added in Manage Material.
- TRN-004, "Application tour at first login", assumes an in-app tour that does not exist. Attaching SOP 1 as its material makes it a real, completable step.
