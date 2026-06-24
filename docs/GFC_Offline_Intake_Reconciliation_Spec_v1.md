# GFC Offline Intake Reconciliation — Build-Ready Spec v1

**Purpose:** Onboard patients who were already taken on **offline** (paper packet or a separate e-sign system) without making them redo work in the app. Staff uploads the completed documents on a patient's record; the app reads and extracts them, reconciles what's already done against what enrollment requires, and chases **only the genuinely-missing items** in-portal.

**Companion to** `GFC_App_Build_v2.md` (architecture) and `GFC_Intake_and_Packet_Spec_v1.md` (the field-level intake + consent set this reconciles against). This doc holds the reconciliation model and workflow; the intake spec remains the source of truth for *which* fields and consents exist.

**Not legal advice.** Whether a consent signed in your prior system carries over, and which documents must be re-executed in-app, is a counsel/licensure decision — see §7 and §10.

---

## 0. Compliance posture (decided)

A completed intake PDF is PHI, and extracting it is *processing* PHI. Per `GFC_App_Build_v2.md` §1–2, **Replit is non-PHI only**; PHI lives in OpenEMR / encrypted RDS / HIPAA Drive inside the AWS BAA boundary.

- **Prototype (now, on Replit): TEST DATA ONLY.** Build and demo the full upload → extract → reconcile → notify UX with **synthetic test PDFs**. No real patient documents on Replit, ever.
- **Real version (AWS boundary, later):** uploaded PDFs land in HIPAA Drive (by reference); extraction runs server-side in-boundary; the AI extraction step uses a **BAA-covered Claude deployment with zero data retention**. Lands with/after the AWS move (Session 5).
- The notification email is **non-PHI** in both phases (link-only; no health or consent detail), consistent with the existing enrollment confirmation email.

---

## 1. The spine: one enrollment-requirements ledger

Stop modeling this as "consent statuses." Instead, **every item enrollment requires is one row in a single per-patient ledger** — data field, document, or consent — and each row carries the same shape. ROI is just one row among many.

### 1.1 Row shape
| Field | Meaning |
|---|---|
| `key` | `roiFamily`, `roiProvider`, `dob`, `medications`, `insuranceMemberId`, `advanceDirectiveDoc`, … |
| `kind` | `data` · `document` · `consent` |
| `status` | shared enum (§1.2) |
| `source` | provenance: `uploaded_doc:<docId>` · `patient_portal` · `staff_entry` · `external_system` |
| `evidence` | reference to the uploaded PDF (and page) backing an offline value |
| `value` / `signedAt` / `version` | the data itself, or signature date + consent version |
| `requiredVersion` | current required version of the item (drives the refresh override, §4.2) |
| `verifiedBy` / `verifiedAt` | the staff member who screened/confirmed an extracted value |
| `confidence` | extraction confidence; low values flag the row for review |

### 1.2 Status enum (shared across all kinds)
- `captured` — value present and verified (data fields).
- `on_file_offline` — satisfied by an uploaded offline document, with `evidence` + the real past date (consents, documents).
- `in_app` — completed/signed inside the app.
- `requested` — sent to the patient, awaiting them.
- `missing` — required, not yet satisfied.
- `na` — not applicable for this patient/service line.

### 1.3 "Satisfied" reduces to one boolean
- **consent** satisfied if `in_app` **or** `on_file_offline`.
- **data** satisfied if `captured`.
- **document** satisfied if uploaded (`on_file_offline` / `in_app`).

Everything downstream reads this one boolean — see §3.

---

## 2. Workflow (per-patient)

The trigger is **per-patient**, on the individual client record — not a bulk blast.

