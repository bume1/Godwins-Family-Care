# Onboarding: links into the app, readable training text, open trainings, editable instructions

**Date:** 2026-11-10 · **Owner-directed**

## Items open where they're done
- In-app items carry a `link`, shown in the side panel to the person only, in the same tab:
  - Pay Setup (`/my#hours/pay`)
  - Time Clock (`/my#hours/clock`)
  - Availability (`/my#hours/availability`)
  - OpenEMR sign-in (`/clinical#settings`)
  - the caregiver welcome packet (`/caregiver#onboarding`)
- `/my` reads `#view/part` and scrolls to `mg-<part>`.

## Training text reads cleanly
- `public/sop-format.js` lays the SOP lines out on the page:
  - the metadata line, small and grey
  - headings
  - bold lead-ins ("Purpose.")
  - bullets under a heading
- Display only. The stored lines are unchanged, because check questions and manual fingerprints read them.
- A "Video" training whose material is only text shows as "Read".

## Greyed out only while waiting on an SOP
- The Library and onboarding disagreed: onboarding greyed out every module without attached material, including ones the Library calls External, Attach existing or No material needed. Outside courses, documents and handbooks to sign were blocked as a result.
- **Rule now:** a module is greyed out, can't be completed, and doesn't hold its phase open only when it has no material **and** the Library's next step is "Write SOP" or "Policy gap".
  - `nextStepFor` is shared by the Library and the track, so the two always agree.
- A certificate training tells staff to send the certificate. "The Self-paced signs this off." is gone.

## Editable instructions
- Admins and managers edit the instructions on any checklist item, custom task or training (Edit Instructions). Staff see the edited text in place of the default.
- Saving it blank restores the default.
- Stored in `onboarding_instructions` (not PHI, registered).

## Verified
- New tests:
  - `test/onboarding_app_links.test.js`
  - `test/sop_format.test.js`
  - more in `test/onboarding_library_alignment.test.js`, including that onboarding greys out exactly what the Library says is waiting on an SOP
- 2 tests repointed: payroll Pay Setup id; TRN-001 now open, TRN-216 still greyed.
- Mutations: 7 of 8 caught. The survivor stores a blank, which reads the same as removing it, so it changes no behaviour.
- Full suite 3667, 0 failing.
- Chromium: a hybrid clinician's outside trainings are open, and the SOP text shows with headings and bullets.
