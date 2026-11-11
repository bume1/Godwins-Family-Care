# Caregivers see documents sent to them to sign

**Date:** 2026-11-11 · Found while writing the document-signing SOP.

## What was wrong
- A document the office sent to caregivers (by type, or to one caregiver) never reached them.
- The caregiver app's My Documents tab drew What You Signed and the upload card, but not the shared **Waiting on You** list that My GFC shows staff.
- Caregivers could only sign a document attached to an onboarding item, from the onboarding page.
- The 2026-11-09 decision said the caregiver app carried the list; it loaded the script but never rendered it.

## What changed
- `public/caregiver.html`, My Documents tab: renders `GFCDocSign.WaitingOnYou` above What You Signed, the same list and sign panel staff use.
- It reloads the caregiver's documents after signing, so the signed copy shows at once.

## Verified
- New test in `test/staff_document_sends.test.js`: the caregiver My Documents tab renders Waiting on You (comments stripped first).
- Mutation caught: removing the list fails the test.
- Full suite: 3680, 0 failing.
- Chromium at phone width: a document sent to All staff shows on the caregiver's My Documents with a Sign button, and the sign panel opens.
