# Gusto is out of caregiver onboarding

**Date:** 2026-11-10 · **Owner-directed:** "Eliminate gusto reference all together for caregiver included."

## What changed
- **Pay and tax paperwork is filled in in the app.** The W-4, G-4, I-9, W-9 and direct deposit are in My GFC → Hours & Pay (built 2026-11-08). No onboarding screen points at Gusto any more.
- **Three acknowledgments are signed in the app.** Packet items 17–19 are the Employee Handbook, the Privacy and Confidentiality Agreement, and the Code of Conduct, Attendance and Incident Reporting.
  - They were "sign in Gusto, upload the copy". They are now signed here, like the other four in-app forms.
  - They moved to group F and keep their printed numbers.
  - The wording is in `caregiverAttestations.js`, at `CURRENT_VERSION`.
- **The offer letter (item 16) stays an upload.** It carries each person's own rate, so it is a letter the office writes, not a form body.
  - Group E is now "Your Offer Letter", and its intro points pay paperwork at Hours & Pay.
- **Other Gusto wording removed:** the admin hub's documents card, a comment in `routes/caregiver.js`, and a clinician onboarding item detail in `clinicianItems.js`.
- **Kept:** the office's "Import Past Pay From Gusto" tool on the payroll screen. It brings in past pay history, not onboarding.

## Must not undo
- **A copy accepted before the move still counts** (`LEGACY_UPLOAD_SIGN_KINDS` in `welcomePacketRepository.js`).
  - A caregiver who uploaded a Gusto-signed handbook and had it accepted stays complete, flagged `legacyUploadAccepted`.
  - An unreviewed copy does not count.
  - The rule never covers a form that was always signed here.
- **Shift clearance is unchanged.** It still requires all three, now as signatures.
- **No item may name Gusto.** Build-enforced in `test/welcome_packet.test.js` and `test/drive_storage.test.js`.

## Verified
- Full suite 3597 pass, 0 fail, 1 skipped (pre-existing).
- 4 of 4 mutations caught:
  - an unreviewed legacy copy counted
  - the Gusto source restored
  - the legacy rule dropped
  - the legacy rule widened to an always-signed form
- Not rendered in a browser this pass. The caregiver checklist draws sign rows generically, with no fixed count.

## Open for the owner
- The three new bodies are drafts pending counsel review, the same status as the other in-app forms.
- Confirm nothing else is still being collected in Gusto for new hires.
