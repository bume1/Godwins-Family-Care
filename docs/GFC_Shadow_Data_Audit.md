# Shadow-data audit — is the legal medical record complete in OpenEMR alone?

**Pass 1 (baseline), run 2026-09-08** against the live instance `emr.godwinsfamilycarellc.com`
(OpenEMR **8.4.0**, database 543, Phase 6B patch installed) as `gfc-app-api` on the **v4 OAuth
client** (54 requested, 52 granted; the 2 absent are `api:oemr` / `api:fhir`, which 8.4 never
echoes). Patient: **TEST PatientOne**, `a284d5c2-670e-4a62-aa95-2d1aa629003c`, pid 1. TEST DATA only.

The acid test: **if the app were switched off tomorrow, could we produce a complete, defensible
chart for any patient from OpenEMR by itself?**

---

# 13 GAP findings

**Today the answer is no.** Thirteen pieces of clinical content or claim-supporting evidence exist
nowhere in OpenEMR. Five of them are new, found by writing to the live server and reading it back
rather than by reading code. Three are silent: the app reports success and nothing lands.

**Four were fixed at the owner's direction in the same PR as this audit** and re-proven live
(`scripts/verify_shadow_data_fixes.js`, stored values only). **Three are now fully closed**; G5 is
mitigated and carries a genuine instance dependency (the empty drug option lists). **Nine remain
open.**

| # | Gap | Severity | New? | Status after this PR |
|---|---|---|---|---|
| G1 | The care plan, all versions, both signatures | **Critical** | | Open, blocked on G2 |
| G2 | No document the app files is retrievable from OpenEMR | **Critical** | **New** | Open, server-side |
| G3 | Every order files with no test name and no diagnosis | **Critical** | **New** | **✅ Closed** — dx link and test name both store |
| G4 | Allergies are never written to OpenEMR at all | **Critical** | **New** | Open |
| G5 | Prescription route, frequency and date are dropped | High | **New** | **Mitigated** — date fixed; route and frequency now reach the note, structured fields blocked on empty option lists |
| G6 | Prescriptions carry no link to the encounter | Medium | **New** | **✅ Closed** |
| G7 | The encounter's provider is a config constant, not the clinician | High | **New** | **✅ Closed** |
| G8 | Consents: treat, assignment of benefits, NPP, ROI-family | **Critical** | | Open |
| G9 | Transfer-of-Care ROI, per-provider authorizations, PDFs | High | | Open |
| G10 | The clinical intake record | High | | Open |
| G11 | The RN's care-tier / track determination | Medium | | Open |
| G12 | Patient-facing visit summary and follow-up instructions | Medium | | Open |
| G13 | The only audit trail naming a human being is app-side | **Critical** | | Open, Session 5 |

**The one-sentence version:** OpenEMR holds the visit, the note, the vitals and the charge, and it
holds them correctly. It does not hold the plan of care, the consents, the allergies, or any
document, and it cannot say who did any of it.

**What the four fixes changed.** An order now carries its diagnosis link, a prescription carries a
date and its encounter, route and frequency survive into the chart, and an encounter names the
clinician who saw the patient instead of a config constant. Each is pinned by a unit test confirmed
to fail when the old behaviour is put back. The two that remain mitigated rather than closed both
wait on someone else: the 6B order route must store `code_text`, and the instance must seed its
`drug_route` and `drug_interval` option lists.

---

## Method

Four steps, in order.

1. Read the code for every clinical element the app captures, stores or generates: the KV
   collections, the client-record fields, and the `[GFC ...]` structured-note blocks.
2. For each element, identify the OpenEMR endpoint, resource or table it lands in, or none.
3. Write a complete visit to the live 8.4 server through the app's own modules (`openemr.js` plus
   the `clinicalRepository.js` builders, the same code the HTTP routes call), then read every
   element back through OpenEMR's own API. Nothing below is inferred from code.
4. Classify, and for each gap say what closes it.

