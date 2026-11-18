# The signature button sits on the signature step; duplicate hand-added tasks removed

**Date:** 2026-11-18 · **Owner:**
- "why is there a new button added? use attach document to sign mean what???"
- "we don't need duplicate ones so go ahead and delete the old ones yourself"
- "the W-2 needs apply for all W-2 clinicians and hybrid needs apply to all hybrid clinicians"

## The button
- **Nothing new was added.** "Attach Document to Sign" already existed at the top of a task.
- On a task with a signature step (an offer letter or agreement), that button now sits on the step itself, under "{name} signs". The sentence that pointed to it is gone.
- "Signed on paper instead?" stays as the tucked-away backup.
- Tasks with no signature step keep the button at the top.

## Duplicate tasks
- **When:** once, at boot (`onboarding/dedupeCustom.js`, marker `onboarding_custom_dedupe`).
- **What it removes:** hand-added tasks whose title copies a built-in task. That covers:
  - CAQH, Medicare, PDMP, BLS and education
  - I-9 identity documents, NPI and taxonomy, DEA
  - outside employment, TB, immunizations, driver's license
  - data bank and Pay Setup
- **Nothing is lost:** before a task is removed, its files, notes and her finished step move to the built-in task. A note records where they came from.
- **Left alone:**
  - a task that carries a document to sign, such as her updated agreements
  - a task whose built-in copy is not on that person's checklist
- **The boot log lists what was removed and what was kept.**

## Who gets which tasks
- **W-2 clinicians (Chapter C):** every clinician credentialing task.
- **Hybrid clinicians (Chapter E):** the same tasks, plus the exam ones, already built in: the contractor agreement, the W-9 and vendor setup, and keeping the two engagements separate.

## Verified
- Tests in `test/onboarding_reorganize.test.js` and a repointed pin in `test/onboarding_item_documents.test.js`.
- Full suite passing.
- Chromium: the offer letter task shows the button under the signature step.
