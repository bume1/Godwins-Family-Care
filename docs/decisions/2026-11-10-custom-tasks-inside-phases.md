# Office-added onboarding tasks sit inside a phase, not in a phase of their own

**Date:** 2026-11-10 · **Owner report:** adding your own task to the onboarding wizard "adds it as another phase versus another task."

## What changed
- **No more "Added by GFC" phase.** A task the office adds is a task inside one of the person's own phases.
- **Where it goes:**
  - Added from a person's checklist: the phase being viewed.
  - Added from the overview for a whole type: the office picks the phase. Left blank, it goes in that chapter's last phase.
- Tasks saved before this change have no phase and move into the chapter's last phase.
- `POST /api/onboarding/admin/custom-tasks` takes `phase`, checked against that chapter's phases (`TASK_PHASE_UNKNOWN`). `GET` returns each chapter's phases for the picker.

## Verified
- `test/onboarding_custom_tasks.test.js`: 1 new test, 2 repointed.
- 2 of 2 mutations caught: the picked phase ignored, and the old own-phase restored.
- Full suite 3606 pass, 0 fail.
- Not rendered in a browser this pass.