The app's HTTP routes could not be exercised from the build sandbox because the KV store is
unreachable from here. That limits step 3 to the EMR-facing half of each route, which is exactly
the half this audit is about. The app-side halves are covered by the 101 unit tests in `test/`.

**What was written live** (encounter `a2b2daec-b0ae-4eb7-afe9-966e59100409`, eid 32, tagged
`SHADOWAUDIT-1788890606538`): an encounter, a narrative SOAP note, a structured vitals row, an
ICD-10 diagnosis and a CPT service, a fee-sheet charge, two procedure orders, a prescription, an
attestation note, and a document upload.

---

## The table

`App store` is where the app keeps it. `OpenEMR landing` is what was actually found on the server.

### Verified present and correct in OpenEMR

| Element | App store | OpenEMR landing | Class | Evidence |
|---|---|---|---|---|
| Encounter (date, reason, class, billing note) | `encounter_billing` pointer | `form_encounter` via `POST …/encounter`; FHIR `Encounter` | MIRRORED | eid 32 created and read back |
| Narrative SOAP note | none, OpenEMR only | `form_soap` sid 23 | **OPENEMR ONLY** | read back with `[GFC CLINICIAN]` header intact |
| Clinician name, credential, NPI | `renderingProvider` on records | Free text in the note header, encounter `reason`, `billing_note` | MIRRORED (as text) | `[GFC CLINICIAN] Bethel Godwins, FNP-C (NPI 1902310568)` |
| Vitals | note `VITALS —` line | `form_vitals` row; FHIR `Observation` | MIRRORED | row accepted, 185 vital Observations |
| Fee-sheet charge (CPT, units, modifier) | `encounter_billing.services` | `billing` table via 6B `POST …/billing` | MIRRORED | id 14, `code:"99348"` |
| Diagnosis pointer on the charge | `encounter_billing.diagnoses` | `billing.justify` | MIRRORED | `justify:"ICD10\|I10:"` |
| Rendering provider on the charge | `attestation.signedBy` | `billing.provider_id` | MIRRORED | `provider_id:5`, Bethel |
| Attestation (text, signer, NPI, timestamp, dx, svc) | `encounter_attestations` | `[GFC ATTESTATION]` block in a second SOAP note, sid 24 | MIRRORED (as text) | block read back in full |
| Addenda | `encounter_addenda` | `[GFC ADDENDA]` block in the same note | MIRRORED (as text) | round-trip tested in `test/` |
| Prescription drug, dose, quantity | `prescriptions` | `prescriptions` table; FHIR `MedicationRequest` | MIRRORED | uuid `a2b2daf2…`, 12 in FHIR |
| Problem list | app writes only | `lists` via `POST …/medical_problem`; FHIR `Condition` | MIRRORED, **uncoded** | 3 Conditions, **0 carry an ICD-10 code** |
| Appointments, tombstones, no-shows | `appointment_encounters` pointer only | OpenEMR calendar | MIRRORED | 10 rows read back |
| Place of service and facility | resolved per patient | `form_encounter.pos_code` / `facility_id` | MIRRORED | `pos_code:11 facility_id:3` |
| Billing facility | global config | `form_encounter.billing_facility` | MIRRORED | `billing_facility:3` |

### App only, by design (not part of the legal record)

One line each, as asked.

