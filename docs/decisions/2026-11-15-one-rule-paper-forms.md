# One rule for every paper form

**Date:** 2026-11-15 · **Owner-directed** · Branch `claude/one-rule-paper-forms`

## What the owner raised
"Use For" was inconsistent: some panels read as if the office signs, others asked for the employee's numbers. A paper W-9 that shows only the last 4 of the SSN could not go on file, because the panel required the full taxpayer ID. Owner answers: the employee types the full number in My GFC; the AI scan pre-fills the boxes and the office checks them. Also: a work permit card must not offer "Use For I-9".

## The rule
- **The office checks what the paper says.** It never signs anything on the panel and never types a full SSN or taxpayer ID. The signature boxes read "Their name as signed on the paper" and "Date they signed it", with "No office signature is needed."
- **The person enters anything secret themselves** (SSN or TIN, bank details) in My GFC, as already true for the SSN and bank details.

## What changed
- **W-9 on file without the number.** `normalizeFormOnFile('w9')` drops any TIN the office sends; the route never sets `p.tin`.
- **New Pay Setup item "Taxpayer ID for your 1099"** for a contractor whose W-9 is on file from paper. `PUT /api/my/pay-setup/tin`: checked with `checkSsn`/`checkEin`, sealed with `pc.seal`, `source: 'self'`, history says only "Taxpayer ID saved".
- **Pay and year end still need the number.** `missingForPay` lists "Taxpayer ID (they add it in Pay Setup)"; year end lists "Taxpayer ID"; onboarding's `payform:w9` is done only once it is entered.
- **Take Off File keeps a number the person entered themselves.** A number the office typed before today still goes with the paper.
- **AI pre-fill.** The AI scan schema asks for printed boxes only (`staffDocMatch.PREFILL_FIELDS`: filing status, amounts, allowances, name, classification, citizenship, first day, signed name and date). `cleanFields` is an allow-list and also drops anything shaped like an SSN, EIN or long ID number. On Mark On File the boxes start from the scan, marked "From the scan, check it" in amber until the office edits them. With Vertex off, the panel says "AI check not run: type what the paper says." The fields are on the document's `match` (non-secret, and the document is the person's own).
- **I-9 only from an I-9.** `ON_FILE_KINDS.i9` is `['i9']`. A work authorization document gets no Use For button.
- **Documents screen help** is three short lines: tax forms, the SSN rule, and other papers counting toward onboarding (bank details still entered by them).

## Verification
- `test/staff_doc_match.test.js`: 18 tests. 9 deliberate code breaks, all caught.
- Two older tests updated: the contractor fixture now carries a TIN (every W-9 had one before today), and the card keeps the "Hours & Pay" wording.
- Full suite: 3,906 tests, 0 failing.
- `scripts/verify_documents_on_file.js`: 25/25 through the real server. It covers:
  - the office's number is ignored;
  - the person's to-do appears;
  - a short number is refused;
  - saving shows the last 4, and the number is stored sealed;
  - the gate clears;
  - Take Off File keeps their number;
  - no number in the logs.
- Rendered in Chromium:
  - the W-4 panel pre-filled from a stand-in scan answer, where editing a box clears its mark;
  - the Documents help;
  - the Pay Setup to-do and form on an iPhone 13, 390px wide, with no page errors.

## Not proven from the sandbox
- Live Vertex reading real paper forms. Until it is on, the boxes start blank and the panel says so.
