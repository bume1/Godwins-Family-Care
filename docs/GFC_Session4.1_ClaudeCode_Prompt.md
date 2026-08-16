# Session 4.1 — Claude Code Prompt
## Clinician workspace (OpenEMR write via FHIR)

**Prerequisite:** Session 3.5 merged (PR #15). Session 3.3 status: check the prerequisite gate in CLAUDE.md — if 3.3 is not merged, STOP and ask Bianca to run it or approve the skip before proceeding.
**Model:** Opus.
**Build targets:** `docs/prototype/clinical-emr-prototype-v1.html` (desktop), `docs/prototype/clinical-emr-mobile-prototype-v1.html` (mobile).
**Important:** TEST DATA ONLY. OpenEMR dev instance only — no real patient PHI until Session 5 go-live.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md at repo root
first and honor its prerequisite gate. Stack: Express (server.js), CDN React,
Replit KV, JWT. TEST DATA ONLY.

Branch: session/04.1-clinician-workspace

Read first, in full:
- CLAUDE.md (root) — note the Session 4 carry-over requirements in Current
  session focus: (a) care-plan authoring MUST write client.carePlan
  (versioned, starting at 1) — the portal renders "being prepared" until it
  exists and co-sign refuses until a real plan is on file; (b) the
  signed-PDF requirement below.
- docs/GFC_App_Build_v2.md §6 (clinical build), §2 (architecture), §15
  (OpenEMR config state)
- docs/GFC_SESSION_PLAN.md §Session 4
- docs/GFC_Intake_and_Packet_Spec_v1.md §2C (clinician packet fields), §4.2
  (IHPC consents), §4.3 (signature + signed-PDF rules)
- docs/GFC_Client_Care_Profile_Schema_v1.md (careTier A1–A4/B,
  openEmrPatientId, priorProviders, consents)
- docs/prototype/clinical-emr-prototype-v1.html and
  clinical-emr-mobile-prototype-v1.html (visual targets — reference art,
  never data sources)

PREFLIGHT (do this before any feature code)
1. OpenEMR connectivity: read OPENEMR_BASE_URL, OPENEMR_CLIENT_ID,
   OPENEMR_CLIENT_SECRET (or token) from env/secrets. Attempt OAuth2 client-
   credentials handshake and a FHIR metadata + Patient read against the dev
   instance. If credentials are missing or the handshake fails, STOP and
   give Bianca the exact list of what you need and where to put it
   (.env.example entries). Do not stub the integration silently.
2. Confirm which §15 config items are done in the OpenEMR instance (FHIR
   API enabled, practice/facility, provider records). Report gaps to Bianca
   before building against missing config.

ARCHITECTURE RULE (non-negotiable)
One patient record lives in OpenEMR. The app is a front end: it renders and
edits OpenEMR's record via FHIR R4. It NEVER duplicates the clinical record
into the KV store. The only clinical pointers stored app-side:
client.openEmrPatientId, client.carePlan (the versioned care-plan document
the portal renders + co-signs), and audit/activity entries.

SCOPE

A. FHIR client module (server-side)
- OAuth2 token management (refresh, expiry), base FHIR R4 resource helpers:
  Patient, Encounter, Condition (problem list), MedicationStatement /
  MedicationRequest, AllergyIntolerance, CarePlan, DocumentReference,
  Observation (vitals).
- All calls server-side; the browser never holds OpenEMR tokens.
- Every FHIR read/write logs to logActivity() with user, role, patientId,
  resource, action.

B. Clinician workspace UI (role: Clinical via hasClinicalAccess; Admin)
Desktop-first per clinical-emr-prototype-v1.html; responsive per the mobile
prototype.
- Patient list/search: clients with serviceLine IHPC (or both). Link/create
  the OpenEMR Patient (write openEmrPatientId on first link). Show sync
  status.
- Chart view per patient: demographics header (from app record), problem
  list, allergies, medications, encounters, care plan, documents — all read
  from OpenEMR live.
- Initial comprehensive visit (H&P) documentation: structured form per
  intake spec §2C (vitals incl. BP both arms, systems exam, skin/wound with
  measurements, PAINAD-style pain assessment, home-hazard inventory, RN
  triage/Track assignment) → writes Encounter + Observations + notes to
  OpenEMR. Pre-fill from the family's Stage-2 intake so the clinician
  confirms rather than re-keys; every pre-filled value is visibly marked
  until clinician-confirmed.
- Medication reconciliation: family-reported meds (app) side-by-side with
  OpenEMR MedicationStatements; clinician resolves; result writes to
  OpenEMR and updates the app's structured med rows.
- Problem list management → Condition resources.

C. Care plan authoring (the carry-over)
- RN authors the care plan in the workspace: problems, goals/objectives,
  task list, visit frequency, days/times, duration, charge-plan note,
  effective + target dates.
- Save writes BOTH: (1) OpenEMR CarePlan resource, (2) client.carePlan in
  the app store — versioned, starting at 1, prior versions retained. This
  unblocks the portal's care-plan view and co-sign flow from 3.5.
- Signatures: RN author signature (drawn, signature pad — same pattern as
  the 3.4 ROI) captured at save; client co-signature already captured via
  the portal flow.

D. Signed-PDF emission (carry-over requirement, spec §4.3)
- Every signable document renders a PDF with ALL of that document's captured
  signatures populated (signature image + printed name + timestamp + IP),
  per document respectively. This session: the signed care-plan PDF (RN
  author + client co-sign) emitted on co-sign completion, stored to Drive,
  referenced on the client record, DocumentReference written to OpenEMR.
  Follow the 3.4 per-provider ROI PDF as the reference pattern. Brand
  tokens: navy #033D50, gold #F5CD85, cream #FAF7F2, Cormorant + DM Sans.

E. Clinical enrollment sequence (v2 §6)
A per-patient checklist view driving IHPC activation: payer verification
(manual mark for now — B1 automates later) → records/ROI status (reads 3.4
transfer-ROI data) → NPA/prescriptive-authority confirmation → initial
visit done → care plan authored + co-signed → ACTIVATED. Each step:
who/when stamped. IHPC consents (consent to treat, assignment of benefits,
practice NPP) — verify 3.2 captures them; add only if missing.

DO NOT
- Duplicate clinical data into the KV store beyond the pointers named above.
- Build scheduling (4.2) or the patient clinical read (4.3).
- Touch billing, PHCP caregiver features, or messaging.
- Store OpenEMR credentials anywhere but env/secrets.
- Enter real PHI. Test data only.

ACCEPTANCE
- Preflight proves a live FHIR round-trip against dev OpenEMR (document it
  in the PR description).
- A test IHPC client can be linked to an OpenEMR Patient; chart renders
  live OpenEMR data; H&P visit writes Encounter + Observations; problem
  list and med-rec write through.
- Care-plan save produces client.carePlan v1 AND an OpenEMR CarePlan; the
  client portal now renders the real plan; co-sign completes and emits the
  signed PDF with both signatures, stored to Drive + DocumentReference.
- Enrollment checklist advances a test patient to ACTIVATED.
- Non-clinical roles get 403 on every clinical route (API layer).
- All FHIR access appears in logActivity(). App boots; Sessions 3.x flows
  unaffected.

Update CLAUDE.md per its running instruction. Open ONE PR titled
"Session 4.1: Clinician workspace (OpenEMR write)." Stop for review. Do not
start 4.2.
```
