# A document is checked before it is used, and its type can be changed any time

**Date:** 2026-11-15 · **Owner report** · Branch `claude/document-type-fixes`

## What happened
Tasha's W-4 had been uploaded as "W-9". The Documents screen offered **Use For W-9**, and the panel opened as a W-9.

The reader was not the problem. Tested on a filled W-4 filed as a W-9, it reports "Reads as Form W-4… It was filed as Form W-9." Her file had simply never been checked: it was uploaded before reading existed, and nobody had pressed Check Documents. **Use For** followed the label it was uploaded under.

The owner also found no way to change a document's type, either before or after the office accepts it.

## What changed
- **Unchecked files are checked when the Documents section opens.** This happens once per person per visit, and the server reads only files with no reading yet.
- **Use For is never offered on a file that has not been checked**: "Not checked yet. Press Check Documents…".
- **Use For is never offered on a file that reads as a different form**: "This reads as Form W-4, not W-9. Change its type first."
- **The server refuses it too.** Putting an unchecked document on file is refused with `ON_FILE_NOT_READ`. A mismatched one was already refused with `ON_FILE_READS_DIFFERENT`.
- **Change Type is on every document row, before and after acceptance.** It is the office only, and every change is kept in `kind_history`.
  - A document already on file in payroll cannot change type until it is taken off file (`DOC_ON_FILE`).
  - An unread file, or one changed to Social Security card, is read again after the change. That is how a card filed as "Something else" gets its number read.

## Verification
- `test/staff_doc_match.test.js`: 24 tests. 4 deliberate code breaks, all caught; one was caught only after a probe check was added for it.
- Full suite: 3,912 tests, 0 failing.
- `scripts/verify_documents_on_file.js`: 46/46, run twice. It covers a W-4 uploaded as "W-9" end to end: refused while unchecked, flagged once checked, refused as a W-9, changed to W-4, put on file, then refused a further type change. It also covers Change Type before acceptance, and a card read after its type change.
- A test-data fix in the probe: the "never logs the number" checks now match the test number on its own. They had been finding the digits inside timestamp-based document ids, a chance false alarm.
- Rendered in Chromium: Change Type on each row, with no page errors.