| Element | App store | Decision |
|---|---|---|
| `client.openEmrPatientId` | `users` | **Keep app-side.** A pointer to the record, not the record. |
| `client.openEmrFacilityId` | `users` | **Keep app-side.** 8.4's patient record has no facility field (verified live); the POS it selects always comes from OpenEMR's own facility record. |
| `appointment_encounters` | KV | **Keep app-side.** Pointers joining a calendar slot to an encounter. Both ends live in OpenEMR. |
| Order status history (who and when per transition) | `clinical_orders.statusHistory` | **Keep app-side.** OpenEMR's four statuses carry no per-transition stamp. Revisit if a payer ever asks who marked a lab sent. |
| Coding favorites and per-clinician usage counts | KV | **Keep app-side.** UI ranking, never clinical content. |
| `gfc_payer_credentialing.billing_npi_used` | KV | **Keep app-side.** Practice configuration. It reaches the record through the charge. |
| Care-plan checklist manual steps | `client.clinicalEnrollment` | **Keep app-side.** Workflow status, not a clinical finding. |
| `gfc_messages` | KV | **Keep app-side for now.** Client-to-admin messaging, not clinical. Re-audit at Session 9 when the channel matrix lands. |
| `visit_logs` | KV | **Keep app-side.** PHCP caregiver visits, a different service line. Nothing writes it yet. Re-audit at Session 6. |
| Pre-signature coding on an unsigned encounter | `encounter_billing` | **Keep app-side, with a caveat.** Charges only exist in OpenEMR at signature, so this is the worksheet. An encounter coded but never signed leaves that work nowhere in OpenEMR. Acceptable because an unsigned encounter is not billable, but it is real work that would be lost. |
| `client.sharing` | `users` | **Keep app-side.** Family sharing preferences, an app access control. |

### App only, and a gap

| Element | App store | OpenEMR landing | Finding |
|---|---|---|---|
| Care plan: problems, goals, interventions, frequency, days, times, duration, effective and target dates | `client.carePlan`, `care_plan_versions` | **None.** FHIR `CarePlan` returns 0 | **G1** |
| RN author signature image, client or POA co-signature image, printed names, timestamps, hashed IPs | `care_plan_versions`, `care_plan_cosign_events` | **None** | **G1** |
| Authored and signed care-plan PDFs | Google Drive, `client.carePlanDocs` | **Filed but not retrievable.** FHIR `DocumentReference` returns 0 instance-wide | **G2** |
| Order test names ("CBC with differential") and diagnosis links | `clinical_orders` | **Empty columns** in `procedure_order` | **G3** |
| Allergies | `client.allergies`, intake | **None.** `addAllergy` has zero call sites | **G4** |
| Prescription route, frequency, start date | `prescriptions` | **Dropped.** `route:null, interval:"", date_added:null` | **G5** |
| Which visit a prescription came from | `prescriptions.encounterUuid` | **None.** `euuid:null` | **G6** |
| Which clinician the encounter belongs to | `renderingProvider` | **Wrong.** `provider_id:1`, a config constant | **G7** |
| Consent to treat, assignment of benefits, practice NPP, ROI-family, with signature images and provenance | `consent_events`, `client.consents` | **None** | **G8** |
| Transfer-of-Care ROI, per-provider authorizations, records categories, 42 CFR Part 2 flag, generated PDFs | `consent_provider_authorizations`, `consent_records_categories`, Drive | **None** | **G9** |
| Clinical intake: reported diagnoses, medications, advance directive, ADLs, cognition, fall risk, home safety | `client.intake` | **None** | **G10** |
| RN care-tier / track determination (A1 to A4, B) | `client.careTier` | **None** | **G11** |
| Patient-facing visit summary and follow-up instructions | `encounter_billing` | **None** | **G12** |
| Which human authored or read anything | `activity_log` | **None usable.** OpenEMR's log names `gfc-app-api` for every write by every user | **G13** |

---

## The findings

### G1 — The care plan exists nowhere in OpenEMR. Critical.

FHIR `CarePlan` returns 0 resources for TEST PatientOne. FHIR `DocumentReference` returns 0. The
plan lives in `client.carePlan`, its version history and both signature images in
`care_plan_versions` and `care_plan_cosign_events`, and its PDF in Google Drive.

For a home-visit practice this is the worst single gap. The plan of care is the document that
justifies the home-visit E/M codes now posting to the fee sheet. A payer auditing 99348 asks for
the plan, and OpenEMR cannot produce it.

**What closes it:** either fix the document route so the signed PDF is retrievable (G2, which is
the mechanism), or write the plan as structured data. OpenEMR's FHIR `CarePlan` is read-only, so
the PDF path is the realistic one. **Not in 4.5's scope.** 4.5 deliberately left the patient-facing
care-plan PDF on the Drive reference precisely because document read-back was unproven. That
decision is correct as engineering and leaves the legal record incomplete.

