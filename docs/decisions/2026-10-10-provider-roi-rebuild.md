# The provider ROI rebuilt: one clean page per provider, and only the providers that need one

Owner report (2026-09-30, fix directed 2026-10-10): the Transfer-of-Care provider ROI was producing many PDFs, each with broken information.

**What was wrong (all confirmed by rendering a real PDF and reading it back):**
- **Every checkbox printed as "&".** The ☑/☐ characters cannot be drawn in the PDF's built-in Helvetica, so ticked and unticked boxes looked the same. A provider could not tell which records were requested, and **the specially protected line (mental health, substance use, HIV, genetic) read as authorized even when the patient said no.** Every release sent before this fix carries that ambiguity.
- The form ran to two pages, with the signature alone on page 2 and no patient or provider name on it.
- The patient's identity printed whatever the browser sent, not what was on file.
- Every past provider was pre-filled and re-sent on every submission, and two spellings of one office ("Dr. Smith" / "dr smith") were two providers. Hence the pile of PDFs.
- No fax check. The expiration date was free text and was never reconciled with the one-year limit the form states.
- Opening a release from the chart handed back a private Drive link that opened nothing, and a release whose Drive upload failed had no copy at all.

**What was decided, and must not be undone:**
- **Checkboxes are DRAWN** (an outlined box, a stroked check). The protected-information answer is **also written in words** ("NOT AUTHORIZED: do not release…" / "YES: … IS authorized"), so it survives a fax that loses the box. No font glyph stands in for a checkbox (build-enforced).
- **One page.** Field values wrap rather than being cut off, free-text fields are capped at 200 characters, and the patient, DOB and provider are printed top and bottom of every page with "Page X of Y".
- **The patient's identity comes from the record** (`roiPatientIdentity`). A typed value only fills a blank. Name and DOB are required. The identity is stored on the event (`patient_snapshot`), so a later copy reprints what was signed.
- **One provider per office.** `roiRepo.providerKey` ignores case, punctuation and a leading "Dr". Duplicates in one submission merge, filling blanks. The saved provider list and the prefill de-duplicate the same way.
- **A provider with a release still in force is not pre-filled.** The form lists them under "You already authorized these providers" with **Request again**.
- **A fax must be 10 digits or blank.** Blank is allowed, the patient is warned, and the response names providers still missing a fax.
- **The expiration is a real date, after today, and never later than one year from signing.** The PDF prints the date that actually applies, never a blank.
- **Everything is checked and every PDF is rendered before anything is written.** A render failure saves nothing (`ROI_PDF_FAILED`). A Drive failure is reported (`storageFailed`) and is not fatal, because every release now **re-renders from its stored records** on the chart, the patient record and the patient's own download (`GET /api/gfc/transfer-roi/authorizations/:authId.pdf`). The form tells the signer they are entitled to a copy; this is where they get it.
- The confirmation email goes only to addresses on file (the request's `submitterEmail` is gone). The admin email carrying the PDFs is marked `{ phi: true }`.

**Verified:**
- `test/roi_rebuild.test.js`, 16 tests. **11 of 11 mutations were caught.**
- Two existing tests were repointed: `chart_documents` (a release with no Drive copy now opens) and `bug_sweep_0929` (the address now comes from `cleanText`).
- `scripts/verify_roi.js`, **36/36 through the real routes**, stored values read back. The PDF is checked for page count and the number of drawn ticks.
- `verify_enrollment_admin_edit.js` 85/85. The full suite runs 2028 tests with 0 failing.
- The portal form was rendered in Chromium.

**Open for the owner:**
- **Releases already sent were ambiguous on every checkbox, the protected line included.** Consider re-sending the ones that went out. Every stored release now reopens as a corrected PDF from the chart.
- Revocation is still not built (the `revoked_at` field exists).
