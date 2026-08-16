# GFC App Build v2 — Master Plan

**Supersedes** `GFC_ClaudeCode_Prompt_v2.md` and `GFC_BuildPlan_v1.md` wherever they conflict, specifically the locked Next.js/Postgres stack and the two-line (PCS + VA) scope. This plan reflects the org expansion, the real repo, and the HIPAA architecture approved 06/2026.

**Scope revision — 07/2026.** The original v2 spec limited scope to PHCP + Clinical only and explicitly excluded billing. That is no longer accurate. GFC now operates three revenue-producing lines: **PHCP (Private Home Care)**, **Clinical (In-Home Primary Care via PCHP and HBPC programs)**, and **IME/C&P Contract Exams** for LSGS and Leidos QTC. Each has a distinct billing model, all three need first-class support in the app, and billing is now Track D of this plan. See §13 for the billing overview and §14 for the IME/C&P operational scope. OpenEMR is now considered live (configuration in progress); the FHIR integration in Track B and Track D can proceed on that basis.

---

## Companion specs (read alongside this)
This guide is the index and source of truth. The detail lives in:
- `GFC_Intake_and_Packet_Spec_v1.md` — Stage 1–3 intake / enrollment, consent set, clinician packet.
- `GFC_Caregiver_Workspace_Spec_v1.md` — caregiver app, tier-branched visit log, escalation, RBAC mapping.
- `GFC_Matching_Engine_Spec_v1.md` — caregiver ↔ client matching algorithm.
- `GFC_Client_Care_Profile_Schema_v1.md` — client data model (includes `careTeam`).
- `GFC_Caregiver_Profile_Schema_v1.md` — caregiver data model (includes `licenseLevel`).
- `docs/prototype/` — **visual reference prototypes** (sibling of `docs/design-system/`). Updated 07/2026:
  - `client-prototype-full.html` — full client journey: Stage 1 public assessment → Stage 2 token intake + branched consents → enrolled portal (care plan & co-sign, messages, documents). Session 3 build target.
  - `caregiver-app-prototype.html` — caregiver mobile app: home, schedule, license-branched visit logs (Sitter / PCA-CNA / LPN skilled), two-tap escalation. Session 6 build target.
  - `phcp-portal-prototype.html` — enrollment gate, unlocked client portal, family care feed, staff Care Match, staff shift scheduling. Reference for Sessions 3, 7, 8, 10.
  - `clinical-emr-prototype-v1.html` + `clinical-emr-mobile-prototype-v1.html` — clinician workspace over OpenEMR (desktop + mobile). **Session 4.1/4.2 build targets.**
  - `patient-portal-prototype-v2.html` — patient portal including the clinical read views. **Session 4.3 build target.**

  Code builds from the specs + design system; the prototypes show what the result should look like.

---

## Build priority (revised 06/2026) — CLINICAL-FIRST
First clinical (In-Home Primary Care) clients begin in 1–2 weeks, so the **clinical line builds before the PHCP caregiver segment**. Order: shared client portal + gated intake (Session 3) → clinical portal + OpenEMR (Session 4) → clinical HIPAA go-live (Session 5) → then the PHCP caregiver app, scheduling, and matching (Sessions 6–8). See `GFC_SESSION_PLAN.md`. The PHCP build detail in §5 still applies; it just executes after the clinical line (§6).

---

## 1. Locked decisions