### G2 — No document the app files can be read back. Critical. New.

`POST /apis/default/api/patient/{pid}/document` returns HTTP 200 with a body of `true`. Then:

- `GET /apis/default/fhir/DocumentReference?patient={uuid}` returns `total: 0`.
- `GET /apis/default/fhir/DocumentReference` unfiltered returns `total: 0` for the whole instance.
- `GET /apis/default/api/patient/1/document` returns **404**. No standard-API read route exists.

Multiple care-plan PDFs have been filed across sessions. None are visible through any API surface.
The app cannot tell the difference between a document that stored and one that vanished, because
the only signal it gets is a 200.

This is the mechanism behind G1, and it will silently swallow every future document: consent
packets, signed ROIs, anything.

**What closes it:** the EMR maintainer confirms in the OpenEMR UI whether the uploaded files are in
`documents` and on disk. If they are, the FHIR `DocumentReference` provider is not surfacing them
and that is a server fix. If they are not, the upload is a silent write failure. Either way the app
needs a read-back assertion after upload rather than trusting the 200, which is the same
status-code-versus-stored-value lesson Phase 6B already taught twice. **Partly in 4.5's scope**
(4.5 re-keyed the route to numeric pid) and **unresolved**.

### G3 — Every order files with no test name and no diagnosis. Critical. New.

Verified live with an A/B. Two distinct defects stack.

**Ours.** `buildOrder()` stores `tests` as an array of **strings** (`sanitizeStringArray`).
`buildOrderPayload()` then maps them as if they were objects:

```js
codes: ((order && order.tests) || []).map(t => ({
  code: t.code || undefined,                              // undefined on a string
  code_text: String(t.name || t.description || ''),       // always ''
  diagnoses: ((order && order.diagnoses) || [])           // order.diagnoses does not exist;
    .map(c => ({ code_type: 'ICD10', code: c }))          // the field is order.diagnosisCodes
}))
```

Two mistakes in four lines. `t.name` on a string is undefined, so the test name is always blank.
`order.diagnoses` is never set, the field is `order.diagnosisCodes`, so the diagnosis link is
always empty. Live payload from today's code: `[{"code_text":"","diagnoses":[]}]`.

Read back: `procedure_code:""`, `procedure_name:""`, `diagnoses:""`, `order_diagnosis:""`. An order
row exists on the encounter and says nothing. "CBC with differential" is nowhere in OpenEMR.

**Theirs.** Sending the correct payload by hand, `procedure_code` stores as `85025` and `diagnoses`
stores as `ICD10:I10`, but `procedure_name` and `procedure_order_title` still come back **empty**.
The 6B route accepts `code_text` and does not persist it into the name column. So even a fixed app
loses the human-readable test name.

Both are new. Filed in `OPENEMR_SERVER_DEFECTS_2026-08.md`.

**FIXED (app side) 2026-09-08.** `buildOrderPayload` now reads string entries correctly and reads
`order.diagnosisCodes`, and tolerates object entries so a future coded-test picker needs no change.
Proven live: the order's code row now stores `diagnoses: "ICD10:I10"` where it stored `""` before.
Pinned by a unit test confirmed to fail when the old mapping is put back.

**✅ FULLY CLOSED 2026-09-08.** The remaining blank `procedure_name` was **not** a server defect,
and the entry that said so has been withdrawn. Our own 6B controller reads the test name from
`name`/`title` while the app sent `code_text`, which is what the same controller's CHARGE half
reads. The app now sends all three keys, so the name lands against the patch as already installed
with no OpenEMR redeploy. Proven live: `procedure_name: "CBC with differential"`,
`diagnoses: "ICD10:I10"`.

The lesson is the audit's own: two halves of one system agreeing on a field name is not something a
status code can tell you. Only the read-back could.

