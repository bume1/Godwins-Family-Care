# How-to guides in the Training Library

**Date:** 2026-11-18 · **Owner:** "it doesn't appear all of our how to guides are reflected in the training library, why?"

## Why they were missing
The library shows a document only when it is attached to a training. The app training (TRN-004) carried SOP Sets 1, 2 and 4 and the Staff Pay Guide. The guides in Drive's **EMR & App Guides** folder were never attached.

## What changed
- **Staff Guide to App Updates** (the Nov 16 Google Doc):
  - registered as source `STAFF_APP_UPDATES_GUIDE`, so it is listed in Policy & SOP Files and each new edition is swapped in there
  - attached to TRN-004 by the per-key seed, so the live TRN-004 picks it up once at boot
- **Moving Employee Records from Gusto into the GFC App:**
  - registered as `GUSTO_RECORDS_GUIDE`
  - shown as a "How-to" link on the office SOP Set 3 row
  - never on a staff training
- **Not added:**
  - the Nov 11 App Updates PDF, which the Nov 16 Doc supersedes
  - the OpenEMR setup guides, which are IT setup, not training

## Verified
- `test/how_to_guides_in_library.test.js` (3 tests) and the repointed `training_default_material` pins.
- Full suite 3992, 0 failing.

## Open for the owner
- The Gusto guide is **private** in Drive. Share it with the admin team, or they get a permission page. The App Updates guide is already shared by link.