| Decision | Resolution |
|---|---|
| Hosting for PHI | AWS, inside a signed BAA boundary. **Not Replit** — Replit does not sign a BAA and cannot hold PHI. |
| Clinical system of record | OpenEMR on AWS (FHIR R4 / REST). App is a front end over it, never the record. **Status: live, configurations in progress.** |
| Documents, consents, email | HIPAA Google Workspace (Drive + Gmail) under existing BAA. |
| Operational data (shifts, visit logs, messaging) | Encrypted AWS RDS Postgres, in-boundary. |
| Codebase | Keep the existing Express + CDN-React app. Re-host to AWS, swap the data layer. Not a rewrite. |
| Replit | Demoted to non-PHI only: marketing site + design prototyping. |
| Build tool | Claude design for the prototype UI. |
| **Billing system of record (clinical)** | OpenEMR. Charges, balances, ERAs live there. Portal is a read-through window with a payment trigger, never a second ledger. |
| **PHC invoicing method** | Automated. App generates invoice PDFs from time logs and rate cards, sends via HIPAA Google Workspace Gmail with a Stripe payment link. Payment status tracked in app RDS. |
| **IME / C&P billing** | App captures exam hours and anonymized veteran-reference IDs per provider; app generates the invoice to LSGS or Leidos QTC; contractor payments to FNPs handled by app-generated payment records, not by LSGS/Leidos directly. |
| **Patient payments (clinical)** | Stripe with strict PHI segregation. Neutral descriptors only. No BAA required under segregation; documented exception. |
| **Billing role visibility** | For now, **Admin only**. Reserved for future: **Owner** role (full access including billing), plus a **Billing/Coder** role (billing scope only). |
| **Payroll integration** | Deferred to backend later. Not in Track D scope for the initial billing build. |

### Timeline (clinical-first)
- **Clinical line live (first IHPC clients):** 1–2 weeks. Priority.
- **PHCP caregiver segment:** follows the clinical go-live.
- Shared client portal + gated intake (Session 3) lands before both.

---

## 2. Architecture

```
PUBLIC (no PHI)                 AWS BAA BOUNDARY                       GOOGLE WORKSPACE (BAA)
─────────────────              ──────────────────────                 ──────────────────────
Marketing site (Replit)        GFC App (Express + React)              Drive: consents, uploads
Public Assessment form  ──▶     ├─ Auth / RBAC / audit                Gmail: notifications
(lead capture, pre-PHI)         ├─ PHCP portal (client/family/cgvr)
                                ├─ Staff area (scheduling, visit log)
                                ├─ Encrypted RDS (operational PHI)
                                └─ FHIR client ──▶ OpenEMR on AWS (clinical record)
```

**Rule:** PHI lives in OpenEMR (clinical) or encrypted RDS (operational) or Drive (documents). It never lands in Replit or a personal Google account. The app brokers; it does not become the system of record for clinical data.

**PHCP does not depend on OpenEMR.** Personal-care data lives in RDS + Drive. Only the Clinical track needs OpenEMR. This is what lets PHCP ship first while OpenEMR is provisioned in parallel.

---

## 3. Tracks

### Track 0 — Infra (parallel, critical path)
Owner: AWS/OpenEMR setup. Everything HIPAA-live depends on this.
- AWS account + BAA via AWS Artifact.
- Provision OpenEMR (EC2 + RDS, encrypted, KMS). Enable FHIR/OAuth2 API. **Live; configurations in progress (see §15 for the config help needed for app UI integration).**
- Encrypted RDS Postgres for the app's operational data.
- App hosting on AWS (Elastic Beanstalk or ECS), TLS, secrets manager.
- Confirm Google Workspace BAA covers Drive + Gmail; provision a service account.
- Set real `JWT_SECRET`, MFA for Admin/Clinical.

### Track A — PHCP (Private Home Care), priority
Non-medical personal care: client + family + caregiver portal, gated intake. No OpenEMR dependency.

### Track B — Clinical (In-Home Primary Care via PCHP + HBPC)
Clinicians use the app as the front end to OpenEMR. Includes the RN clinician packet writing to OpenEMR. Full by week 3. Serves both PCHP (Personal Home Care Program) and HBPC (Home-Based Primary Care) service lines through the same clinical infrastructure — same OpenEMR records, same charts, same claims pipeline, differentiated by service line tag and billing rules.

### Track C — RPM / Remote Monitoring (post-revision)
Consent-gated remote patient monitoring with video. Built *after* the initial PHCP + Clinical revision ships. The hooks are scaffolded during the initial build so it drops in without rearchitecting (see §11).