### G4 — Allergies are never written to OpenEMR. Critical. New.

`openemr.addAllergy()` exists, is tested, and has **zero call sites** in `server.js`. Intake-reported
allergies surface to the clinician in the H&P pre-fill as `allergiesReported` and stop there.

The two `AllergyIntolerance` resources on TEST PatientOne were entered directly in OpenEMR, not by
the app.

An allergy list is not optional clinical content. A chart that prescribes without one is a patient
safety problem before it is a records problem.

**What closes it:** wire the H&P allergy capture to `addAllergy`, the way the problem list is
already wired. **Not in 4.5's scope.** This has been open since 4.1 and nobody noticed because the
method existed.

### G5 — Prescription route, frequency and date are dropped. High. New.

Sent: `route:'oral'`, `interval:'once daily'`, `start_date:'2026-09-08'`. Read back:

```
route: null      interval: ""      date_added: null      route_id: null      interval_id: "0"
```

Drug name, dose and quantity persist. Route and frequency do not, because OpenEMR expects
list-option ids and the app sends display strings. The date does not persist at all.

What survives is the free-text `note`: `"Sig: Take one tablet by mouth daily | New Rx | Prescriber:
Bethel Godwins (NPI 1902310568)"`. That happens to carry the sig here only because the clinician
typed instructions. The structured frequency is gone either way.

A prescription record without a route, a frequency or a date is not a prescription record.

**FIXED (the date) 2026-09-08.** The field is `date_added`, not `start_date`; `start_date` is
accepted and silently discarded. Verified live both ways. `date_added` now stores.

**MITIGATED (route and frequency).** These cannot be stored structurally on this instance:
`drug_route`, `drug_interval` and `drug_units` are **empty option lists, 0 rows each** (verified
live), so there is no id for a value to resolve to. That is an instance data gap like the ICD-10
load, not something the app can fix by sending a different shape. So route and frequency now ride in
the `note`, which is free text and does persist, and the structured fields are still sent so they
start working the day the lists are seeded. The note is assembled sig-first and trimmed from the sig
end, because the prescriber stamp is the attribution and must survive truncation intact. Pinned by a
unit test.

**What fully closes it:** seed `drug_route` and `drug_interval` in OpenEMR.

### G6 — Prescriptions carry no link to the encounter. Medium. New.

`euuid: null` and `pruuid: null` on the row. FHIR `MedicationRequest` returns no `encounter` and no
`requester`. From OpenEMR alone there is no way to say which visit a prescription came from or who
wrote it, other than reading the prescriber's name out of a free-text note.

**✅ CLOSED 2026-09-08.** 8.4's prescription route does accept a link, under `encounter`, and it
wants the **numeric eid** — passing the uuid does not link. `createPrescription` now resolves the eid
and sends it. Proven live: `euuid` comes back as the encounter's uuid where it was `null` before.

### G7 — The encounter's provider is a config constant, not the clinician. High. New.

`openemr.js:316` sets `provider_id: config.OPENEMR.PROVIDER_ID` on every encounter create. Nothing
overrides it. `OPENEMR_PROVIDER_ID` is `1`.

Verified on the same visit signed by Bethel (provider 5):

| Row | Provider |
|---|---|
| `form_encounter.provider_id` | **1** |
| `billing.provider_id` | **5** |

One visit, two different providers inside the same chart. The charge is right. The encounter it
hangs off is wrong, and it is wrong identically for every clinician and every patient.

**✅ CLOSED 2026-09-08.** `createEncounter` now takes `provider_id` from the actor the transport
client was built for, falling back to the config value only when the clinician has no provider id on
file. Resolved in the transport rather than at each call site so a route added later cannot
reintroduce it by forgetting to pass one, and the fallback is no longer silent: both encounter-create
routes now warn the clinician that the visit was filed under the practice default and that charges
will not post until an admin sets their provider id. Proven live: the encounter comes back
`provider_id: 5` where it came back `1` before. Pinned by a unit test asserting the source line.

