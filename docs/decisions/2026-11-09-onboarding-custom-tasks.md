# Office-added onboarding tasks

**Date:** 2026-11-09 · **Owner-directed**

Admins and managers can add their own tasks to staff onboarding.

- **Who gets it:**
  - one person, or
  - everyone onboarding under a type (an onboarding chapter: caregivers, clinicians, liaisons, admin team, and so on), including people set up later.
- **How it completes:**
  - the staff member marks it done
  - when the office ticks **"Office reviews it after it is marked done"**, the task waits with the office and is complete only once someone there clicks **Mark Reviewed**
  - the word is *review* (owner), not submit or confirm
- **Optional "Ask them to attach a file"** adds an Attach a File button on the task.
- **Where it shows:** tasks appear in a final phase, **"Added by GFC"**, which shows only when a person has at least one. The same sub-bullets as other items list who does what.
- **Where they're added:**
  - **Add a Task** on a person's checklist (for them or their whole type)
  - **Tasks Added by GFC** on the onboarding overview (any type), with Remove
- **Removing is a soft remove.** The task leaves every checklist; the row (`onboarding_custom_tasks`, not PHI) and anything anyone recorded are kept.

## Must not undo
- A custom task is never a Playbook item. It claims no classification and says so.
- Its office step is `OFFICE` / `REVIEW`. It is not a VERIFY, so no source or date is asked, and staff can never record it (`STEP_NOT_YOURS`).
- Item lookups in every door go through `itemFor(rec, id)`, so a task that is not this person's is unknown to their routes (404).
- Adding and removing are `requireOffice` (admin or manager).

## Verified
- `test/onboarding_custom_tasks.test.js`: 5 tests, 10 of 10 mutations caught.
- Full suite 3451, 0 failing.
- Chromium: the office added a type-wide task and a person task (with review and a file request); the staff member marked it done on a 390px phone; the office reviewed it; both steps were stored.