### Track D — Billing (cross-cutting, phased)
Three billing patterns, one app. See §13 for the phase breakdown.
- **PHC invoicing.** Automated Google-Workspace Gmail send from time logs + rate card, Stripe payment link, RDS-tracked status.
- **Clinical claims (PCHP + HBPC).** OpenEMR generates the 837, clearinghouse transmits, ERA auto-posts in OpenEMR, portal is a read-through window. Patient copays via Stripe with strict PHI segregation.
- **IME / C&P contractor invoicing.** App captures exam hours per provider, generates GFC-to-LSGS/Leidos invoices, tracks contractor payment records to FNPs.

### Track E — IME / C&P Contract Exams
1099 FNP contractors performing disability evaluations under Loyal Source Government Services (LSGS) and Leidos QTC Health Services. See §14. The app owns scheduling, exam-hours capture, anonymized veteran reference IDs, contractor communication, and the invoicing/payment records that feed Track D. GFC bills the contracting entity; GFC pays the contractors from that revenue. Contractors are NOT paid directly by LSGS or Leidos.

---

## 4. Roles (6 today, 8 targeted with the billing role split)

| GFC role | Repo role | Action |
|---|---|---|
| **Owner (Founder / Executive Director)** | new: `owner` | **add (future)** — full access to everything Admin sees plus billing. Reserved for Bianca G. C. Ume, MD, MBA, MS. Not built now; scaffolded so `hasBillingAccess` reads cleanly. |
| Admin (operational owner) | `admin` | keep. Sees billing for now, until Owner + Billing/Coder roles are split. |
| Clinical (FNP) | `user` | repurpose |
| Caregiver (PCA) | `vendor` | repurpose |
| Client (PHC or IHPC) | `client` | keep |
| Case Manager | — | add |
| Family / Authorized Contact | — | add (read-only, ROI-gated) |
| **Billing / Coder** | new: `billing` | **add (future)** — billing scope only. No clinical read/write, no scheduling. Sees billing dashboard, claims status, invoices, payments. Not built now; permission scaffold via `hasBillingAccess`. |

The existing permission-flag pattern (`hasXAccess`) and per-request fresh-user lookup support this without re-architecting.

**New fields the roles need:** `caregiver.licenseLevel` (sitter/pca/cna/lpn), `hasClinicalAccess` (FNP), `hasBillingAccess` (Admin now, Owner + Billing/Coder later), `client.enrollmentStatus`, and `client.careTeam` (assignedFNPs, assignedCaseManager, primary/backup caregiver). Escalation routing and provider access both read `careTeam`. All admin-managed.

**Billing visibility rule.** Every billing route and every billing UI element checks `hasBillingAccess`. Today the only role with that flag is `admin`. When the Owner and Billing/Coder roles land, the same flag flips on for them without touching any billing route.

---

## 5. PHCP build (Track A) — the first week

### 5.1 Convert, don't rebuild
`public/portal.html` is today a lab client portal (Launch Milestones, Inventory, Soft-Pilot Checklist). Convert its sections:

| From (lab) | To (GFC PHCP) |
|---|---|
| Launch Milestones | Care plan summary + visit summaries |
| Inventory | **remove** |
| Customer Support | Messaging (client ↔ caregiver/admin/clinical) |
| Files | Documents & signed consents (Drive) |
| Soft-Pilot Checklist | **remove** |

### 5.2 Gated intake → enrollment (the hard requirement)
A client cannot reach any portal area until intake is complete.
- Add `enrollmentStatus` to the client user: `intake_pending → intake_complete → enrolled`.
- On every portal load (the app already does a fresh user lookup per request), if status is `intake_pending`, render only the intake workflow. Block all other routes at the API layer, not just the UI.
- Port `template-gfc-intake-3.php` (current version) into a React portal flow. For the prototype it can post to the current endpoint; for HIPAA-live it posts to the app API → RDS, with documents to Drive. **Retire the Google Sheet path for live PHI** (a Workspace Sheet is an acceptable interim only if it must stay).
- Family portal stays locked until ROI-family is signed. No manual override.