1. **Upload & classify.** Staff uploads one or more completed PDFs on the patient's record. The app classifies each (face sheet, signed consent, med list, assessment, …).
2. **Extract & screen (human-in-the-loop).** Claude reads each PDF and proposes structured values mapped to the intake schema (demographics, meds as *rows*, allergies, emergency contacts, insurance IDs) and detects which **consents are present and their signature dates**. Output is a **draft staff reviews and corrects** before it commits — "screen and populate," never blind auto-fill. Each proposed value is tagged `source: uploaded_doc:<id>` and starts `unverified`.
3. **Reconcile / gap analysis.** The app computes the ledger against the service-line requirement set and sorts every item into **on file** / **outstanding** / **N/A**.
4. **Notify (non-PHI).** A link-only nudge (Resend) tells the patient to open the portal and finish the outstanding items.
5. **Complete in portal.** The patient fills/signs only what's outstanding; rows flip to `in_app`; enrollment advances when the required set is satisfied.

---

## 3. What derives from the ledger — and only the ledger

1. **The enrollment gate.** Today it hard-checks `roiFamily === 'signed'`. Generalize to **"all required items satisfied (by any provenance)."** ROI-family is no longer special-cased; it is one required row. The family-portal ROI rule still holds: family access requires `roiFamily` satisfied, now including `on_file_offline`.
2. **The outstanding list.** Every row with `missing` or `requested`. This single list drives **both** the patient's in-portal "Action needed" checklist **and** the notification email contents.

There is no second source of truth. Add a required field or consent later and upload/extract/reconcile/notify all work on it for free.

---

## 4. The rules that make it general (not ROI-specific)

### 4.1 Staff verification is the trust anchor
An AI-extracted value lands as `unverified` and only becomes `captured` after staff screens it. Low-confidence extractions are flagged. Applies to **every `data` row**, not just consents.

### 4.2 Version / refresh override
Some items must be redone in-app **even if on file** — e.g. the **rewritten Service Agreement** (language changed per intake spec §4.1, so a prior signature is stale), or a field whose required shape changed. Encode as `requiredVersion`: if the on-file version `<` current required version, the row flips from `on_file_offline` back to `outstanding`. One mechanism serves consents (version bump) and data (schema change) identically.

### 4.3 Branched required-set
Generalize the existing `consentDefsForServiceLine` into one `enrollmentRequirements(serviceLine)` definition covering required **fields + documents + consents** for PHC vs IHPC. The ledger is computed against it.

### 4.4 Provenance precedence
When a value exists from more than one source, precedence is: **staff-verified > patient-portal > extracted-draft**. Staff verification always wins; an unverified extraction never overwrites a verified or patient-entered value silently.

---

## 5. Worked examples (same engine, different rows)
- **ROI-family** — signed in your prior system → `on_file_offline` with the uploaded PDF as evidence → **satisfies the gate, no re-sign.**
- **ROI-provider** — never existed offline → `missing` → `requested` → patient signs in-app.
- **Service Agreement** — old version signed offline, but language was rewritten → `requiredVersion` mismatch → `outstanding`, re-signed in-app.
- **DOB** — not on the paper → `missing` → patient enters once; age derived (intake spec §3).
- **Medications** — prose on the face sheet → extracted, but must become structured rows → staff restructures (`captured`) or kicks to patient (`outstanding`).
- **Insurance member ID / Medicaid #** — present on the uploaded face sheet → `captured`; absent → `outstanding`.
- **Advance-directive document** — the upload itself is the evidence → uploaded = satisfied; else `missing`.

---

## 6. Notifications (non-PHI, Resend)
- One per-patient nudge referencing the **outstanding list only**, link to the portal, **no PHI** (no diagnoses, no consent content). Mirror the existing `sendEnrollmentConfirmation` pattern and brand styling.
- Resend has no BAA on standard tiers (`GFC_App_Build_v2.md` §8); keeping these emails non-PHI is what makes them safe pre-BAA. The signed/extracted content lives in the portal, never in email.
- Requires (yours to set, see `GFC_App_Build_v2.md` §0/§9): `RESEND_API_KEY` in Secrets, verified sending domain `godwinsfamilycarellc.com` (DKIM + SPF/MX on the `send.` subdomain + DMARC), `EMAIL_FROM_ADDRESS` on that domain.

