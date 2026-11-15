# Every onboarding item says what it is; the Playbook link is the office's

**Date:** 2026-11-09 · **Owner-directed**

## What changed
- **Every item in every onboarding chapter has a short description** (148 items plus the staff welcome packet). It shows:
  - under the title in the checklist rows, for both the office and the person onboarding
  - in full at the top of the side panel, replacing the technical "Playbook C.2 carries no row for this item" line as the first thing you read
- **Where the words came from** is recorded per item in `onboarding/descriptions.js`, and only the office sees it:
  - `PLAYBOOK`: Onboarding Playbook v3.0's own paragraph, verbatim or trimmed.
  - `PLAYBOOK_ADAPTED`: from a Playbook table row, a paragraph split or merged across items, or the chapter the Playbook points to (D.5 to C.6). Lightly edited.
  - `DRAFTED`: no Playbook text exists. These are the owner's additions (A.6.08, C.5.06, C.6.10–14, C.7.06, D.6.04, F.CC.01–03, WELCOME), drafted for review, and the office side panel labels them "Drafted for review".
- **The "Source: Onboarding Playbook" link is office-only.** The server no longer sends it to the person onboarding, and the side panel draws it only for the office.

## Must not undo
- The Playbook's full text stays in Drive and is not committed: the repository is public. Only the short per-item lines are, and the app shows those anyway.
- The source label never reaches the person onboarding (`descriptionSource` is office-only).

## Verified
- `test/onboarding_descriptions.test.js`: every item has a description; none names an unknown item; the owner's example reads verbatim; staff receive neither the source label nor the Playbook link over the real routes. 5 of 5 mutations caught.
- Full suite 3586, 0 failing.
- In Chromium: the office side panel shows the description, the provenance note and the link; the staff member's side panel and rows show the description with no link.