### 5.3 Intake → enrollment build plan (embedded)
Full field-level detail lives in `GFC_Intake_and_Packet_Spec_v1.md`. The build-relevant plan, folded in here:

**Three stages, one record.** Family self-reports in Stages 1–2; the RN verifies and signs in Stage 3 (Track B).

| Stage | Who | Where | Purpose |
|---|---|---|---|
| 1 Assessment | Family, public | marketing/dev (no PHI) | lead capture + service-line triage |
| 2 Intake & Enrollment | Family, token | app → RDS + Drive | self-reported PHI + e-signed consents |
| 3 Clinician Packet | RN, in home | app → OpenEMR | verified clinical assessment (Track B) |

**The gate.** `enrollmentStatus` on the client (`intake_pending → intake_complete → enrolled`). Until intake + consents are done, the portal renders only the intake flow; all other routes blocked at the API layer. Family portal stays locked until ROI-family is signed, no override.

**Consent set (e-signed, branched by service path), this is the enrollment step:**
- Both arms: HIPAA NPP acknowledgment, ROI split into family + provider, **Transfer-of-Care ROI (multi-provider record release; built in Session 3.4)**, Service Agreement (rewritten to cover both service lines, not "non-medical only"), Patient Bill of Rights & Self-Determination, emergency-treatment + financial-responsibility, crisis protocol (911/988), monitoring opt-in (inactive, feeds Track C).
- PHC only: financial agreement + PCA scope acknowledgment.
- IHPC only: consent to treat, assignment of benefits, practice NPP.
- Every consent: typed name + checkbox (or canvas signature for the Transfer-of-Care ROI) + server timestamp + IP; status stored per type; portal gate reads ROI-family. Transfer-of-Care ROI does NOT gate the portal.

**Field dispositions:**
- *Add to intake:* full insurance IDs / Medicaid #, advance-directive document upload, the consents above.
- *Move to Track B clinician packet:* vitals, systems exam, wound/pain assessment, home-hazard inventory, RN triage/tier + signature, care plan, med reconciliation, supervisory notes. Pre-filled from intake.
- *Retire (paper duplicated by digital intake):* Face Sheet demographics/insurance, Care Instructions checklist, standalone Medication Form, self-reportable assessment portions.

**Data-shape fixes:** structured medication rows (name/dose/route/frequency/prescribing provider/pharmacy), single DOB (derive age), Stage 2 PHI posts to RDS not a Google Sheet.

### 5.4 PHCP data model (RDS, in-boundary)
`clients` (incl. `enrollmentStatus`, `monitoringOptIn`, `careTeam`, `priorProviders`), `family_contacts`, `caregivers` (incl. `licenseLevel`), `consents` (status per type, including `roiTransfer`), `consent_events` + `consent_provider_authorizations` + `consent_records_categories` (parent/child for the multi-provider Transfer-of-Care ROI built in Session 3.4), `care_plans` (versioned), `visit_logs` (tier-branched), `messages`, `shifts`, `availability`, `escalation_events`, `monitoring_events` (scaffold, see §11), `audit_log`. Documents by reference to Drive, not stored in the DB.

**Document routing rule (07/2026).** Two document homes, each with a job. **Drive (BAA):** consents, intake paperwork, service agreements, and anything a client or family views through the portal — collected by the app, works across both service lines. **OpenEMR document area:** records *received for clinical care* (hospital discharge summaries, specialist reports, prior records obtained via ROI) for Track B clients — filed to the patient's chart via REST `POST /api/patient/:puuid/document` so the FNP has them chart-side. The typed clinical chart (notes, meds, problems, care plans) is OpenEMR data either way. Never split one category across both stores. Detail + verification row: `GFC_OpenEMR_Deploy_Setup_Guide_v2.pdf` Phase 10 and Appendix D.

