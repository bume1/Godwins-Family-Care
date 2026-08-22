# Session 4.2 — Claude Code Prompt
## Clinician scheduling (OpenEMR-tied)

**Prerequisite:** Session 4.1 merged (PR #19). Auth layer, `openemr.js` client, `clinicalRepository.js`, and `/api/clinical/*` routes exist.
**Model:** Opus (Sonnet acceptable — narrower than 4.1).
**Build target:** scheduling screens in `docs/prototype/clinical-emr-prototype-v1.html` (+ mobile prototype).
**Important:** TEST DATA ONLY.

---

## Known state carried in from 4.1 (do not re-discover)

- **Transport split.** OpenEMR 7.0.4's FHIR API is read-only for most resources. Reads go through FHIR R4; writes go through OpenEMR's standard REST API (`/apis/default/api/...`). Appointments follow the same rule. Reuse `openemr.js` — do not build a second auth or transport path.
- **Auth.** Password grant, dev window only (`gfc-app-api`, clinician ACL, Authorizations = All). Migrating to authorization_code + refresh token at Session 5.
- **Two open EMR-server-side defects** (maintainer's, not app code — app degrades gracefully): vitals REST endpoint 500s (`authUserId` null in VitalsCalculatedService), and document upload 500s for all files/categories (`getResponseForPayload ... bool given`; likely `sites/default/documents` not writable). If an appointment endpoint throws a similar server-side 500, **report it in the same style — do not silently work around it.**

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Session 4.1 is merged (PR #19): the OpenEMR
auth layer, openemr.js client, clinicalRepository.js helpers, and
/api/clinical/* routes gated by requireClinicalStaff all exist. TEST DATA
ONLY.

Branch: session/04.2-clinician-scheduling (or the harness-assigned branch)

Read first: CLAUDE.md; docs/GFC_Session4.2_ClaudeCode_Prompt.md (the
"Known state carried in from 4.1" section — treat those findings as
settled); docs/GFC_App_Build_v2.md §6; docs/GFC_SESSION_PLAN.md §Session 4;
openemr.js and clinicalRepository.js from 4.1; scheduling screens in
docs/prototype/clinical-emr-prototype-v1.html.

TRANSPORT NOTE (settled in 4.1, do not re-litigate)
Reads via FHIR R4 where useful; appointment create/update/cancel via
OpenEMR's standard REST API. Reuse the 4.1 auth layer and token handling.

PREFLIGHT
Confirm a live token and a successful appointment read + write round-trip
against the dev instance before building UI. If appointment scopes are
missing from the API client grant, STOP and tell Bianca exactly which
scopes to add and where (Administration → System → API Clients). If an
endpoint returns a server-side 500 of the same class as the known vitals /
document-upload defects, STOP and report it with the exact error for the
EMR maintainer — do not build a workaround.

ARCHITECTURE RULE
OpenEMR is the source of truth for provider availability and booked
appointments. The app never keeps a second appointment ledger. A booked
visit is an OpenEMR appointment linked to the billable encounter. PHCP
caregiver scheduling (Session 7) uses the app/RDS shift store — two
scheduling systems by design; do not couple them.

SCOPE

A. Appointment management (clinician workspace, /clinical)
- Create, reschedule, cancel appointments for IHPC patients on the
  provider's OpenEMR calendar.
- Fields: patient, provider, date/time, duration, appointment type/
  category, location or telehealth flag, status, notes.
- Cancel captures a reason; never a hard delete.
- Every mutation → logActivity() with user, role, patientId,
  appointmentId, action.

B. Appointment ↔ encounter linkage
- Opening a visit from an appointment (4.1 H&P or a follow-up) links the
  resulting Encounter to that appointment.
- The chart's appointment list distinguishes: documented, no-show, and
  not-yet-documented.

C. Calendar views (desktop-first per prototype, responsive per mobile
   prototype)
- Provider day + week view (own appointments).
- Admin unified view across providers, filterable by provider.
- Patient chart: that patient's upcoming + past clinical appointments.
- Branded empty states, never sample data (3.5 rule).

D. Conflict prevention
- Reject double-booking a provider slot. OpenEMR is the availability
  authority — check against it; do not model availability app-side.
- Clear, specific error on conflict.

DO NOT
- Build PHCP caregiver shifts, availability submission, or time tracking
  (Session 7).
- Build patient self-scheduling — clinical appointments are staff-created
  this phase.
- Expose scheduling routes or UI to non-clinical, non-admin roles.
- Duplicate appointment data into the KV store beyond linkage pointers.
- Enter real PHI. Test data only.

ACCEPTANCE
- Creating an appointment in the app creates it in OpenEMR (prove with a
  read-back); reschedule and cancel round-trip correctly.
- Double-booking a provider slot is rejected with a clear error.
- A visit documented from an appointment produces an Encounter linked to
  that appointment, visible in the chart.
- Admin sees all providers; a clinician sees their own calendar; every
  other role gets 403 at the API layer.
- All scheduling mutations appear in logActivity().
- App boots; Sessions 3.x and 4.1 flows unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(including the step-7 post-merge backfill note). Open ONE PR titled
"Session 4.2: Clinician scheduling (OpenEMR-tied)." Stop for review. Do not
start 4.3.
```

---

## After this lands
Session 4.3 — patient portal clinical read (`docs/GFC_Session4.3_ClaudeCode_Prompt.md`).
