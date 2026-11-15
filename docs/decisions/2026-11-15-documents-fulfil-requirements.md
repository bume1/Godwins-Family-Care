# Paperwork already on file counts; the phone form fits the screen

**Date:** 2026-11-15 · **Owner-directed** · Branch `claude/documents-fulfil-requirements`

## What the owner asked
- **Tasha's I-9 on her phone:**
  - make the entry boxes larger, with 16px text;
  - the form ran off the right edge of the screen.
- **Documents already uploaded should count:** "a way to upload documents manually and it fulfil the document need in their view, i.e. them seeing the already signed document". For example, Tasha already has a W-9 in Documents.
- **Matching:** the app should match uploads to payroll, billing and onboarding requirements, using "smart matches and AI scans to confirm, to ensure it's 100% correct".
- **Paper W-9:** the office types the TIN from the form.

## What was built
- **Two independent reads of each staff upload (`staffDocMatch.js`).**
  - **Smart match:** reads the printed government title, from the PDF text or from OCR run inside this container. It recognizes the blank W-9, W-4, I-9, G-4 and W-8BEN correctly, and an ID, SSN card, EAD or direct deposit form. A form number alone, such as "give us your W-9", is not a match.
  - **AI scan:** Gemini on Vertex, under the Google BAA. It goes through the model engine's declared `document_classification` purpose (declared earlier, never used until now) and picks from a closed list. It is never asked for a number.
  - **When Vertex is off:** the AI scan says "not run". "Not run" never counts as agreement.
  - **When reads happen:** after each upload, without delaying the upload. **Check Documents** reads files already on someone's record, such as Tasha's W-9.
  - **Broken images:** a broken image can no longer throw an uncaught OCR error (Tesseract `errorHandler`).
- **The office confirms; nothing counts from a scan alone.** On the Staff Record → Documents:
  - each document shows what it reads as, as "both checks agree", "printed title only, AI check not run" or "checks disagree";
  - **Use For W-9** (or the matching form) opens the document beside the fields to type, then **Mark On File**;
  - Payroll refuses the on-file step:
    - when the reads say it is a different form, unless the office confirms it looked;
    - for someone else's document, the wrong type, or a document that is not yet accepted;
  - **Change Type** re-files a document that reads as another form;
  - **Take Off File** undoes the on-file step.
- **New upload types:** `w4`, `g4`, `state_cert`, `i9` and `w8ben`, beside the existing `w9`.
- **Stored where the in-app form would be.** `p.w9`, `p.w4`, `p.g4`, `p.stateCert`, `p.w8ben` and `p.i9.onFile` each carry `onFile {documentId, signedOn, recordedBy, match}`.
  - Because the value sits there, the Pay Setup checklist, the money gates (`missingForPay`: payroll runs, contractor invoice approval) and the tax math count it unchanged.
  - **W-9:** the office types the name, classification and **TIN**. The TIN is sealed with `pc.seal`, the last four are shown, and the call is refused without it.
  - **W-4 / G-4:** the office types the filing status and withholding amounts, because payroll computes tax from them.
  - **W-8BEN:** name and country of citizenship.
  - **Signature:** the name and date signed on the paper.
- **The person sees it as done.** Pay Setup shows **Done**, "On file: signed on paper and filed by the office", and **Open Copy**. Open Copy serves the uploaded file byte for byte, never a regenerated form. My Documents lists it as "signed on paper (on file)".
- **Onboarding follows.**
  - Items A.5.02, C.5.03, D.4.03 and E.2.02 read the Pay Setup forms as `payform:*` assist evidence.
  - All done fulfils her SUBMIT step; all put on file by the office also fulfils the office's VERIFY step.
  - Assist evidence never holds an item open, so nothing already finished reopens.
- **Phone.**
  - **The real cause of the overflow:** the caregiver availability row's time boxes (plain `fr` columns) forced every My GFC screen to 478px on a 390px iPhone. Columns are `minmax(0,…)` now. The form workspace and the Documents to Sign workspace also use `minmax(0,1fr)` on phones.
  - **Entry boxes:** in the form workspace they are now full width, at least 46px tall, with 16px text so iPhone does not zoom when one is tapped.

## Verification
- **Tests:** `test/staff_doc_match.test.js` has 14 tests, and 6 deliberate code breaks were all caught. Two older tests were repointed for the new kinds and the `payform:` evidence. Full suite: 3,881 passed, 0 failed.
- **Live check:** `scripts/verify_documents_on_file.js` passed 19/19 through the real server, with Drive held in memory. It covers:
  - uploading the W-9 and the reads (the AI check shown as not run);
  - refusals without a TIN and for the wrong form;
  - Mark On File, with the TIN sealed;
  - Pay Setup done, and Open Copy returning the same bytes;
  - My Documents;
  - a W-4 filed as "Something else" being flagged, then Change Type;
  - a caregiver refused a type change;
  - Take Off File;
  - no TIN in the activity log.
- **Rendered in Chromium:**
  - the office Documents section and the Mark On File panel;
  - My GFC Pay Setup and the form workspace as an iPhone 13. The page is 390px wide with nothing past the edge, inputs are 358px, and text is 16px.

## Not proven from the sandbox
- The AI scan against live Vertex. Until Vertex is set up, the office confirms on the printed-title match, and the screen says so.

## Open for the owner
- After the EC2 rebuild:
  1. open Tasha's Staff Record → Documents;
  2. press **Check Documents**;
  3. use **Use For W-9** (with her TIN) or **Use For W-4 / I-9**, whichever applies.
- **Tasha's form depends on her type:** a caregiver is always W-2, so her paper forms are the W-4 and I-9. A W-9 counts only for a 1099 contractor.