### G8 — Consents are nowhere in OpenEMR. Critical.

Consent to treat, assignment of benefits, practice NPP acknowledgement and ROI-family, each with a
signature image, timestamp, hashed IP and provenance badge, live in `consent_events` and
`client.consents`. No consent route touches OpenEMR. Verified by inspection of every route from
line 8285 to 9200: zero `openemr` references.

Assignment of benefits is what lets the practice bill a payer directly. NPP acknowledgement is a
HIPAA requirement. Neither is in the medical record.

**What closes it:** file the signed consent packet PDF into OpenEMR Documents, which depends on G2
being fixed first. **Not in 4.5's scope.**

### G9 — The Transfer-of-Care ROI is nowhere in OpenEMR. High.

The signing event, per-provider authorizations, checked records categories, the 42 CFR Part 2
protected-information flag, and one generated PDF per prior provider all live in KV plus Drive.

The Part 2 flag matters most. It is the record of what the patient did and did not authorize for
release of substance use, mental health, HIV and genetic records. It is enforced at the data-access
layer in `roiRepository.js` and build-enforced by a unit test, which is good engineering, and it is
enforced in a system that is not the medical record.

**What closes it:** same as G8, file the PDFs into OpenEMR Documents. **Not in 4.5's scope.**

### G10 — The clinical intake record is nowhere in OpenEMR. High.

Roughly 150 fields. Much of it is operational and belongs app-side: matching preferences, scheduling,
caregiver temperament. A clinical subset does not: reported diagnoses, the reported medication list,
advance directive status, ADL and IADL levels, cognitive status and dementia stage, fall risk, home
safety findings, two-person assist.

The clinician sees it as H&P pre-fill and confirms fields into the note, so the confirmed subset
reaches OpenEMR as note narrative. The rest, including advance directive status, does not.

**What closes it:** decide which fields are clinical and write those, most naturally as part of the
H&P. Advance directive status should arguably be its own OpenEMR field. **Not in 4.5's scope.**

### G11 — The RN's care-tier determination is nowhere in OpenEMR. Medium.

`client.careTier` holds the A1 to A4 or B track an RN assigns at the H&P. It is a clinical acuity
judgement that drives the care plan and the visit frequency. It appears in the note narrative only
if the clinician happened to type it.

**What closes it:** stamp the track into the H&P note, or carry it as a problem-list entry.
Cheapest of the gaps to close. **Not in 4.5's scope.**

### G12 — Patient-facing visit summary and follow-up instructions are nowhere in OpenEMR. Medium.

`patientSummary` and `followUpInstructions` on `encounter_billing`, added in 4.3, are clinician-authored
text shown to the patient in the portal. This is the only visit text a patient ever sees, which makes
it the version of events they will quote back. It is not in the chart.

**What closes it:** append both to the narrative note at sign time, clearly labelled. **Not in 4.5's
scope**, though it is a small addition to a route 4.5 already touches.

### G13 — No audit trail names a human being. Critical.

Covered in full below.

---

## Attribution

**What OpenEMR records for a visit documented by Bethel.**

| Where | What it says | Is that Bethel? |
|---|---|---|
| OpenEMR audit log (`log` table) | The authenticated OAuth user, `gfc-app-api`, for every write | No |
| `form_encounter.provider_id` | `1`, a config constant | No |
| SOAP note signature field | OpenEMR has no note signature concept | Nothing to check |
| Note body | `[GFC CLINICIAN] Bethel Godwins, FNP-C (NPI 1902310568)` as free text | Only as an assertion |
| `[GFC ATTESTATION]` block | `signed_by: Bethel Godwins \| NPI 1902310568` as free text | Only as an assertion |
| Encounter `reason` and `billing_note` | Her name and NPI as free text | Only as an assertion |
| `billing.provider_id` | `5`, Bethel | **Yes** |
| FHIR `Practitioner` | One row, Bethel, NPI 1902310568. `gfc-app-api` is not a Practitioner | Correct, but unlinked |