### 5.5 Caregiver & clinician workspace
Detail in `GFC_Caregiver_Workspace_Spec_v1.md`. Repurpose the repo's service portal into two surfaces:
- **Mobile caregiver app** — 4-tab (Home, Feed, Clients, More). Where Sitters, PCAs, CNAs, and LPNs work.
- **Desktop clinician / FNP review** — the "Pending Review" inbox. Placeholder until OpenEMR connects.

One Caregiver role, `licenseLevel` drives scope. The **visit log branches by level**: Sitter (presence + behavioral), PCA (ADL/IADL + reminders, reminder-only on meds), CNA (+ competency-gated vitals, glucose, I&O), LPN skilled note (**built now**, marked Pending Review, routes to OpenEMR on connect). Skilled tasks never appear on the PCA/Sitter form.

**Escalation:** a persistent "Flag a concern" → concern type (clinical / behavioral / safety-urgent) → auto-routes to the patient's `careTeam` (FNP, case manager, admin) by severity, in-app/push/SMS, status tracked Raised → Received → Acknowledged → Resolved.

**Submission loop:** a submitted visit log fans out to the family monitoring feed, the FNP review inbox, and (if flagged) escalation events. Incidents (falls, abuse/neglect) spawn a separate incident report, not a checkbox.

### 5.6 Caregiver matching
Detail in `GFC_Matching_Engine_Spec_v1.md`. Two stages: **hard filters** (license/scope, lift capacity, credentials, geography, availability) build the eligible pool; a **weighted score** ranks it (the Care Match %). Deterministic and explainable, admin-tunable weights, tier-adjusted profiles, no ML in v1. Reads the client and caregiver schemas, so the caregiver profile must be populated to rank.

---

## 6. Clinical build (Track B) — PRIORITY, Session 4 (clinical-first)
**Model: one patient record in OpenEMR, two role-scoped views.** The clinician charts from a clinician-scoped view of the patient's chart (write); the patient sees a filtered read of the same record. The app is a front end over OpenEMR — it never duplicates the clinical record.

- Stand up the FHIR client against OpenEMR (OAuth2).
- **Clinician workspace (write):** patient list/search → open a patient's chart → document the initial comprehensive visit (H&P), med reconciliation, problem list, care plan, notes — all to OpenEMR. Received clinical records (per the §5.4 document routing rule) file to the patient's OpenEMR document area and surface in this workspace. **Integration is two-lane: FHIR for reads (and Patient write), OpenEMR's Standard REST API for most clinical writes (encounter, notes, vitals, problems, documents) — see the compatibility matrix in `GFC_OpenEMR_Deploy_Setup_Guide_v2.pdf` Appendix D; verify each row against the live server before coding.**
- **Clinician scheduling (OpenEMR-tied):** provider appointments managed in the app but tied to OpenEMR's appointment/calendar, so a booked visit is an OpenEMR appointment linked to the billable encounter. Same UX pattern as PHCP scheduling, **different backend** — clinical → OpenEMR, PHCP caregiver shifts → app/RDS. Two scheduling systems by design.
- **Patient portal clinical read (fast-follow):** the Session 3 portal shell surfaces the patient's own clinical data from OpenEMR (visit summaries, meds, care plan), filtered per sharing rules, read-only, scoped to that patient. Not OpenEMR's native portal.
- In-Home Primary Care intake branch + its medical consents (consent to treat, assignment of benefits, practice NPP).
- **Signed-PDF generation:** every signable document renders a PDF with **all of that document's captured digital signatures populated, per document, respectively** (signature image + signer name + timestamp + IP). Care plan → client co-signature *and* RN author signature; each consent → its signer's signature; Transfer-of-Care ROI → per-provider signature (built in 3.4, the reference pattern). Carry-over: Session 3 captures/stores the care-plan co-signature image but does not yet emit a signed care-plan PDF — add it here. Spec: `GFC_Intake_and_Packet_Spec_v1.md` §4.3.

---

