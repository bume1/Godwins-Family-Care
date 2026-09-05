# GFC Billing Segment — App Integration Spec

_Updated to build against the OpenEMR Billing & Configuration Guide v3.0 (Sept 3, 2026) and the v2.3 Appendix D app-to-OpenEMR API matrix. Supersedes the earlier standalone Architecture Brief. Scope: the app half of the billing segment. v3.0 is the EMR half. The two meet at the charge-ready gate and the data contract below._

---

## 1. Division of labor

- OpenEMR is the billing system of record. Charges, 837P claims through Availity, 835 ERA posting, A/R, and statements all live there.
- The app is the capture and patient-facing surface. Clinicians and families never open OpenEMR. The app reads from and writes to OpenEMR through its API.
- The app never keeps its own money ledger. Every balance is sourced from OpenEMR. If the app and OpenEMR ever disagree on what a patient owes, OpenEMR wins.

---

## 2. The two-lane API reality (build-critical)

OpenEMR exposes two connection lanes, and the app must use both. This is from v2.3 Appendix D, and each row must be verified against the live server before coding.

- Reads ride FHIR (`/apis/default/fhir/…`): Patient, Condition, MedicationRequest, AllergyIntolerance, Observation. This is OpenEMR's strongest, ONC-certified surface.
- Writes ride the Standard REST lane (`/apis/default/api/…`): encounter create, SOAP note, vitals, problem list, medication list, allergy, appointment, document. FHIR is read-oriented for these in 7.0.4.
- Patient demographics create and update can go FHIR (`POST/PUT /fhir/Patient`); REST is the fallback.
- Care plan write is unverified in the docs. Confirm against the live server. If neither lane supports a structured write, care plan authoring stays in the app and a summary pushes via `soap_note`.

Hard rule: anything coded FHIR-only stalls on visit documentation. Reads FHIR, writes REST.

---

## 3. What the app captures and writes each visit (the charge path)

During the visit, in the app:

- Create the encounter (REST `POST /api/patient/[puuid]/encounter`)
- SOAP note (REST `.../soap_note`)
- Vitals (REST `.../vital`)
- Problem list, medication reconciliation, allergies (REST)
- CPT plus ICD-10 plus diagnosis pointers, written to OpenEMR's Fee Sheet for that encounter. OpenEMR owns the code linkage; the app captures it. This is what makes the charge-ready gate enforceable.
- Care management minutes (CCM, BHI) aggregate and post to OpenEMR monthly per v3.0 §12.1.

---

## 4. The charge-ready gate is the app's sign-and-close contract (v3.0 §10)

The app must not let an encounter close or move to billing until all eight are true. The app enforces the checks; OpenEMR carries the evidence.

1. Note signed and locked
2. Diagnosis-to-service linkage reviewed
3. Rendering provider validated against the v3.0 §3 roster
4. Rendering provider's certification matches the code billed. The app checks the provider's permitted code set: an A1 primary-care NP cannot bill the psych set, an A9 LCSW cannot bill E/M, an A10 LMSW cannot bill anything independently
5. Facility record and POS match where the service physically happened
6. Eligibility and payer order validated
7. Enrollment and reassignment confirmed active for that date of service
8. Required consent, notice, or authorization documented

This is why requiring codes at sign matters: no encounter goes unbilled, and nothing bills that should not.

---

## 5. Eligibility (270/271)

- Runs twice per claim: before the visit and again before claim release, because enrollment changes between those points.
- Availity is the locked clearinghouse (v3.0 §11.1), enrolled since July. Do not switch. Eligibility runs through Availity's 270/271, or the free Availity Essentials portal in the interim.
- The app surfaces coverage, Medicare Advantage status, and the QMB flag at intake so staff verify before the visit. QMB drives the hard hold below.

---

## 6. Patient payment (Stripe) — the app-only piece

This lives only in the app. OpenEMR handles insurance, not card collection.

- Use Stripe hosted Elements or Checkout so card data never touches GFC servers.
- No PHI in Stripe. Store only a Stripe customer token, an internal invoice or account ID, and a neutral descriptor. Clinical detail stays in OpenEMR. Stripe does not sign a BAA and does not need to under this segregation.
- Patient responsibility is 20% of Medicare's allowed amount, not the charge, and it comes from the 835, not a hand calculation. The app must not compute or collect a Medicare copay from the charge master at time of service, because the charge master is set at 125 to 150% of allowable and would overcharge every patient.
- Recommended default: for Medicare patients, collect nothing at the visit and bill after the ERA posts. Collect at time of service only where a plan defines a fixed dollar copay (some Medicare Advantage plans).
- QMB hard hold: for confirmed QMB patients the app blocks statements, collection tasks, and balance transfers. System control, not a staff instruction (v3.0 §11.3).
- No statement or charge before the ERA posts. The app's statement trigger fires only on posted-ERA patient responsibility read from OpenEMR.

---

## 7. The reconciliation seam (spans both systems, easy to get wrong)

- Stripe payments and Medicare EFT deposits both reconcile against the 835 posted in OpenEMR. One patient balance, sourced from OpenEMR.
- Flow: OpenEMR posts the 835, patient responsibility appears, the app reads it via API, the app collects via Stripe where a balance is owed and the patient is not QMB or Medigap-covered, the app writes the payment back to OpenEMR's ledger.
- Do not let the app hold a second balance.

---

## 8. Compliance

- Signed BAA with every PHI-touching vendor: AWS, Availity, Supabase with the HIPAA add-on, the care-management platform, and the telehealth platform. Stripe is the intentional exception via PHI segregation.
- Audit logging on. No shared logins. One human, one account, because the login drives the note signature, which must match the claim.
- The PHCP entity never appears as billing provider on a clinical claim.

---

## 9. Settled vs open for the app build

Settled: OpenEMR is the source of truth; Availity is the clearinghouse; the two-lane API (reads FHIR, writes REST); the charge-ready gate is the sign contract; Stripe with PHI segregation.

Open, verify before coding:
- Every Appendix D row against the live server, especially care plan write.
- The exact per-patient, per-month care-management inbound payload (v3.0 §12.1) once the care-management platform is selected.
- Confirm the time-of-service collection policy: recommend post-ERA billing for Medicare, fixed copay only for MA plans that define one.
