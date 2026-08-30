# Session 4.3 — Claude Code Prompt
## Patient portal clinical read + POA acting gates + case-manager scoped read

**Prerequisite:** Sessions 4.1 (PR #19) and 4.2 (PR #22) merged.
**Model:** Opus (scope grew past 4.1's original outline — see below).
**Build target:** `docs/prototype/patient-portal-prototype-v2.html`.
**Important:** TEST DATA ONLY.

---

## Known state carried in (do not re-discover)

**From 4.1 (PR #19):**
- Reuse `openemr.js` (auth + transport) and `clinicalRepository.js`. Do not build a second auth path.
- Reads via FHIR R4; writes via standard REST. 4.3 is read-only, so FHIR covers it.
- Access rule: clinical read is 403 until the client is linked (`openEmrPatientId`), on the clinical line, and consent-to-treat is on file (schema §6).
- Signed care-plan PDF is written to **three** places: Drive folder "GFC Care Plans" (reference on `client.carePlanDocs`), OpenEMR Documents, and the client record. **Drive is the reliable source** — serve the patient download from `client.carePlanDocs`, not from OpenEMR Documents (see defect below).
- Care plan is versioned from 1, prior versions in `care_plan_versions`.

**From 4.2 (PR #22):**
- OpenEMR is the only appointment ledger; app holds `appointment_encounters` linkage pointers only.
- Appointment states: documented / no-show / not-yet-documented. Reschedule and cancel use the **tombstone swap** — a rescheduled appointment leaves a tombstone and a new row. **The patient-facing list must show only the live appointment, never the tombstone.**
- **Deploy action still pending (not this session's job, but do not break it):** `OPENEMR_CLIENT_ID`/`OPENEMR_CLIENT_SECRET` need swapping to the appointment-scoped OAuth client. If appointment reads 401 in preflight, that swap has not happened — report it, do not work around it.

**Open EMR-server-side defects (maintainer's, not app code — write-up in `docs/OPENEMR_SERVER_DEFECTS_2026-08.md`):**
- Document endpoints 500 on a SQL binding bug (`DocumentService.php:92`); `POST /fhir/DocumentReference` 404s. **Consequence for 4.3:** do not try to read the care-plan PDF back out of OpenEMR Documents. Serve it from the Drive reference on `client.carePlanDocs`. That path works today.
- Vitals REST endpoint 500s unconditionally; vitals readings live verbatim in the encounter note. **Consequence for 4.3:** if a vitals display is built, source it from the note or omit the section — do not surface an empty vitals panel.
- Org-level reads (Practitioner / Organization / Coverage) return 403 — the `gfc-app-api` ACL covers clinical sections only. **Consequence for 4.3:** the rendering provider's name may not be resolvable via FHIR Practitioner. Fall back to the provider name stored on the app-side visit stamp; never render a blank or an ID.

**Owner decisions (2026-08-30) that are 4.3 scope:**
- **Family POA (`familyIsPoa`)** — field, admin UI, and persistence already shipped. The **acting gates are this session**. A designated POA gets client-equivalent access: full clinical read (this session's sections) plus acting on the client's behalf (care-plan co-sign, messaging). Every POA action must record the POA's own name as **"<POA name> as POA for <client name>"** in the event record and on any signed PDF (spec §4.3). Non-POA family stays read-only and ROI-gated.
- **Case Manager clinical read** — case managers get read rights on clinical docs, mirroring their OpenEMR scoped permissions. Implement by **splitting `/api/clinical/*` into read (admin + clinical + case_manager) and write (admin + clinical)**, with mutation UI hidden for case managers. Build this with the same scoped-read machinery as the patient read.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Sessions 4.1 (PR #19) and 4.2 (PR #22) are
merged. TEST DATA ONLY.

Branch: session/04.3-patient-clinical-read (or the harness-assigned branch)

Read first, in full:
- CLAUDE.md — especially Current session focus and the 2026-08-30
  owner-decision bullet (POA, case-manager scope, login destination matrix)
- docs/GFC_Session4.3_ClaudeCode_Prompt.md — the "Known state carried in"
  section. Treat every item there as settled; do not re-derive it.
- docs/OPENEMR_SERVER_DEFECTS_2026-08.md
- docs/GFC_App_Build_v2.md §6; docs/GFC_SESSION_PLAN.md §Session 4
- docs/GFC_Client_Care_Profile_Schema_v1.md (§6 consents, openEmrPatientId,
  familyIsPoa)
- openemr.js, clinicalRepository.js, and the 4.2 scheduling modules
- docs/prototype/patient-portal-prototype-v2.html (visual target —
  reference art, never a data source)

ARCHITECTURE RULE (non-negotiable)
Read-only, filtered, scoped. A patient sees a curated read of THEIR OWN
OpenEMR record through openemr.js — never raw clinician notes, never
another patient's data, never OpenEMR's native portal. Server-side
scoping: every FHIR call resolves the patient from the authenticated
session's client record (openEmrPatientId), NEVER from a request
parameter. No write path to OpenEMR from any patient- or family-facing
route (the POA acting gates below write app-side records only — co-sign
and messaging — exactly as the existing client flows do).

PREFLIGHT
1. Live FHIR read round-trip for a linked test patient via openemr.js.
2. Confirm the 403 gate: unlinked client, non-clinical service line, or
   missing consent-to-treat each denies at the API layer.
3. Appointment read for that patient (4.2 path). If it 401s, the
   appointment-scoped OAuth client swap has not been deployed — STOP and
   report; do not work around it.

SCOPE

A. Patient clinical read (client portal, clinical-line clients only)
Extend the Session 3 portal — respect its mobile AND desktop layouts from
3.5 — with:
- Visit summaries: date, provider, reason, plain-language summary,
  follow-up. Filtered fields only, never raw clinician notes. Provider
  name falls back to the app-side visit stamp when FHIR Practitioner 403s.
- Medications: current list with dosage instructions (FHIR
  MedicationRequest, per 4.1's read path).
- Care plan: already rendering (4.1 wrote client.carePlan, versioned from
  1). Add the signed care-plan PDF download, served from the Drive
  reference on client.carePlanDocs — NOT from OpenEMR Documents.
- Allergies + problem list: patient-friendly presentation per prototype.
- Upcoming clinical appointments (4.2 is merged, so build this): live
  appointments only — never tombstone rows from a reschedule or cancel.
- Vitals: source from the encounter note if presentable; otherwise omit
  the section entirely. Never an empty panel.
- Branded empty states throughout (3.5 rule). No fixture or prototype
  sample content anywhere.

B. Sharing-rule filter
Fields marked clinician-only are never serialized into a patient, family,
or POA response. Enforce server-side in ONE reviewable config object (a
filter map), not by hiding in the UI.

C. Family + POA access
- Non-POA family: read-only, ROI-gated (roiFamily signed or
  signed_offline) AND the client's sharing settings. Defaults: care-plan
  summary yes, medications no, visit summaries at summary level only.
  Revoking ROI-family removes access immediately.
- POA family (familyIsPoa true — set by admin only after the POA document
  is verified on file): client-equivalent access. Full clinical read as in
  scope A, plus ACTING on the client's behalf — care-plan co-signature and
  messaging.
- Every POA action records the POA's own name as
  "<POA name> as POA for <client name>" in the event record AND on the
  signed PDF signature block (spec §4.3). The client's own name must never
  be presented as the signer when a POA signed.
- A POA co-signature satisfies the care-plan co-sign requirement
  identically to the client's own, and drives the same signed-PDF emission
  path built in 4.1.

D. Case-manager scoped clinical read
- Split /api/clinical/* into READ routes (admin, clinical, case_manager)
  and WRITE routes (admin, clinical). Enforce at the API layer, not the
  UI.
- Case managers see the clinical chart read views with all mutation UI
  hidden — no H&P authoring, no care-plan authoring, no scheduling
  mutations, no med-rec resolution.
- Reuse the same scoped-read machinery as the patient read where the
  shape allows; do not fork a parallel implementation.

E. Audit
Every patient, family, POA, and case-manager clinical read writes to
logActivity() with user, role, actingFor (client id when POA), patientId,
and resource.

DO NOT
- Any OpenEMR write path from patient-, family-, or POA-facing routes.
- Read the care-plan PDF from OpenEMR Documents (defect; use Drive).
- Raw notes, lab internals, or clinician-only fields in any patient,
  family, or POA payload.
- Show clinical sections to PHC-only clients.
- Show tombstoned appointments to patients.
- New messaging features beyond POA acting on existing client messaging
  (Session 9 owns the full channel matrix).
- Widen case-manager access to any write route.
- Enter real PHI. Test data only.

ACCEPTANCE
- A linked clinical test client sees their own visit summaries,
  medications, care plan + working signed-PDF download, allergies, problem
  list, and live (non-tombstoned) upcoming appointments.
- A PHC-only client sees no clinical sections at all.
- Tampering with any id parameter cannot read another patient's data — the
  server resolves the patient from session only. Prove with a test.
- Clinician-only fields absent from patient/family/POA payloads. Prove
  with a test.
- Non-POA family sees only ROI-and-sharing-permitted sections; revoking
  ROI-family removes access immediately.
- A POA family user sees client-equivalent clinical detail, can co-sign a
  care plan, and the resulting event + signed PDF both read
  "<POA name> as POA for <client name>". Prove with a test.
- A case manager can open the clinical chart read views and gets 403 on
  every /api/clinical/* write route. Prove with a test.
- Mobile and desktop layouts both correct.
- All clinical reads appear in logActivity() with actingFor populated for
  POA reads.
- App boots; Sessions 3.x, 4.1, and 4.2 flows unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction,
including the step-7 post-merge backfill note. When 4.3 merges, flip
Session 4 to ✅ Done in both files. Open ONE PR titled "Session 4.3:
Patient portal clinical read + POA acting gates + case-manager read."
Stop for review. Do not start Session 5.
```

---

## After this lands
Session 5 — Clinical HIPAA go-live: app into the AWS boundary, MFA for Admin/Clinical, durable `audit_log`, PII-scrubbed logs, BAAs on file, **and the OpenEMR auth migration from password grant to authorization_code + refresh_token** (retire `gfc-app-api`, disable the password-grant global, delete the unused duplicate OAuth client).