## 7. Strip from the repo (lab-specific)
102-task CLIA template (`template-biolis-au480-clia.json`), inventory module, validation reports, service field reports, soft-pilot checklist, knowledge hub (lab docs). The launch/project-task tracker is not needed for PHCP; defer or strip.

## 8. Reuse (keep + rebrand)
JWT auth + RBAC + per-request fresh user lookup, login hub, client-login, document upload (re-point to Drive), announcements, messaging scaffold, PDF generation (repurpose for care plans/consents), HubSpot (public marketing leads only, pre-PHI), Resend → move to Workspace Gmail or AWS SES under BAA. Rebrand Thrive blue `#045E9F` to GFC navy `#033D50` / gold / cream, Cormorant + DM Sans.

---

## 9. HIPAA hardening — pre-prod gate before PHCP goes live (1.5 wk)
Grounded in the repo's own documented gotchas plus the move off Replit:
- Replace the weak default `JWT_SECRET`; require it from secrets manager.
- Replace Replit KV with encrypted RDS for all PHI.
- File uploads: forward to Drive/S3 (SSE), never persist PHI in memory or logs.
- Add a global error handler; PII-scrub logs (no PHI in logs or URLs — review the `?token=` download and slug-URL patterns).
- MFA for Admin and Clinical; 15-min inactivity logout.
- Audit log: remove the 500-entry truncation for PHI-access events; persist durably.
- Encryption at rest (RDS KMS, S3 SSE), TLS 1.2+ at the load balancer.
- BAAs on file: AWS, Google Workspace. Decide HubSpot — keep it to non-PHI marketing or get its BAA. Resend touches email; move notifications into the Workspace/SES BAA boundary.

---

## 10. Sequencing and dependencies (clinical-first)
1. **Now, accelerated:** Track 0 infra — OpenEMR live ~tonight, AWS boundary, BAAs. Front-loaded because clinical go-live is 1–2 weeks out.
2. **This week:** finish Session 3 (shared client portal + gated intake, both service paths) on dev/test data.
3. **This week → 1–2 wks:** Session 4 clinical portal + OpenEMR, then Session 5 clinical HIPAA go-live → first clinical clients live.
4. **Following weeks:** Sessions 6–8 PHCP caregiver app, scheduling, matching; then 9–12 (messaging, family, RPM, audit).

## 11. RPM / Remote monitoring (Track C, post-revision)

Consent-gated remote patient monitoring with in-home video, viewable by internal staff and, where shared, by the client/family portal. Built after the initial PHCP + Clinical revision ships, never before.

**Consent-gated, enforced, no exceptions.** Only clients with a signed monitoring opt-in (the consent scaffolded in §5.3) are eligible. No opt-in, no stream. Enforced at the API layer.

**Scaffold during the initial build** so it slots in later without rearchitecting:
- `monitoringOptIn` consent field on the client record (present, inactive).
- `monitoring_events` table: `client_id`, `timestamp`, `event_type` (motion / audio_alert / video_clip_reference), `reviewed_by`, `notes`.
- A "Monitoring" area in staff and client nav, labeled "Coming Soon."
- `POST /api/monitoring/event` stub that accepts and logs without processing.

**Build later (Track C):**
- Internal staff RPM dashboard: live and recorded in-home video for opted-in clients, plus the activity/event feed.
- Client/family monitoring view, scoped to their own record per sharing rules.
- Activity detection (motion/audio triggers); optional wearable data.
- HIPAA: all audio/video is PHI. Encrypted storage in the AWS boundary (S3 SSE/KMS), strict RBAC, full audit on every view, BAA-covered. Never on Replit, never outside the boundary.

