# Session 4.2 — Claude Code Prompt
## Clinician scheduling (OpenEMR-tied)

**Prerequisite:** Session 4.1 merged (FHIR client + workspace exist).
**Model:** Opus (Sonnet acceptable — scope is narrower than 4.1).
**Build target:** scheduling screens in `docs/prototype/clinical-emr-prototype-v1.html`.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Session 4.1 is merged: the FHIR client module
and clinician workspace exist. TEST DATA ONLY.

Branch: session/04.2-clinician-scheduling

Read first: CLAUDE.md; docs/GFC_App_Build_v2.md §6; docs/GFC_SESSION_PLAN.md
§Session 4 (4.2); the 4.1 FHIR client module code; scheduling screens in
docs/prototype/clinical-emr-prototype-v1.html.

ARCHITECTURE RULE
Clinical scheduling backend is OpenEMR's appointment/calendar (FHIR
Appointment / OpenEMR API), NOT the app shift store. A booked visit is an
OpenEMR appointment linked to the billable encounter. PHCP caregiver
scheduling (Session 7) will use the app/RDS store — two scheduling systems
by design. Do not merge them.

SCOPE
- Provider appointment management in the clinician workspace: create,
  reschedule, cancel appointments for IHPC patients against the provider's
  OpenEMR calendar. Same UX pattern the PHCP side will use later.
- Appointment ↔ encounter linkage: opening a visit (4.1 H&P or follow-up)
  from an appointment links the resulting Encounter to it.
- Provider day/week calendar view (desktop-first); patient's upcoming
  clinical appointments listed on their chart.
- Admin unified view: all providers' clinical appointments.
- Conflict prevention: no double-booking a provider slot; OpenEMR is the
  source of truth on availability.
- Audit every schedule mutation via logActivity().

DO NOT
- Build PHCP caregiver shifts, availability submission, or time tracking
  (Session 7).
- Build patient self-scheduling (later; clinical appts are staff-created in
  this phase).
- Expose scheduling to non-clinical, non-admin roles.

ACCEPTANCE
- Creating an appointment in the app creates it in OpenEMR (verify via
  FHIR read-back); reschedule + cancel round-trip too.
- Double-booking a provider slot is rejected with a clear error.
- A visit documented from an appointment produces an Encounter linked to
  that appointment.
- Admin sees all providers; a clinician sees their own calendar; other
  roles 403 at the API layer.
- App boots; 3.x and 4.1 flows unaffected.

Update CLAUDE.md per its running instruction. Open ONE PR titled
"Session 4.2: Clinician scheduling (OpenEMR-tied)." Stop for review. Do not
start 4.3.
```
