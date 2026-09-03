# Session 4.4 — Claude Code Prompt
## Clinical completeness P0: coding, orders, prescriptions, sign-and-close, billing route

**Prerequisite:** 4.1 (PR #19) and 4.2 (PR #22) merged. Merge PR #27 first (14-line diagnostics change).
**Spec:** `docs/GFC_Clinical_Completeness_Spec_v1.md` — build the **P0 bundle in §6**.
**Model:** Opus.
**Deadline context:** this is the set that makes `/clinical` carry a full visit end to end for first clinical test use.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Sessions 4.1 (PR #19) and 4.2 (PR #22) are
merged. TEST DATA ONLY.

Branch: session/04.4-clinical-completeness (or harness-assigned)

Read first, in full:
- docs/GFC_Clinical_Completeness_Spec_v1.md — THIS IS THE SPEC. Build the
  P0 bundle listed in §6. §2 (note→billing route), §3 (sign & close), and
  §4 (attribution) are normative, not advisory.
- CLAUDE.md (current focus, recent decisions, prerequisite gate)
- docs/OPENEMR_SERVER_DEFECTS_2026-08.md (vitals + document 500s: known,
  server-side, do not attempt client-side workarounds)
- openemr.js, clinicalRepository.js, public/clinical.html from 4.1/4.2
- docs/prototype/clinical-emr-prototype-v1.html (+ mobile) — visual target

SETTLED CONTEXT — do not re-derive
- Reads via FHIR R4, clinical writes via OpenEMR standard REST API
  (/apis/default/api/...). Reuse openemr.js; no second auth path.
- Auth is the dev-window password grant (gfc-app-api). Migration to
  authorization_code is Session 5.
- Quest HL7 lab interface is DEFERRED by owner decision (months out).
  Orders are captured in the chart; transmission stays manual. Do not
  build or scaffold an HL7 interface.
- E-prescribing is NOT in scope. Record the prescription; transmission
  stays as today.
- Claims/clearinghouse/eligibility are Track D. Not this session.

PREFLIGHT
1. Live token + FHIR read round-trip via openemr.js.
2. Appointment read (4.2 path). If it 401s, the appointment-scoped OAuth
   client swap has not been deployed — report it prominently; it is a P0
   deploy step in the spec.
3. Probe which of these standard-REST endpoints exist and accept writes on
   this instance: prescription, order/procedure order, billing (fee sheet
   / encounter charges), and encounter close/sign. Report exactly what is
   and is not available BEFORE building, and use the spec §2.4 interim
   (structured note block + app-side encounter_billing record) for
   anything the API will not accept. Do not silently stub.

SCOPE — the P0 bundle

A. Follow-up visit SOAP form
Shorter than the 4.1 H&P: subjective, objective (incl. vitals fields),
assessment, plan. Writes encounter + soap_note through the same 4.1 path.
Vitals continue to be preserved verbatim in the note (server defect).

B. ICD-10 coded diagnoses
Problem list and visit assessment capture selectable ICD-10 codes (search
by code or description) rather than free text. Codes attach to the
encounter and feed the billing route. Ship a seeded working set relevant
to home-based primary care with search over it; make the source
swappable for a fuller code set later.

C. Prescription recording
Record new prescriptions and refills to OpenEMR (/prescription or the
equivalent this instance exposes): drug, dose, route, frequency, quantity,
refills, prescriber, date. Appears in the chart. No transmission.

D. Order capture (labs, imaging, procedures)
Record orders against the encounter: order type, specific tests/studies,
priority, linked diagnosis, ordering clinician, status
(ordered / sent / resulted / cancelled). Status is manually advanced by
staff. No HL7, no interface.

E. Encounter coding → billing route (spec §2, normative)
- CPT/HCPCS service-code capture with a short configurable favorites list
  (home-visit E/M 99341–99345 new, 99347–99350 established, plus care-
  management codes).
- Every service code links to at least one encounter diagnosis.
- Write the charge to OpenEMR's billing/fee-sheet table for that encounter
  so it lands in Billing Manager. If the API will not accept it, use the
  §2.4 interim: structured machine-parseable block in the note PLUS an
  app-side encounter_billing record, and say so plainly in the PR.
- Rendering provider = signing clinician. Billing provider = config value
  gfc_payer_credentialing.billing_npi_used. Never hardcode an NPI.
- Encounter carries a coded / not-coded state, visible in the chart and in
  a staff list of uncoded encounters.

F. Sign and close encounter (spec §3, normative)
- Attestation action with timestamp and signing clinician.
- Blocked until the encounter has a note, ≥1 diagnosis code, and ≥1
  service code.
- Closed encounters are read-only; corrections are addenda with their own
  timestamp and signer. No silent edits.

G. Attribution interim (spec §4)
Until per-user OpenEMR auth lands in Session 5, stamp the acting
clinician's name and NPI into the note header and the encounter record so
the chart is never silent about who did the work. Record this as a
decision in CLAUDE.md.

DO NOT
- Build an HL7/Quest interface or e-prescribing transmission.
- Build claims, eligibility, statements, or Stripe (Track D).
- Attempt client-side workarounds for the vitals or document 500s.
- Change 4.1/4.2 behavior beyond what this scope requires.
- Enter real PHI. Test data only.

ACCEPTANCE
- A clinician can, in one sitting on a test patient: open the chart,
  document a follow-up visit, add an ICD-10 coded diagnosis, record a
  prescription, place a lab order, select a CPT service code linked to the
  diagnosis, and sign and close the encounter.
- The signed encounter appears in OpenEMR with the charge visible to
  back-end billing (or, if the API blocks it, the §2.4 interim is in place
  and documented in the PR).
- Signing is refused when a diagnosis or service code is missing, with a
  specific error.
- A closed encounter cannot be edited; an addendum can be added and shows
  its own signer and timestamp.
- The note header and encounter record show the acting clinician's name
  and NPI.
- Non-clinical roles get 403 on every new route. All writes hit
  logActivity().
- App boots; 3.x, 4.1, 4.2 flows unaffected.

Update CLAUDE.md AND docs/GFC_SESSION_PLAN.md per the running instruction
(steps 4–7). Open ONE PR titled "Session 4.4: Clinical completeness P0."
Stop for review.
```

---

## After this lands
P1 set per spec §6: results review + acknowledgment, clinical inbox, vitals/document re-test after the EMR fixes, and Session 4.3 (patient portal clinical read).
