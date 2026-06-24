# GFC App Build v2 — Master Plan

**Supersedes** `GFC_ClaudeCode_Prompt_v2.md` and `GFC_BuildPlan_v1.md` wherever they conflict, specifically the locked Next.js/Postgres stack and the two-line (PCS + VA) scope. This plan reflects the org expansion, the real repo, and the HIPAA architecture approved 06/2026.

---

## Companion specs (read alongside this)
This guide is the index and source of truth. The detail lives in:
- `GFC_Intake_and_Packet_Spec_v1.md` — Stage 1–3 intake / enrollment, consent set, clinician packet.
- `GFC_Caregiver_Workspace_Spec_v1.md` — caregiver app, tier-branched visit log, escalation, RBAC mapping.
- `GFC_Matching_Engine_Spec_v1.md` — caregiver ↔ client matching algorithm.
- `GFC_Client_Care_Profile_Schema_v1.md` — client data model (includes `careTeam`).
- `GFC_Caregiver_Profile_Schema_v1.md` — caregiver data model (includes `licenseLevel`).
- `docs/prototype/` — **visual reference prototypes** (sibling of `docs/design-system/`). Three files: `client-prototype-full.html` (full client journey — Session 3 build target), `caregiver-app-prototype.html` (caregiver app — Session 4 build target), and `phcp-portal-prototype.html` (gate, family monitoring, and the staff Care Match screen — reference for both). Code builds from the specs + design system; the prototypes show what the result should look like.

---

## Build priority (revised 06/2026) — CLINICAL-FIRST
First clinical (In-Home Primary Care) clients begin in 1–2 weeks, so the **clinical line builds before the PHCP caregiver segment**. Order: shared client portal + gated intake (Session 3) → clinical portal + OpenEMR (Session 4) → clinical HIPAA go-live (Session 5) → then the PHCP caregiver app, scheduling, and matching (Sessions 6–8). See `GFC_SESSION_PLAN.md`. The PHCP build detail in §5 still applies; it just executes after the clinical line (§6).

---

## 1. Locked decisions

| Decision | Resolution |
|---|---|
| Hosting for PHI | AWS, inside a signed BAA boundary. **Not Replit** — Replit does not sign a BAA and cannot hold PHI. |
| Clinical system of record | OpenEMR on AWS (FHIR R4 / REST). App is a front end over it, never the record. |
| Documents, consents, email | HIPAA Google Workspace (Drive + Gmail) under existing BAA. |
| Operational data (shifts, visit logs, messaging) | Encrypted AWS RDS Postgres, in-boundary. |
| Codebase | Keep the existing Express + CDN-React app. Re-host to AWS, swap the data layer. Not a rewrite. |
| Replit | Demoted to non-PHI only: marketing site + design prototyping. |
| Build tool | Claude design for the prototype UI. |

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

## 3. Three tracks

### Track 0 — Infra (parallel, critical path)
Owner: AWS/OpenEMR setup (pending). Everything HIPAA-live depends on this.
- AWS account + BAA via AWS Artifact.
- Provision OpenEMR (EC2 + RDS, encrypted, KMS). Enable FHIR/OAuth2 API.
- Encrypted RDS Postgres for the app's operational data.
- App hosting on AWS (Elastic Beanstalk or ECS), TLS, secrets manager.
- Confirm Google Workspace BAA covers Drive + Gmail; provision a service account.
- Set real `JWT_SECRET`, MFA for Admin/Clinical.

### Track A — PHCP (Private Home Care), priority
Non-medical personal care: client + family + caregiver portal, gated intake. No OpenEMR dependency.

### Track B — Clinical (In-Home Primary Care)
Clinicians use the app as the front end to OpenEMR. Includes the RN clinician packet writing to OpenEMR. Full by week 3.

### Track C — RPM / Remote Monitoring (post-revision)
Consent-gated remote patient monitoring with video. Built *after* the initial PHCP + Clinical revision ships. The hooks are scaffolded during the initial build so it drops in without rearchitecting (see §11).

---

