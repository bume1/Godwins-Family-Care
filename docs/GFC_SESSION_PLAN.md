# GFC Build — Session Plan

**Revised 06/2026 — CLINICAL-FIRST.** First clinical (In-Home Primary Care) clients begin in 1–2 weeks, so the clinical line and its HIPAA go-live now build **before** the Private Home Care (PHCP) caregiver segment. The shared client portal + gated intake still comes first; then clinical; then PHCP.

Each session ends in a PR you review and merge. **Companion to** `GFC_App_Build_v2.md` (architecture).

---

## Status at a glance
| # | Session | Segment | Status |
|---|---|---|---|
| 0 | Infra — AWS + OpenEMR + BAAs (accelerated; OpenEMR live ~tonight) | Shared | 🟡 In progress |
| 1 | Repo prep · rebrand · role model | Shared | ✅ Done |
| 2 | Strip lab features · deactivate tracker · brand cleanup | Shared | 📄 Prompt ready |
| 3 | Client portal + gated intake (both service paths) | Shared | 🔵 In progress — 3.1/3.2 built, **3.3 not complete** |
| 4 | **Clinical / In-Home Primary Care portal + OpenEMR** | Clinical | ⬜ Next priority |
| 5 | **Clinical HIPAA go-live** (app → AWS boundary, MFA, audit, BAAs) | Clinical | ⬜ Planned |
| 6 | Caregiver app | PHCP | ⬜ Planned |
| 7 | Scheduling · availability · time tracking | PHCP | ⬜ Planned |
| 8 | Matching engine | PHCP | ⬜ Planned |
| 9 | Messaging module (full channel matrix) | Shared | ⬜ Planned |
| 10 | Family portal | Shared | ⬜ Planned |
| 11 | RPM / Continuous Care monitoring (scaffold → later) | Shared | ⬜ Planned |
| 12 | Audit log UI + final HIPAA / BAA review | Shared | ⬜ Planned |

---

## Detail

**Track 0 — Infra (accelerated, critical path).** AWS account + BAA, OpenEMR on AWS (live ~tonight), encrypted RDS, app hosting in the AWS boundary, Google Workspace BAA, secrets + MFA. Now front-loaded because clinical go-live is 1–2 weeks out.

**Session 1 — Foundation.** ✅ Done. Rebrand, 6-role model + new fields, strip-list.

**Session 2 — Strip + deactivate + brand cleanup.** Remove the lab modules, deactivate (keep) the tracker, strip lab HubSpot routes, delete lab notification templates, fix brand strings. Ref: `strip-list.md` + `strip-list-DECISIONS.md`.

**Session 3 — Client portal + gated intake.** Shared front door for BOTH service paths (the intake branches PHC vs IHPC consents). 3.1 portal + gate (built), 3.2 intake + consents (built), **3.3 staff enrollment-submissions view (not complete)**. Dev/test data only. Ref: client prototype, intake spec (`template-gfc-intake-3.php`), client schema.

**Session 4 — Clinical / In-Home Primary Care (PRIORITY).** OpenEMR integration (FHIR/OAuth2). Architecture: one patient record in OpenEMR, two role-scoped views over it — the clinician charts from a clinician-scoped view of the patient's chart (write), the patient sees a filtered read of the same record. Three sub-PRs:

- **4.1 Clinician workspace (OpenEMR write) — priority.** Patient list/search → open a patient's chart (clinician view) → document the initial comprehensive visit (H&P), medication reconciliation, problem list, care plan, notes — all writing to OpenEMR via FHIR. The app never duplicates the clinical record; it renders and edits OpenEMR's. Implements the clinical enrollment sequence: payer verification → records/ROI → NPA/prescriptive authority → initial visit → care plan + program layering (CCM / CCP / RPM-flag) → activation. Includes the primary-care enrollment branch consents (consent to treat, assignment of benefits, practice NPP) if not already covered in 3.2.
- **4.2 Clinician scheduling (OpenEMR-tied) — priority.** Provider appointment management in the app, tied to OpenEMR's appointment/calendar so a booked visit is an OpenEMR appointment linked to the billable encounter. Same UX pattern as PHCP scheduling (Session 7) but its backend is OpenEMR, not the app shift store. (PHCP caregiver scheduling stays app/RDS — two scheduling systems by design.)
- **4.3 Patient portal clinical read — fast-follow.** The Session 3 portal shell surfaces the patient's own clinical data from OpenEMR (visit summaries, medications, care plan), filtered per sharing rules — not raw clinical notes. Read-only via the app's FHIR client, scoped to that patient. Not OpenEMR's native patient portal.

**Session 5 — Clinical HIPAA go-live.** Move the clinical front end into the AWS boundary, PHI to OpenEMR/RDS, MFA for Admin/Clinical, audit-log persistence, PII-scrubbed logs, BAAs on file. The gate that lets the first clinical clients be seen compliantly.

**Session 6 — Caregiver app (PHCP).** The 4-tab mobile workspace, tier-branched visit log (Sitter/PCA/CNA/LPN), escalation, submission loop. Ref: caregiver prototype + workspace spec.

**Session 7 — Scheduling · availability · time tracking (PHCP).** Availability submission, open-shift posting + matching, GPS clock-in/out, payroll export. *(Where caregivers submit availability.)*

**Session 8 — Matching engine (PHCP).** Two-stage caregiver↔client matching. Ref: matching spec + schemas.

**Session 9 — Messaging module.** Full structured channel matrix with role-based visibility + escalation events.

**Session 10 — Family portal.** Read-only, ROI-gated, monitoring feed.

**Session 11 — RPM / Continuous Care.** Track C; hooks scaffolded earlier, live build later.

**Session 12 — Audit log UI + final review.**

---

## Rough timeline
- **This week:** finish Session 3, build Session 4 (clinical) + Session 5 (clinical go-live).
- **1–2 weeks:** first clinical clients live.
- **Following weeks:** Sessions 6–10 (PHCP segment + shared), then 11–12.