## 12. Open items
- Tier vocabulary: **resolved** — adopt the Track A (A1–A4) / Track B enum and retire both "Tier 1/2/3" and "Triage Level" (intake spec v1.1 §3.2; live in code as `CARE_TIER_LABELS`, legacy 1/2/3 → A1/A2/A4).
- Counsel/licensure review of the rewritten consents before live.
- Who owns Track 0 (AWS/OpenEMR provisioning) and the start date — this sets whether 1.5 and 3 weeks hold.
- **OpenEMR configuration help needed** for app UI integration. See §15.
- **Billing vendor decisions — RESOLVED 07/2026:**
  - Clearinghouse: **Availity** (free tier for sponsored payers).
  - Eligibility API: **Availity** (same vendor, one integration).
  - Patient cost-share collection: **charge estimated at time of service, reconcile against ERA when it posts.**
  - PHC sliding-scale mechanism: **custom dollar amount per hour per client**, not percentage discount.
  - Pre-credentialing billing path: **self-pay + superbill** for payers GFC is not yet credentialed with. Availity handles credentialed payers; superbill handles the rest until credentialing completes.
  - Credentialing operations tool: **CAQH ProView** (free) to consolidate commercial-payer credentialing paperwork. Not a code decision.
- **Owner / Billing-Coder role split** — scaffold the flag now, decide when to activate the split (likely when a dedicated biller comes on staff).

---

## 13. Track D — Billing overview

Three distinct billing patterns, one app. Vendor stack locked. Detail spec `GFC_Billing_Architecture_Spec_v1.md` **is to be written before any B-session prompt is executed** — this section is the phase map, not the field-level detail. Phase summary:

- **B1 Eligibility check.** Real-time payer eligibility (270/271) via **Availity** API. Called from a client profile at intake and again before each visit. Returns coverage status, copay, deductible met/remaining, and effective dates onto the client record. Buildable now. No OpenEMR dependency.
- **B2 Patient payment (Stripe).** Card on file plus one-time charge for estimated copay at time of service. Reconciles against ERA when it posts. Strict PHI segregation: neutral descriptors only (e.g. "Office visit"), no clinical text in Stripe payloads. Automated test enforcement — the build fails if a diagnosis code, procedure code, or clinical term leaks into a Stripe payload, receipt, metadata field, or webhook. Buildable now.
- **B3 PHC automated invoicing.** From `time_logs` × `rate_card` (with `client_rate_overrides` applied), generate an invoice PDF, send via HIPAA Google Workspace Gmail with a Stripe payment link. Track paid/unpaid status in RDS. Depends on Session 7 (PHCP time tracking) and B4.
- **B4 Rate card + sliding-scale overrides.** Master `rate_card` table sets default rates keyed by `service_line` (PHC, PCHP, HBPC, IME), tier, unit, effective date, retirement date. Separate `client_rate_overrides` table holds per-client custom dollar amounts (sliding-scale) with reason code, effective date, retirement date. Invoice generator checks override first, falls back to card default. Clinical rates (PCHP, HBPC) are set by CMS fee schedule and payer contracts and are NOT subject to sliding scale — the `service_line` column enforces that separation. Foundational for B3 and B7.
- **B5 OpenEMR integration.** Read balances, post payments, ingest ERAs. OpenEMR is live; this phase wires the portal to it via FHIR/REST + OAuth2. See §15 for the OpenEMR configs Bianca needs help with.
- **B6 Clearinghouse (Availity) connection.** 837P out, 835 in, 999 + 277CA status codes handled. Configured inside OpenEMR pointing at Availity endpoints. Payer enrollment is done payer-by-payer inside the Availity portal, not in OpenEMR. Portal side is a claim-status dashboard for Admin. Depends on B5 and payer-by-payer Availity enrollment.
- **B7 IME / C&P contract invoicing.** From `exam_logs` (Track E) × contract terms, generate GFC-to-LSGS/Leidos invoice, track contractor payment records to FNPs from that revenue. Depends on §14 exam capture.

**Superbill + self-pay path (built as first-class, not a workaround).** For payers GFC is not yet credentialed with, the app supports a self-pay flow: patient pays through Stripe at time of service, the app generates a properly coded superbill (diagnosis codes, CPT/HCPCS procedure codes, rendering provider NPI, tax ID, dates of service) that the patient submits to their insurance for out-of-network reimbursement. This is the default clinical billing path until each payer's credentialing completes.

