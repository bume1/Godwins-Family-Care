# Session 4.3 — Claude Code Prompt
## Patient portal clinical read (fast-follow)

**Prerequisite:** Session 4.1 merged. 4.2 helpful but not required (appointments section degrades gracefully if absent).
**Model:** Sonnet acceptable.
**Build target:** `docs/prototype/patient-portal-prototype-v2.html`.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Session 4.1 is merged. TEST DATA ONLY.

Branch: session/04.3-patient-clinical-read

Read first: CLAUDE.md; docs/GFC_App_Build_v2.md §6 (patient portal clinical
read); docs/GFC_SESSION_PLAN.md §Session 4 (4.3);
docs/prototype/patient-portal-prototype-v2.html (visual target — reference
art, never a data source); the 4.1 FHIR client module.

ARCHITECTURE RULE
Read-only, filtered, scoped. The patient sees a curated read of THEIR OWN
OpenEMR record through the app's FHIR client — never raw clinical notes,
never another patient's data, never OpenEMR's native portal. Server-side
scoping: every FHIR call resolves the patient from the authenticated
session's client record (openEmrPatientId), NEVER from a request parameter.

SCOPE
Extend the Session 3 client portal (respect its existing mobile + desktop
layouts from 3.5) with clinical sections for IHPC clients:
- Visit summaries: per-encounter summary (date, provider, reason, plain-
  language summary, follow-up) — filtered fields, not raw notes.
- Medications: current med list from OpenEMR with dosage instructions.
- Care plan: already renders client.carePlan from 4.1 — verify, and add
  the signed care-plan PDF download link.
- Upcoming clinical appointments (if 4.2 merged; otherwise hide section).
- Allergies + problem list in patient-friendly presentation per the
  prototype.
- Sharing rules: fields marked clinician-only in the filter map are never
  serialized to the patient response (server-side filter, not UI hiding).
  Keep the filter map as a single reviewable config object.
- PHC-only clients see no clinical sections at all.
- Family portal: clinical sections visible ONLY where the client's sharing
  settings + ROI-family allow (default: care plan summary yes, meds no,
  visit summaries summary-level).
- Every patient clinical read logs to logActivity().

DO NOT
- Any write path to OpenEMR from patient-facing routes. Read-only.
- Raw notes, lab internals, or clinician-only fields in any patient/family
  response payload.
- New messaging features (Session 9).

ACCEPTANCE
- An IHPC test client sees their own visit summaries, meds, care plan +
  signed PDF, allergies/problems; a PHC client sees no clinical sections.
- Tampering with any id parameter cannot read another patient's data
  (server resolves patient from session only — prove with a test).
- Clinician-only fields absent from patient/family JSON payloads (test).
- Family sees only ROI-and-sharing-permitted sections.
- Mobile + desktop layouts both correct. App boots; prior flows unaffected.

Update CLAUDE.md per its running instruction (flip Session 4 to ✅ when all
three sub-PRs are merged). Open ONE PR titled "Session 4.3: Patient portal
clinical read." Stop for review. Do not start Session 5.
```
