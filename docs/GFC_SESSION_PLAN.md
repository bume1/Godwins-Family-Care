# GFC Build — Session Plan

**Revised 06/2026 — CLINICAL-FIRST.** First clinical (In-Home Primary Care) clients begin in 1–2 weeks, so the clinical line and its HIPAA go-live now build **before** the Private Home Care (PHCP) caregiver segment. The shared client portal + gated intake still comes first; then clinical; then PHCP.

Each session ends in a PR you review and merge. **Companion to** `GFC_App_Build_v2.md` (architecture) and, for the Session 4 clinical line, `GFC_Clinical_Completeness_Spec_v1.md` (clinician-capability coverage + P0/P1/P2 build order).

**Prototypes updated 07/2026.** The clinical EMR prototypes (`clinical-emr-prototype-v1.html`, `clinical-emr-mobile-prototype-v1.html`) and `patient-portal-prototype-v2.html` are the Session 4 build targets. See the prototype list in `GFC_App_Build_v2.md` §Companion specs.

---

## Status at a glance
| # | Session | Segment | Status |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs (**OpenEMR live, configurations in progress**) | Shared | 🟡 In progress — see `GFC_App_Build_v2.md` §15 for config items still open |
| 1 | Repo prep · rebrand · role model | Shared | ✅ Done (PR #2, #3) |
| 2 | Strip lab features · deactivate tracker · brand cleanup | Shared | ✅ Done (PR #5, 2026-06-10; cleanup follow-ups completed 07/2026) |
| 3 | Client portal + gated intake (both service paths) | Shared | ✅ Done — 3.1/3.2 (PR #6, #7), 3.2 field-parity + 3.4 Transfer-of-Care ROI (PR #13), 3.5 reconciliation (PR #15), 3.3 staff enrollment view + offline onboarding + care-tier migration (PR #16) |
| 4 | **Clinical / In-Home Primary Care portal + OpenEMR** | Clinical | 🟡 In progress — **4.1 clinician workspace ✅ Done (PR #19)**; **4.2 scheduling ✅ Done (PR #22)**; **4.4 clinical completeness P0 ⬜ next**; 4.3 patient clinical read ⬜ after 4.4 |
| 5 | **Clinical HIPAA go-live** (app → AWS boundary, MFA, audit, BAAs, **+ OpenEMR auth migration to authorization_code**) | Clinical | ⬜ Planned |
| 6 | Caregiver app | PHCP | ⬜ Planned |
| 7 | Scheduling · availability · time tracking | PHCP | ⬜ Planned |
| 8 | Matching engine | PHCP | ⬜ Planned |
| 9 | Messaging module (full channel matrix) | Shared | ⬜ Planned |
| 10 | Family portal | Shared | ⬜ Planned |
| 11 | RPM / Continuous Care monitoring (scaffold → later) | Shared | ⬜ Planned |
| 12 | Audit log UI + final HIPAA / BAA review | Shared | ⬜ Planned |
| B-series | Billing (Track D) — eligibility, patient payments, rate card, PHC invoicing, OpenEMR integration, clearinghouse, IME contractor invoicing | Billing | ⬜ Planned — session prompts to be defined in `GFC_Billing_Architecture_Spec_v1.md` (to be written); scope + phase order per v2 §13 |
| E-series | IME / C&P Track E — contractor exam capture, scheduling, hours rollup (feeds Track D B7) | IME | ⬜ Planned — spec per v2 §14 |

---

## Detail

**Track 0 — Infra (accelerated, critical path).** AWS account + BAA, OpenEMR on AWS (**live, configurations in progress** — see v2 §15), encrypted RDS, app hosting in the AWS boundary, Google Workspace BAA, secrets + MFA.

**Session 1 — Foundation.** ✅ Done. Rebrand, 6-role model + new fields, strip-list.

**Session 2 — Strip + deactivate + brand cleanup.** ✅ Done (PR #5). Lab modules removed, tracker deactivated, brand strings fixed. Cleanup follow-up: the dormant `service-portal.html` validation components were removed (PR #11); the lab HubSpot connector was **kept dormant, not removed** (intentional — reactivate on CRM upgrade; see CLAUDE.md). Ref: `strip-list.md` + `strip-list-DECISIONS.md`.

**Session 3 — Client portal + gated intake.** Shared front door for BOTH service paths (the intake branches PHC vs IHPC consents). 3.1 portal + gate (built, PR #6), 3.2 intake + consents (built, PR #7; full legacy field-parity build merged in PR #13), **3.3 staff enrollment-submissions view + offline patient onboarding + care-tier code migration (built, merged in PR #16)**, 3.4 Transfer-of-Care Provider ROI (built, merged in PR #13), 3.5 reconciliation — fixture-data removal, live per-client wiring, client-portal desktop layout (built, merged in PR #15; drift findings in `DRIFT_REPORT_2026-08-15.md`). Dev/test data only. Ref: `client-prototype-full.html`, `phcp-portal-prototype.html`, intake spec (`template-gfc-intake-3.php`), client schema. Session 3.4 additionally references the source-form pair `source-forms/gfc_roi_upload.gs` and `source-forms/template-gfc-roi-upload.php` and adds the `roiTransfer` consent status + `priorProviders` field group to the client schema.

**Session 4 — Clinical / In-Home Primary Care (PRIORITY).** OpenEMR integration (FHIR/OAuth2). Architecture: one patient record in OpenEMR, two role-scoped views over it — the clinician charts from a clinician-scoped view of the patient's chart (write), the patient sees a filtered read of the same record. **Visual build targets: `clinical-emr-prototype-v1.html` (desktop), `clinical-emr-mobile-prototype-v1.html` (mobile), `patient-portal-prototype-v2.html` (patient read).** Three sub-PRs:

- **4.1 Clinician workspace (OpenEMR write) — priority.** Patient list/search → open a patient's chart (clinician view) → document the initial comprehensive visit (H&P), medication reconciliation, problem list, care plan, notes — all writing to OpenEMR via FHIR. The app never duplicates the clinical record; it renders and edits OpenEMR's. Implements the clinical enrollment sequence: payer verification → records/ROI → NPA/prescriptive authority → initial visit → care plan + program layering (CCM / CCP / RPM-flag) → activation. Includes the primary-care enrollment branch consents (consent to treat, assignment of benefits, practice NPP) if not already covered in 3.2.
- **4.2 Clinician scheduling (OpenEMR-tied) — ✅ Done (PR #22, merged 2026-08-30).** Provider appointment management in the app, tied to OpenEMR's appointment/calendar so a booked visit is an OpenEMR appointment linked to the billable encounter. Same UX pattern as PHCP scheduling (Session 7) but its backend is OpenEMR, not the app shift store. (PHCP caregiver scheduling stays app/RDS — two scheduling systems by design.) Built: create/reschedule/cancel/no-show via tombstone swap (7.0.4 has no appointment update API — Bianca-approved deviation, see CLAUDE.md), live-calendar conflict rejection, provider day/week + admin unified views, chart appointment list with documented/no-show states, appointment↔encounter linkage pointers (`appointment_encounters`).
- **4.4 Clinical completeness P0 — next.** The set that makes `/clinical` carry a full visit end to end for first clinical test use: follow-up SOAP form, ICD-10-coded diagnoses, prescription recording (record only — e-prescribing out of scope), lab/imaging order capture (record only — **Quest HL7 interface deferred by owner decision**, transmission stays manual), encounter coding → OpenEMR fee-sheet/billing route, sign-and-close with addenda, and an attribution interim stamping the acting clinician's name + NPI until per-user auth lands in Session 5. Coding assist **T1 (problem-list carry-forward) + T2 (per-clinician usage-ranked favorites)** in scope; **T3 blocked on the billing consultant** confirming E/M documentation thresholds; T4 later. **OpenEMR is the source of truth for ICD-10 and CPT — the app never maintains its own code list.** Spec: `GFC_Clinical_Completeness_Spec_v1.md` (rev 1.1). Prompt: `GFC_Session4.4_ClaudeCode_Prompt.md`.
- **4.3 Patient portal clinical read + POA acting gates + case-manager scoped read — after 4.4.** The Session 3 portal shell surfaces the patient's own clinical data from OpenEMR (visit summaries, medications, care plan), filtered per sharing rules — not raw clinical notes. Read-only via the app's FHIR client, scoped to that patient. Not OpenEMR's native patient portal. Scope grew per owner decisions 08/2026 (v2 §4): the same scoped-read machinery also serves **case managers** (clinical read-rights, mutation UI hidden) and **POA-designated family** (`familyIsPoa` — client-equivalent view + acting gates: care-plan co-sign and messaging, signed as "POA for <client>"). Full detail in `GFC_Session4.3_ClaudeCode_Prompt.md`.

**Signed-PDF requirement (cross-cutting, Session 4+).** Every signable document generated by the app must render a PDF with **all of that document's captured digital signatures populated, per document, respectively** — the signature image embedded alongside signer name, timestamp, and IP. The care plan carries the client co-signature *and* the RN author signature; each consent carries its signer's signature; the Transfer-of-Care ROI already does this per provider (Session 3.4, the reference pattern). Carry-over: Session 3 captures and stores the care-plan co-signature image but does not yet render a signed care-plan PDF — Session 4 (4.1) must add it. Detail in `GFC_Intake_and_Packet_Spec_v1.md` §4.3.

**Session 5 — Clinical HIPAA go-live.** Move the clinical front end into the AWS boundary, PHI to OpenEMR/RDS, MFA for Admin/Clinical, audit-log persistence, PII-scrubbed logs, BAAs on file. The gate that lets the first clinical clients be seen compliantly. **Also in scope (added 08/2026): migrate the app↔OpenEMR auth from the dev-window password grant to authorization_code + refresh_token** (registered redirect URI on the API client, one-time clinician browser login, server-held refresh tokens) and disable the OpenEMR password-grant global.

**Session 6 — Caregiver app (PHCP).** The 4-tab mobile workspace, tier-branched visit log (Sitter/PCA/CNA/LPN), escalation, submission loop. Ref: `caregiver-app-prototype.html` + workspace spec.

**Session 7 — Scheduling · availability · time tracking (PHCP).** Availability submission, open-shift posting + matching, GPS clock-in/out, payroll export. *(Where caregivers submit availability.)* Ref: staff shift-scheduling screens in `phcp-portal-prototype.html`.

**Session 8 — Matching engine (PHCP).** Two-stage caregiver↔client matching. Ref: matching spec + schemas + staff Care Match screen in `phcp-portal-prototype.html`.

**Session 9 — Messaging module.** Full structured channel matrix with role-based visibility + escalation events.

**Session 10 — Family portal.** Read-only, ROI-gated, monitoring feed. Ref: family care-feed screens in `phcp-portal-prototype.html`.

**Session 11 — RPM / Continuous Care.** Track C; hooks scaffolded earlier, live build later.

**Session 12 — Audit log UI + final review.**

---

## Rough timeline
- **Now (updated 2026-09-04):** Sessions 1–4.2 merged (4.1 PR #19, 4.2 PR #22). Next: **Session 4.4 (clinical completeness P0)** per `GFC_Clinical_Completeness_Spec_v1.md` §6, then the P1 set — results review, clinical inbox, vitals/document re-tests after the EMR fixes, and Session 4.3 (patient clinical read + POA gates + case-manager read) — then Session 5 (clinical go-live: AWS boundary, auth migration, audit). Session 5 prompt work is paused by owner direction 2026-09-04.
- **After that:** first clinical clients live; then Sessions 6–8 (caregiver app, PHCP scheduling, matching).
- **Following weeks:** Sessions 6–10 (PHCP segment + shared), then 11–12.