**Per-payer credentialing status (org level, not client level).** A `gfc_payer_credentialing` table holds one row per payer with:
- `payer_id`, `payer_name`, `payer_type` (medicare | medicaid | commercial | tricare | other)
- `credentialing_status`: `in_network` | `out_of_network` | `pending_credentialing` | `not_credentialed`
- `effective_date`, `expiration_date` (for periodic re-credentialing)
- `billing_npi_used` (Bethel's individual NPI or GFC organizational NPI when that enrollment lands)
- `notes`

Invoice/claim generator branches on this row (looked up via the client's `payer.carrier`):
- `in_network` or `out_of_network` → submit 837 through Availity
- `pending_credentialing` → hold claim, notify Admin
- `not_credentialed` → self-pay + superbill path

**Compliance guardrails (non-negotiable, apply across all phases):**
- Stripe carries neutral descriptors only. Automated tests fail the build if any diagnosis code, procedure code, or clinical term reaches a Stripe payload, receipt, metadata field, or webhook.
- Every billing operation writes to the existing `audit_log`.
- Every billing route checks `hasBillingAccess`.
- Bethel Godwins's individual NPI is a config-flag value (`BILLING_NPI`) on `gfc_payer_credentialing.billing_npi_used`, not a hardcoded string. When GFC's organizational Medicare enrollment lands, update the row per payer.

---

## 14. Track E — IME / C&P Contract Exams

1099 FNP contractors perform disability evaluations under Loyal Source Government Services (LSGS) and Leidos QTC Health Services. GFC is the contracting entity; contractors do NOT invoice LSGS/Leidos directly.

**App captures:**
- Exam schedule per provider (contractor calendar view, admin master calendar).
- Exam log per encounter: date, start/end time, exam type/category, veteran reference ID (anonymized — never full name or SSN in the app), contracting entity (LSGS or Leidos QTC), location or telehealth flag.
- Provider hours rollup per pay period.

**Feeds Track D:**
- B7 invoicing: GFC bills LSGS or Leidos based on exam category and completion, per each contract's rate structure.
- Contractor payment records: from GFC-received revenue, the app generates payment records for each FNP contractor showing exams performed, hours, and amounts owed. Actual disbursement handled by payroll integration (deferred, backend).

**RBAC and PHI rules:**
- Contractor sees only their own schedule and exam log.
- Admin sees everything, including all contractor schedules and rollups.
- No veteran PHI in the app beyond the anonymized reference ID. No exam findings, no health details.
- Messaging (Admin ↔ contractor) is subject-threaded, HIPAA-compliant, and PHI-free.

---

## 15. OpenEMR configurations that need help

OpenEMR is live but not fully configured for app UI integration. The following configurations are pending and Bianca has flagged she needs help on the more complex ones:

- FHIR / REST API + OAuth2 client registration for the app (Administration → Connectors).
- Practice + facility setup (GFC as billing entity vs. Bethel-individual-NPI rendering-provider split).
- Provider records for each FNP contractor (Track E) with correct NPI, taxonomy, and pay-tier attributes.
- Fee schedule import (feeds Track D B4 rate card cross-reference).
- **Availity clearinghouse profile** (Track D B6). Configure Availity as the outbound clearinghouse for 837P and inbound for 835. Payer enrollment is done payer-by-payer inside the Availity portal, not in OpenEMR.
- ERA auto-post configuration.
- User roles matched to app roles (Admin, Clinical, and future Billing).

**Operations (not code, but needed alongside):**
- **CAQH ProView profile** (free). Complete once; commercial-payer credentialing forms (BCBS GA, Aetna, UHC, Cigna, Humana, Anthem) auto-populate from it. Cuts weeks off each application. Bianca owns this.
- Prioritize credentialing by target patient population, not by trying to credential with every payer at once.

Session 4.1 kickoff should identify which of these are already done vs. still open and pull Bianca in for the ones flagged as complex.
