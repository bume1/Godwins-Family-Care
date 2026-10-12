# Coding: "Unsaved changes" stayed after saving

**Date:** 2026-10-12 · **Owner report:** "when saving in the coding area, it still shows an unsaved changes message"

## What was wrong
After a save, the encounter reloads. The reload decided whether to keep the coding boxes by comparing them with the record from **before** the save, so freshly saved codes looked unsaved and were kept. Two things then kept "Unsaved changes" on, and Sign & Submit blocked, forever:
- "Add to problem list" ticks were never cleared.
- The server tidies what it stores (`R55.` → `R55`), so the boxes never matched.

## Fix
- A successful coding save sets `adoptCodingRef`, and the reload after it takes the server's copy and clears the ticks.
- Any other reload (after an Rx, an order or a draft) still keeps unsaved coding, as before.
- A refused save keeps what was typed, because the flag is set only in the save's `.then`.

## Also in this PR
Part 4 of the clinical redesign (chat-bubble messages, the note screen, and Tasks, Overdue, Coding, Reports and Schedule). PR #174 was merged a few minutes before that commit was pushed, so it never reached main; it is carried here unchanged. See `2026-10-12-clinical-redesign-shell.md`, Part 4.

## Verified
- Full suite 2305 pass, 0 fail.
- The real reload callback is lifted out of the page and run against fakes: after a save it takes the tidied `R55` and clears the ticks; any other reload leaves typed coding alone.
- Four mutations each fail a test: the flag never set, the flag ignored, the flag never spent, the ticks not cleared.
- `bug_sweep_0929`'s keep-unsaved guard was repointed to the new line, not dropped.
- **Not driven in a browser:** the encounter panel needs a full OpenEMR fixture. The logic is covered by running it directly.