---

## 7. Consent provenance — counsel-gated specifics
Carrying a consent over from a prior system, vs. requiring a fresh in-app signature, is a legal/licensure decision. Default rules (confirm with counsel before live):
- Carry over (`on_file_offline`): HIPAA NPP acknowledgment, ROI-family, prior unchanged consents with valid signatures.
- Re-execute in-app regardless (`requiredVersion`): the **rewritten Service Agreement**, the **new provider ROI**, and the IHPC medical consents (consent to treat, assignment of benefits, practice NPP) if they didn't exist in the prior packet.

---

## 8. Data model additions
- Per-client `enrollmentLedger` (or computed-on-read from `intake` + `consents` + uploaded-doc provenance against `enrollmentRequirements(serviceLine)`).
- Extend consent records with `provenance`, `evidence` (doc ref), and a real `signedAt` that may be a past (offline) date.
- A **document-extraction job** record per uploaded PDF: classification, proposed values, confidence, `verifiedBy`/`verifiedAt`, status.
- Documents by reference to Drive (real) / test storage (prototype) — never the PDF bytes in the KV store.

---

## 9. AI extraction approach (high level)
- Document classification + structured field extraction via **Claude**, returning values constrained to the intake schema (structured output / tool use), not free text.
- **Human-in-the-loop is mandatory:** extraction proposes, staff disposes. Nothing commits to the record unverified.
- Exact model and API selected at build time per the `claude-api` reference. **Real extraction runs only inside the AWS/BAA boundary on a zero-retention, BAA-covered deployment.** Prototype extraction on Replit uses synthetic test PDFs only.

---

## 10. Audit
Every status/provenance change — upload, extraction, staff verification/override, consent carry-over, notification sent — writes an audit entry (who, when, source, old→new). For PHI-access events this must be durable (no 500-entry truncation) per `GFC_App_Build_v2.md` §9.

---

## 11. Sequencing (proposed — your call)
This is bigger than 3.3 and overlaps it (the staff enrollment view is where upload/screen/reconcile live). Given clinical-first — first IHPC clients in 1–2 weeks, arriving with paper/offline docs — this is plausibly **how those first clients get onboarded fast**.

Proposed split:
- **Prototype now (test data):** the ledger model, per-patient upload UI, reconcile view, outstanding-list portal card, non-PHI notification — all on synthetic PDFs.
- **Real handling later (AWS boundary, ~Session 5):** real PDF storage to Drive, in-boundary extraction on a BAA-covered Claude, real patient documents.

Suggested label: **Session 3.4 — Offline Intake Reconciliation** (after 3.3 staff enrollment view), or its own named track. Final sequencing is yours.

---

## 12. Open decisions
- ~~Real PDFs on Replit?~~ — **resolved: test data only on Replit; real document handling in the AWS boundary.**
- Counsel sign-off on consent carry-over vs. re-execute rules (§7).
- Extraction scope v1: which document types first (signed consents only, or full face sheet + meds)?
- Whether reconciliation also pre-fills the Stage 3 clinician packet (intake spec §2C) or stops at Stage 2.

---

## 13. Acceptance criteria (for the eventual build)
- Staff can upload completed PDF(s) on a single patient's record; each is classified.
- Extraction produces a reviewable draft; nothing commits until staff verifies.
- The ledger computes satisfied/outstanding across data, documents, and consents against the service-line requirement set.
- An already-signed offline ROI-family satisfies the gate **without re-signing**; only genuinely-outstanding items are requested.
- The version/refresh override forces re-execution of the rewritten Service Agreement even when an old one is on file.
- The patient receives a **non-PHI** notification listing only outstanding items; the portal shows the same checklist.
- Enrollment advances when the required set is satisfied by any provenance.
- All of the above demonstrated on **test data**; no real PHI on Replit.
