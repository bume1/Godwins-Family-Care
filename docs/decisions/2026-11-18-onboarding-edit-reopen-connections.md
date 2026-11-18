# Onboarding: edit and reorganize built-in tasks, reopen tasks, and connect onboarding with training and Pay Setup

**Date:** 2026-11-18 · **Owner:**
- "we should be able to edit and reorganize hard-coded onboarding tasks"
- "these tasks should be able to be reopened if closed too"
- "make sure all connections ... are connected across onboarding and training area"
- "instead of ask to upload those docs, a link or button should take them directly to the area in pay and hours"

## Edit and reorganize built-in tasks
- **The office can change any built-in task** from its panel, with Edit Task: rename it, move it to another phase, or hide it from the checklist.
- **Reordering:** up and down arrows on each row.
- **Hidden tasks are listed under their phase**, with Restore.
- **Restore Original** puts a task back to the Playbook's version.
- **Where it is stored:** `onboarding_item_overrides`, one entry per task id (not PHI), applied inside `buildTrack` (`applyItemOverrides`).
  - Every view follows the change: the staff checklist, the office person view, the overview, the Staff Record panel and the library.
  - Phase counts and progress move with it.
- **A change applies to everyone on that chapter's checklist.**
- **Hiding keeps what was recorded.** Restoring brings it back.

## Reopen a task
- **Who:** the office, with a reason.
- **What it clears:** the task's steps, acknowledgments and any "does not apply".
- **Nothing is deleted.** What was recorded moves to the task's `reopened` history, and files stay.
- **What it can't undo:** anything that ticks from the welcome packet or Pay Setup stays done there.

## Onboarding ↔ training
- **Phase to training:** on both the office and staff checklists, a phase with trainings has an **Open Training** button.
- **Training to phase:** the staff Training tab is grouped by phase.
- **Course items:** tasks done through courses or a phase's trainings (A.7.04, the 40-hour program, C.7.02) have **Open Training** in their panel.
- **Library to training:** in the staff Library, "On your onboarding" now has a **Go to My Training** button.
- **Links to each tab:** each My Onboarding tab has its own link (`#checklist`, `#training`, `#library`, `#documents`). The My GFC and caregiver onboarding cards gained **My Training** buttons.
- **The office Library:** each training lists the people who have it, and each name opens their onboarding. A person's Training tab links each training back to the Library (`?module=…#office-library`).
- **Smaller fixes:**
  - Readiness names the trainings still to finish.
  - A failed file open on the staff Documents tab now says so.

## Pay and tax forms: a button to Pay Setup, not an upload
- **No upload on pay items.** On items that read Pay Setup (W-4, I-9, W-9, how they are paid), staff get a button to Hours & Pay → Pay Setup instead of Upload or Mark Sent.
- **The step ticks itself** when Pay Setup is done. It shows as done and is never named as their next step.
- **Refused on the server:** a "Mark Sent" or upload on those items (`PAY_SETUP_ROUTE`).
- **Items changed:**
  - B.5.02 and F.5.03 now tick from Pay Setup, as C.5.03 already did.
  - A.5.02 (caregivers) links to Pay Setup, and also reads how they are paid.
- **Not moved (owner):** the welcome packet's documents and the Documents upload types are unchanged.

## Verified
- `test/onboarding_reorganize.test.js` (6 tests through the real routers).
- Two existing pins repointed: A.5.02's link, and the document-sign check order.
- Full suite passing.
- Chromium:
  - an RN's checklist with reorder arrows
  - Edit Task
  - the Pay Setup step text
  - the staff `#checklist` link on a phone
