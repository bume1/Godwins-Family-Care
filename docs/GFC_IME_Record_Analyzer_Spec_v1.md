# IME record analyzer — spec v1

**Owner request, 2026-11-04.** Contract examiners need to read a claim file of hundreds or thousands of pages before a VA C&P exam. Build an in-app analyzer that reads the whole file with Gemini and returns a cited summary. VA C&P exams (LSGS, Leidos QTC, VES) come first. The design also covers private IMEs (attorneys, insurers, workers' comp), which ship later on the same engine.

**What it is not.** It never gives a medical opinion: no nexus ("at least as likely as not"), no rating, no diagnosis of its own, no DBQ answers. It finds and cites what the records say. The examiner forms the opinion.

---

## Gates before any code

1. **Written permission from each contractor: LSGS, Leidos QTC and VES (Veterans Evaluation Services)** to (a) store veteran claim-file records in GFC's systems and (b) process them with Google Gemini under GFC's Google Cloud BAA. File both with compliance records. Without it, nothing here is built for C&P. Private IMEs need only the referring party's engagement terms.
2. **Their retention rule.** How long GFC may keep a claim file after the exam report is submitted, and whether any copy may outlive that. This sets §6.
3. **A written decision** (`docs/decisions/YYYY-MM-DD-ime-record-analyzer.md`) changing `GFC_App_Build_v2.md` §14, which today allows no veteran health information in the app beyond the anonymized reference ID.
4. **38 U.S.C. 7332.** VA records about substance use treatment, HIV, sickle cell anemia and alcohol use carry their own redisclosure limits on top of HIPAA. Confirm with counsel and the contractor that examining for the claim is a permitted use. If it is not, those records are excluded from analysis.

---

## 1. Exam case

New collection `ime_cases` (PHI, registered in `dataMigration.js`).

| Field | Notes |
|---|---|
| `id` | |
| `caseType` | `va_cp` now; `private_ime` later |
| `referenceId` | the contractor's anonymized ID. Never a name, SSN or VA file number |
| `contractingEntity` | `lsgs`, `leidos_qtc`, `ves`, or the referring party for private IME. Each has its own permission, retention rule and portal |
| `examinerId` | the assigned FNP contractor |
| `claimedConditions` | list of conditions the exam covers, typed by the examiner. Focuses the summary |
| `examDate`, `reportSubmittedAt` | `reportSubmittedAt` starts the deletion clock |
| `status` | `open` → `report_submitted` → `purged` |

The case is not a GFC patient. It never links to a client record or OpenEMR, and never appears in the clinical workspace.

## 2. Upload

- Bulk upload, many PDFs at once, up to the app's per-file ceiling. Files are typed by their bytes. Image-only scans are accepted and read by Gemini.
- Stored in a private Drive folder per case (`GFC IME Cases/<case id>`), never link-shared, opened only through the app, with every read audited.
- Each document records page count, size, SHA-256 and who uploaded it.

## 3. Analysis

- New engine purpose `ime_record_review`, declared in `modelEngine.js`. It reuses the chart review's multi-pass split and merge. A file larger than one call is read in passes, and anything not read is listed.
- **Every item cites a document and page.** Uncited items are dropped and counted. Where a page has a text layer, the quote is checked against it. Image-only pages are marked `quoteVerified: false`.
- Every proposal goes to an append-only audit (see §6 for what it may hold).

**Output schema** (reject undeclared keys):

```
{
  chronology:   [ { date, facility, provider, eventType: enum visit | admission | procedure | imaging | lab
                    | prescription | injury | separation_exam | other,
                    summary, citation: { documentId, page }, quote } ],
  byCondition:  [ { claimedCondition,
                    diagnosesRecorded:   [ { text, date, citation, quote } ],
                    firstDocumented:     { date, citation, quote } | null,
                    inServiceEvents:     [ { text, date, citation, quote } ],
                    treatment:           [ { text, date, citation, quote } ],
                    currentSeverity:     [ { text, date, citation, quote } ],
                    functionalImpact:    [ { text, date, citation, quote } ] } ],
  medications:  [ { name, dates, citation, quote } ],
  notFound:     [ { claimedCondition, searchedFor } ],
  unreadable:   [ { documentId, pages, why } ]
}
```

`notFound` matters as much as what is found. It states that the file holds no record of a claimed condition, as an absence. It is never a conclusion.

**The instruction forbids** opinions, nexus language, ratings, DBQ answers, and any inference beyond what the page says.

## 4. Screens

- **Examiner:** their own case list. A case page with upload, a Run button, progress per pass, and results grouped by claimed condition and chronology. Each citation opens the PDF at that page.
- A standing banner on every result says it is an AI draft, unverified, and not part of the exam report.
- **Admin:** all cases, assignment, and the deletion log.

## 5. Access

- New capability `imeRecordReview`, held by the assigned examiner and admin only. Not case managers, clinical staff or billing.
- This extends Gemini decision 7 (licensed clinicians only) to licensed FNP contractors, for their own assigned cases. Record that in the §0 decision.
- 1099 contractors need app accounts with MFA (Session 5 rules apply).

## 6. Retention and audit

- Case documents and AI outputs are deleted automatically N days after `reportSubmittedAt`. N comes from the contractor's rule (gate 2). Default is 30 days until it is known. Deletion removes the Drive files, and the case moves to `purged`, keeping only its metadata.
- **The audit conflicts with the deletion rule.** On the clinical side, the coding audit keeps the full model proposal forever. Here, the contractor's rule likely forbids keeping veteran content after the file is deleted. So the IME audit keeps who, when, model, invocation id, document hashes, page counts and item counts, **and no content**, unless the contractor allows more. Owner and contractor decision.

## 7. Cost

A full claim file of 1,000+ pages runs several passes, likely a few dollars per case. Raise the Google budget before C&P volume starts, and track spend per case in the admin hub.

## 8. Build order

1. **IME-AI.1:** case, upload, private storage, access, deletion. No model.
2. **IME-AI.2:** analysis, citations, results screen, audit.
3. **IME-AI.3:** the `private_ime` case type. Same engine. Adds a referring-party record and that party's retention terms.

## 9. Open for the owner

- `GFC_App_Build_v2.md` §14 names only LSGS and Leidos QTC. VES belongs there too, for scheduling, exam logs and B7 invoicing; fold it in at the next docs pass.

- Gates 1 to 4.
- Whether examiners also get the claimed-conditions list from the contractor's portal, or type it.
- Whether a summary may ever be exported (PDF) or must stay in the app.
