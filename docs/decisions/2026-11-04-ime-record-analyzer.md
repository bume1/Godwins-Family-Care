# The IME record analyzer, parts 1 and 2 (owner request, 2026-11-04)

Built from `docs/GFC_IME_Record_Analyzer_Spec_v1.md`. A contract examiner uploads a veteran's claim file before a VA C&P exam and Gemini reads it into a cited summary. **IME-AI.1** (case, upload, private storage, access, deletion) and **IME-AI.2** (analysis, citations, results screen, audit) are built. **IME-AI.3** (private IME) is not.

## The decision the spec asked for before building

- **`GFC_App_Build_v2.md` §14 is changed for this feature only.** §14 allowed no veteran health information beyond the anonymized reference ID. The analyzer needs the claim file itself. Owner decision, 2026-11-04: no contractor approval is required. Exam logs, scheduling and B7 invoicing keep the old rule. A pointer line was added under §14.
- **Gemini decision 7 is extended.** Decision 7 limits AI review to licensed clinicians. It now also covers licensed FNP contractors, for their own assigned cases only.
- **Retention: 30 days after the report, until the owner sets it** (`GFC_IME_RETENTION_DAYS`).
- **38 U.S.C. 7332: excluded until counsel says otherwise** (`GFC_IME_7332_CLEARED=true` lifts it). The model is told to leave out drug and alcohol abuse treatment, HIV and sickle cell records and list those pages as not read. A keyword backstop on the server drops anything that slips through and counts it. This is fail-closed on purpose. It may hide something an examiner needs; that is the safer error while the question is open.

## What a later session must not undo

- **The case is not a patient.** No client record, no OpenEMR, nothing in the clinical workspace. It lives on its own page, `/ime`. A test fails the build if `clinical.html` reads `/api/ime`.
- **Access is the assigned examiner and admin. Nobody else.** Not case managers, RNs, managers or billing. An examiner is an active user whose clinical role resolves to `provider`. An examiner can open a case only for themselves; only admin reassigns. Another examiner's case is a 403 by name, never an empty answer.
- **The reference ID is never a name, SSN or VA file number.** SSN and C-file shapes are refused by name. Drive folders are named by case id and stored files by a random name, never the uploaded filename.
- **Every item cites a document and page that exist, or it is dropped and counted.** The model cites the part it was shown (`doc:<id>` or `doc:<id>#p<from>-<to>`); the server turns that into the page in the original file, including when the transport splits a part again. A page outside the part does not resolve.
- **Quotes are checked against the page's text layer.** A match reads "Quote found on page". A scanned page reads "quote unverified". A quote that is not on a page that has text is **kept but flagged in red**, because the citation still resolves and the examiner should look. It is not hidden.
- **Opinion language in the model's own words is dropped.** "At least as likely as not", nexus, ratings, DBQ. It survives only when the record itself says it and the item quotes it, because a prior examiner's opinion in the file is a record.
- **The merge is deterministic, on the server.** The spec says reuse the chart review's split and merge. The split is reused in shape (page budget per pass, large files split by page range). The merge is NOT a second model call: this output is citations, and a model merge is a place a citation can be lost or an item invented. Concatenate, de-duplicate, sort by date.
- **`notFound` is derived, not reported.** A condition is "not found" only when nothing cited survived for it across every pass. One pass saying "not found" is about the pages that pass saw. Every row says it is an absence in the file, not a conclusion.
- **A failed pass costs only its pages**, which are listed as not read. A boundary refusal stops the whole run.
- **The IME audit holds no content** (`ime_analysis_audit`): who, when, model, invocation ids, document hashes, page counts, item counts, drop counts. A test fails if a quote, condition or filename appears in it.
- **Deletion:** N days after "Report Submitted", the sweep deletes the Drive files, clears every AI output, clears the claimed conditions (keeps their count) and the filenames, and writes `ime_deletion_log`. If any file cannot be deleted the case stays un-purged and the next sweep retries; a deletion record that says "purged" with a file still in Drive would be a lie. Runs daily and one minute after boot.
- **No uploads or runs after the report is submitted.** Admin can reopen a mis-click, with a reason, before the sweep runs.
- **The AI-draft banner comes from the server** on every result, so no screen can leave it off.

## Verified

- `test/ime_record_analyzer.test.js`, 24 tests. The whole job runs against a fake engine that validates with the real schema. 24 of 24 mutations caught; one survived first (a page past the end of a transport-split piece) and a test was added for it, and one of mine was a no-op and was replaced.
- `scripts/verify_ime_record_analyzer.js`, 28 of 28 through the real routes.
- `/ime` rendered in Chromium at 390px and 1100px, including a seeded result, with zero page errors and markup in a filename shown as text.
- Full suite 2781, 0 failing.

## Not proven from here

- That Drive stores a claim file and that Gemini reads one. No Google credential in the sandbox; the probe asserts the refusals. The admin hub's Run test for Gemini is still the go-live proof.
- How Gemini handles a real 1,000-page file. `GFC_IME_PAGES_PER_PASS` (default 300) sets pages per pass; tune it after the first real run.

## Open for the owner

1. **Retention period.** 30 days until you set `GFC_IME_RETENTION_DAYS`.
2. **38 U.S.C. 7332.** Ask counsel. Set `GFC_IME_7332_CLEARED=true` only if examining for the claim is a permitted use.
3. **Cost.** Raise the Google budget before C&P volume starts. Set `GFC_IME_PRICE_PER_MTOK_INPUT` and `GFC_IME_PRICE_PER_MTOK_OUTPUT` to see dollar estimates per case; until then the admin page shows token counts only.
4. **Contractor accounts.** Each 1099 examiner needs an app account with clinical role `provider`. MFA applies to them under Session 5 rules.
5. **Per-file limit is the app's 10 MB.** A large claim file has to be uploaded as several PDFs. Say if the limit should be raised for this page.
6. From the spec, still open: whether conditions come from the contractor's portal or are typed (typed today), whether a summary may ever be exported (it stays in the app today), and folding VES into §14 at the next docs pass.