The audit log itself cannot be produced through the API. Every surface returns nothing usable:

```
GET api/log          -> 404 Route not found
GET api/audit        -> 404 Route not found
GET fhir/AuditEvent  -> 404 Route not found
GET fhir/Provenance  -> 401 Unauthorized
```

So the audit trail can only be reached through the OpenEMR UI or the database directly.

**Does this satisfy "the login drives the note signature, which must match the claim"? No.** The
chain breaks at all three joints.

1. **The login does not drive anything.** There is one shared service account. Bethel has no
   OpenEMR login in this flow. Nothing she does authenticates as her.
2. **There is no note signature.** The attestation is prose in a note body. Any process holding the
   `gfc-app-api` token could have typed it, including one acting for a different clinician. It is
   evidence of what the app asserted, not evidence of who authenticated.
3. **The signature does not match the claim.** The claim's rendering provider is 5. The encounter
   the claim hangs off says provider 1. Same visit, two answers, and the mismatch is systematic
   rather than a one-off.

Add the security finding already on file: `client_secret` is not validated on the password grant,
so any enabled OAuth client is usable without its secret. The `gfc-app-api` password is the entire
perimeter. An account whose password is the only control, whose writes are indistinguishable
between users, and whose log names only itself, is not an account that can carry a signature.

**Verdict.** Attribution today is a documentation convention, not an authentication fact. It is
adequate for test data and it is not adequate for a real patient. The fix is Session 5's
`authorization_code` migration with per-user OpenEMR accounts, and G7 should be fixed now regardless,
because a provider mismatch between encounter and claim is a denial waiting to happen even in a
world where nobody questions attribution.

---

## Records request: a subpoena arrives for one patient

**What OpenEMR can produce today.**

- Demographics.
- Every encounter, with date, reason, place of service, facility and billing note. Reason and
  billing note carry the clinician's name as text.
- The narrative SOAP note per encounter, with the `[GFC CLINICIAN]` header.
- The attestation and any addenda, as text in a second note.
- Vitals, as structured rows and as FHIR Observations.
- The problem list, **with no ICD-10 codes on any entry**.
- Prescriptions: drug, dose, quantity. **No route, no frequency, no date, no prescriber field, no
  encounter link.**
- Allergies, but only those typed into OpenEMR directly.
- The fee sheet: CPT, units, diagnosis pointer, rendering provider.
- Procedure orders, **with no test name and no diagnosis**.
- Appointments, including cancellation tombstones and no-shows.

**What would be missing.**

- The plan of care. Every version, the RN's signature, the client's or POA's co-signature. The
  document that justifies the billed home-visit codes.
- Every consent: treat, assignment of benefits, NPP acknowledgement, ROI-family, and the
  Transfer-of-Care ROI with its per-provider authorizations and Part 2 restrictions. Every signature
  image.
- The intake record, including advance directive status.
- The RN's acuity track.
- The visit summary and follow-up instructions the patient was actually given.
- Any document the app believes it filed.
- The names of the labs and imaging ordered.
- The route and frequency of every prescription.
- Any record of which human authored or read anything.

**What that means in practice.** The response would be assembled from OpenEMR, a Replit KV store and
a Google Drive folder, then reconciled by hand. Opposing counsel would then ask two questions that
have no good answer today: why does the EMR say one provider and the claim another for the same
visit, and why does the audit log show a single service account authored every entry for every
patient. A chart that needs three systems and an explanation is not a defensible chart.

The gap is narrower than it looks, though. Fixing G2 unlocks G1, G8 and G9 in one move, because all
three are PDFs that already exist and simply have nowhere to land. Document read-back is the single
highest-leverage fix on this list.

---

## Retention

**There is no retention policy.** A search across all application code and every document in `docs/`
returns nothing: no schedule, no purge routine, no legal hold, no archival step. The only matches
are unrelated (a two-digit-year date parser, and zero-data-retention requirements for the deferred
AI dictation work).