## 4. Roles (6-role model on the repo's 4)

| GFC role | Repo role | Action |
|---|---|---|
| Admin (Owner/MD) | `admin` | keep |
| Clinical (FNP) | `user` | repurpose |
| Caregiver (PCA) | `vendor` | repurpose |
| Client (PHC) | `client` | keep |
| Case Manager | — | add |
| Family / Authorized Contact | — | add (read-only, ROI-gated) |

The existing permission-flag pattern (`hasXAccess`) and per-request fresh-user lookup support this without re-architecting.

**New fields the roles need:** `caregiver.licenseLevel` (sitter/pca/cna/lpn), `hasClinicalAccess` (FNP), `client.enrollmentStatus`, and `client.careTeam` (assignedFNPs, assignedCaseManager, primary/backup caregiver). Escalation routing and provider access both read `careTeam`. All admin-managed.

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
- Both arms: HIPAA NPP acknowledgment, ROI split into family + provider, Service Agreement (rewritten to cover both service lines, not "non-medical only"), Patient Bill of Rights & Self-Determination, emergency-treatment + financial-responsibility, crisis protocol (911/988), monitoring opt-in (inactive, feeds Track C).
- PHC only: financial agreement + PCA scope acknowledgment.
- IHPC only: consent to treat, assignment of benefits, practice NPP.
- Every consent: typed name + checkbox + server timestamp + IP; status stored per type; portal gate reads ROI-family.

**Field dispositions:**
- *Add to intake:* full insurance IDs / Medicaid #, advance-directive document upload, the consents above.
- *Move to Track B clinician packet:* vitals, systems exam, wound/pain assessment, home-hazard inventory, RN triage/tier + signature, care plan, med reconciliation, supervisory notes. Pre-filled from intake.
- *Retire (paper duplicated by digital intake):* Face Sheet demographics/insurance, Care Instructions checklist, standalone Medication Form, self-reportable assessment portions.

**Data-shape fixes:** structured medication rows (name/dose/route/frequency/prescribing provider/pharmacy), single DOB (derive age), Stage 2 PHI posts to RDS not a Google Sheet.

### 5.4 PHCP data model (RDS, in-boundary)
`clients` (incl. `enrollmentStatus`, `monitoringOptIn`, `careTeam`), `family_contacts`, `caregivers` (incl. `licenseLevel`), `consents` (status per type), `care_plans` (versioned), `visit_logs` (tier-branched), `messages`, `shifts`, `availability`, `escalation_events`, `monitoring_events` (scaffold, see §11), `audit_log`. Documents by reference to Drive, not stored in the DB.

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
- **Clinician workspace (write):** patient list/search → open a patient's chart → document the initial comprehensive visit (H&P), med reconciliation, problem list, care plan, notes — all to OpenEMR.
- **Clinician scheduling (OpenEMR-tied):** provider appointments managed in the app but tied to OpenEMR's appointment/calendar, so a booked visit is an OpenEMR appointment linked to the billable encounter. Same UX pattern as PHCP scheduling, **different backend** — clinical → OpenEMR, PHCP caregiver shifts → app/RDS. Two scheduling systems by design.
- **Patient portal clinical read (fast-follow):** the Session 3 portal shell surfaces the patient's own clinical data from OpenEMR (visit summaries, meds, care plan), filtered per sharing rules, read-only, scoped to that patient. Not OpenEMR's native portal.
- In-Home Primary Care intake branch + its medical consents (consent to treat, assignment of benefits, practice NPP).

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
- ~~Tier vocabulary: adopt app Tier 1/2/3, retire "Triage Level"~~ — **resolved (intake spec v1.1):** adopt the canonical **Track A (A1–A4) / Track B** enum; retire both "Care Tier 1/2/3" and "Triage Level," mapping legacy labels per `GFC_Intake_and_Packet_Spec_v1.md` §3.2.
- Counsel/licensure review of the rewritten consents before live.
- Who owns Track 0 (AWS/OpenEMR provisioning) and the start date — this sets whether 1.5 and 3 weeks hold.
