# The SSN, entered once: read off the card, taken at the W-9, revised by the office

**Date:** 2026-11-15 · **Owner-directed** · Branch `claude/ssn-entered-once` (stacked on #318)

## What the owner asked
"Social security card should be recognized and then the number extracted and input in the appropriate area from staff side, that they are able to edit or revise. Why can't the # just be entered once while completing the W-9? If the W-9 was uploaded, that's when it asks to input full SS/TIN."

This supersedes #318's rule that "the office never enters the number". The person's own Pay Setup to-do stays, as the fallback when the office does not have the number.

## What changed
- **One number fills both the SSN and an SSN-type W-9 taxpayer ID** (`shareSsnTin`). It doesn't matter who enters it first: the office or the person, by SSN or by W-9. Revising the SSN revises a W-9 number that came from it.
- **Social Security card.**
  - When a document is filed as an SS card, or reads as one, its 9-digit number is read two ways: the printed digits (PDF text or OCR in the container), and a separate AI question asked only of SS cards. The W-9/W-4 pre-fill boxes stay secret-free.
  - The number is sealed with the payroll key the moment it is read, and stored as `ssnRead {enc, last4, reads, agree, disagree}` on the document.
  - A screen sees the last 4 only. Without the payroll key, nothing is kept.
- **Use For SSN** shows the card beside "Use the number read off this card, ending 6789" or "Type it from the card". It saves through `PUT /api/payroll/admin/people/:userId/ssn`, which:
  - is open to payroll preparers;
  - only takes a number from their own accepted SS card;
  - copies the sealed value, so the full number never reaches the browser.
- **W-9 Mark On File asks for the number there, once.** The choices are:
  - keep the number on file;
  - use their SSN on file;
  - read from their SS card;
  - type it.
  If the office leaves it blank, Pay Setup asks the person.
- **The office can edit or revise:**
  - the Staff Record → Documents line "Social Security number: ending 6789 · Edit";
  - Payroll → People: SSN and Taxpayer ID, each with Edit/Add (`PUT …/tin` takes an SSN or an EIN).
  - The logs say what happened, never the number. Seeing the full number is still the Super Admin's logged reveal only.
- **The person's side:**
  - Pay Setup notes "added by the office";
  - their own in-app W-9 offers "Use my Social Security number already on file".

## Verification
- `test/staff_doc_match.test.js`: 22 tests. 8 deliberate code breaks, all caught.
- One older test was repointed: `gov_forms` reads the `Paperwork` signature, which gained `reload`.
- Full suite: 3,910 tests, 0 failing.
- `scripts/verify_documents_on_file.js`: 38/38 through the real server. A test SS card PDF (made-up number, TEST DATA) is:
  1. read as ending 6789 and stored sealed;
  2. refused when another person's document is named;
  3. saved by Use For SSN;
  4. used by the W-9 automatically, with no to-do;
  5. revised by the office, with the W-9 number following;
  6. refused when a caregiver tries to set it;
  7. absent from the logs and history.
- Rendered in Chromium:
  - the SS card panel;
  - the W-9 number choices;
  - the Documents SSN line;
  - Payroll → People adding a taxpayer ID.

## Limits
- OCR on a phone photo can misread a digit. The office checks the last 4 against the card, and a disagreement between the two reads is shown.
- Live Vertex is not proven from here.