That is a finding on its own, and it compounds every app-only gap above.

**What it means for each thing that is part of the record but lives app-side:**

- The care plan, its versions and both signature images have no retention behind them. Georgia
  requires adult medical records be kept ten years from the last entry, and HIPAA separately
  requires six years for certain documentation. Confirm both figures with counsel. Neither clock is
  running against anything today.
- Consents and ROIs are the same, with an added wrinkle: the Part 2 authorization record has its own
  federal handling requirements, and it sits in a KV store.
- `activity_log` is currently the **only** trail that names a human. It is the app's interim audit
  and it is what a HIPAA accounting-of-disclosures request would have to be built from. It has no
  retention policy and no immutability guarantee.
- The append-only collections, `care_plan_versions`, `care_plan_cosign_events` and `consent_events`,
  are append-only **by convention in application code**, not by storage guarantee. Anyone with
  database access can rewrite history and nothing would record that they had.
- All of it sits in a Replit KV store, which is **outside the AWS BAA boundary** the architecture
  requires for PHI. That is already known and already slated for RDS migration. This audit adds the
  reason it is urgent: it is not just PHI in the wrong place, it is the only copy of parts of the
  legal record in the wrong place.

**The recommendation.** Do not write a retention policy for the KV store. Close the gaps so the
record lives in OpenEMR, where retention is a property of one system, and let the app keep only
pointers and operational metadata. Where something must stay app-side, say so explicitly in the
policy and give it the same clock as the chart.

---

## Recommended order

Judged by what each unlocks, not by effort.

1. **G2, document read-back.** Unlocks G1, G8 and G9. Highest leverage on the list. Needs the EMR
   maintainer to check the OpenEMR UI first.
2. ~~**G3 and G7**~~ and ~~**G5 and G6**~~ — **done 2026-09-08**, in this PR. Only G5's structured
   route and frequency are still owed, and that is the instance seeding `drug_route` and
   `drug_interval`, not a code change.
3. **G4, allergies.** Small, and a patient safety issue rather than only a records issue.
4. **G13, attribution.** Session 5. Nothing else on this list matters as much for defensibility, and
   nothing else takes as long.
5. **G10, G11, G12**, the remaining clinical content. Cheap individually, none of them urgent.

Two items outside this audit's scope that block the same finish line: the ICD-10-CM load, which is
why the problem list is uncoded, and the billing NPI, which is why sign-and-close has never been
proven end to end through a real signature.

---

## Pass 2

Re-run after 4.5 merges. Same patient, same method. Four items were fixed in this PR and are
re-runnable now via `scripts/verify_shadow_data_fixes.js`; pass 2 re-confirms them and settles the
rest:

- [ ] G2: a document filed by the app is retrievable via FHIR `DocumentReference`
- [x] G3: an order read back carries the diagnosis link AND the test name — closed 2026-09-08
- [x] G5 (date): a prescription read back carries its date — closed 2026-09-08
- [ ] G5 (structured): route and frequency store in their own columns — waits on the option lists being seeded
- [x] G6: a prescription read back carries its encounter — closed 2026-09-08
- [x] G7: `form_encounter.provider_id` equals the acting clinician — closed 2026-09-08
- [ ] G1: whether a signed care plan is retrievable from OpenEMR
- [ ] Re-count the gaps and update the number at the top of this file

Everything in the table classified MIRRORED should be re-asserted by stored value, never by status
code. Both Phase 6B failures and both prescription defects in this audit returned 200.

---

_Probe scripts for this pass are not committed. They drive `openemr.js` and `clinicalRepository.js`
directly and are reproducible from the evidence column above. The four re-runnable 4.5 probes in
`scripts/` cover the MIRRORED rows._

_TEST DATA written this pass and left in place, consistent with prior sessions: encounter
`a2b2daec-b0ae-4eb7-afe9-966e59100409` (eid 32) on TEST PatientOne, with one charge (id 14), two
procedure orders (ids 11 and 12), one prescription, two SOAP notes and one document upload._
