# Onboarding: rows that read, and one Training Library

**Date:** 2026-11-18 · **Owner:** "fix this credential view too, for some reason it shows weird. Also, why do we have two training libraries?"

## Squeezed rows
A checklist row laid out the title, the tags, "Waiting on Office" and the status pill side by side, and nothing wrapped. On a narrower window the tags took the width, and the title shrank to a letter or two per line.
- `.item` now wraps.
- The title block keeps at least 260px (`flex: 1 1 260px`).
- When room runs out, the tags and pills move under the title.

## One Training Library
**Library as Staff See It** was a second menu item showing the same library, read-only, the way staff see it in My GFC. It is now a **See It as Staff** toggle inside Training Library, with **Back to Office View** to return. `#library` links still open the staff view.

## Verified
- A page guard in `test/onboarding_library_alignment.test.js`.
- Full suite passing.
- Chromium: a clinician's Credentialing phase at 1000px and 1440px reads in full. The toggle shows the staff view and back.
