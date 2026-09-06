# OpenEMR server-side defects — for the EMR maintainer

_Filed 2026-08-22 from Session 4.1 verification. Instance: `emr.godwinsfamilycarellc.com`,
OpenEMR **7.0.4**, FHIR R4 4.0.1. All probes ran as `gfc-app-api` against dev patient
**TEST PatientOne** with TEST DATA only._

These are **defects in the OpenEMR installation, not in the GFC app**. The app degrades
gracefully on both and needs no change once they are fixed. Neither is an OAuth scope or
ACL problem — both were re-tested after the `gfc-app-api` ACL fix landed, with a token
carrying the relevant `user/vital.*` and `user/document.*` scopes.

---

## Defect 1 — Vitals REST endpoint 500s unconditionally

**Endpoint:** `POST /apis/default/api/patient/{pUUID}/encounter/{encUUID}/vital`

**Response:** HTTP 500
```
Cannot assign null to property OpenEMR\Services\VitalsCalculatedService::$authUserId of type int
```

**Not payload-dependent.** Five payload shapes were tested against a freshly created
encounter and every one returned the identical error:

| Variant | Payload | Result |
|---|---|---|
| A | BP + HR + temp + weight + height (triggers BMI calc) | 500 |
| B | BP + HR + temp (no weight/height → no BMI calc) | 500 |
| C | BP only | 500 |
| D | weight only | 500 |
| E | note only | 500 |

`GET .../vital` on the same encounter returns 404 (no rows were ever written).

**Diagnosis:** `VitalsCalculatedService::$authUserId` is typed `int` and is being assigned
`null`. The service is resolving the acting user from session state that is populated in the
web-UI request path but not in the OAuth2/REST request path. Because variant E (a note with
no measurements) also fails, the failure is at service construction, before any vitals
calculation — so no payload shape avoids it.

**Note this is isolated to vitals.** Encounter creation, SOAP notes, problem-list, allergy,
and medication writes by the same user with the same token all succeed, so the session user
is available to those services. Only the vitals service reads it from wherever it is null.

**Fix direction:** patch `VitalsCalculatedService` to accept a nullable/int-defaulted
`authUserId` (or to resolve the user the same way the working services do), or upgrade
OpenEMR past this bug.

**App behavior meanwhile:** the vitals form write is best-effort. All readings — including
**both-arm blood pressures verbatim** — are always serialized into the encounter note, so no
clinical data is lost, and the clinician sees a warning that the discrete vitals row was not
created. Re-test this endpoint after the fix; no app change is required.

---

## Defect 2 — Document endpoints 500 on a SQL binding bug

**Correction to the earlier report.** This was previously recorded as a probable
`sites/default/documents` write-permission issue. That was wrong. The full stack trace shows
a **SQL syntax error in application code**; the filesystem is not implicated.

**Endpoints:** `GET` and `POST /apis/default/api/patient/{pUUID}/document`

**Response to GET:** HTTP 500
```
query failed: SELECT id FROM categories WHERE replace(LOWER(name), ' ', '') = ?
Error: You have an error in your SQL syntax; check the manual that corresponds to your
MySQL server version for the right syntax to use near '?' at line 1
```

**Stack (verbatim from the response):**
```
src/Services/DocumentService.php at 92:sqlQuery
src/Services/DocumentService.php at 102:getLastIdOfPath()
src/RestControllers/DocumentRestController.php at 33:getAllAtPath(<pUUID>, )
apis/routes/_rest_routes_standard.inc.php at 5856:getAllAtPath(...)
```

**Diagnosis:** `DocumentService.php:92` calls `sqlQuery()` with a `?` placeholder but without
passing the bind-parameter array, so the literal `?` reaches MySQL and the statement fails to
parse. Every call that resolves a document category path goes through
`getLastIdOfPath()`, which is why **both listing and upload fail**.

**The POST surfaces differently, same root cause.** Uploading returns:
```
RestControllerHelper::getResponseForPayload() expects a string, array, numeric,
or JsonSerializable object, bool given.
```
The category lookup fails, the service returns `false`, and the response helper rejects the
boolean. Every category path tested returns this: `/Medical Record`, `Medical Record`,
`/Patient Information`, `/Lab Report`, `/gfc_app`, and an auto-create path. `/` returns the
raw SQL error directly, and `/Categories/Medical Record` returns 404.

**No client-side workaround exists.** FHIR `DocumentReference` create is advertised in the
instance CapabilityStatement (`DocumentReference: search-type, create, read`) but
`POST /apis/default/fhir/DocumentReference` returns:
```
HTTP 404 {"message":"Route not found"}
```
so the FHIR path cannot substitute for the broken standard-API endpoint.

**Fix direction:** pass the bind parameter to `sqlQuery()` at `DocumentService.php:92`, or
upgrade OpenEMR past this bug. If FHIR `DocumentReference` create is meant to be available on
7.0.4, the route registration is also missing.

**App behavior meanwhile:** signed care-plan PDFs are still generated and stored to the
HIPAA Google Drive folder and referenced on the client record; only the OpenEMR Documents
copy is skipped, and the failure is logged rather than raised. A completed co-signature is
never voided by this. Re-test uploads after the fix; no app change is required.

---

## Not a defect — 4.2 preflight item (OAuth client scopes)

Recorded here so it is not rediscovered mid-build. The confidential client
**"GFC Care Platform (server)"** was registered for Session 4.1 at least privilege: 40 scopes
covering clinical read/write, with **no appointment scopes**. Consequently:

```
GET /apis/default/api/patient/{pUUID}/appointment  → 401 Unauthorized
GET /apis/default/fhir/Appointment?patient={pUUID} → 401 Unauthorized
```

OpenEMR binds scopes **at registration** and cannot widen them afterwards, so Session 4.2
(clinician scheduling) needs a newly registered client that additionally carries
`user/appointment.read`, `user/appointment.write`, `user/Appointment.read`, and
`user/list.read`. As in 4.1, the app can register the client dynamically, but an OpenEMR
administrator must **enable** it under Administration → System → API Clients before it can
issue tokens.

---

## Session 4.4 preflight findings (2026-09-04) — API surface gaps and two more quirks

_Probed against the same instance (OpenEMR 7.0.4, `gfc-app-api`, TEST PatientOne) with the
4.2 appointment-scoped client. Cross-checked against the 7.0.4 route table
(`apis/routes/_rest_routes_standard.inc.php`)._

### Gap 1 — No write API for prescriptions, orders, billing, or encounter sign/close

| Need (spec §2/§3) | 7.0.4 standard API | Result |
|---|---|---|
| Prescription write | `GET /api/prescription`, `GET /api/prescription/:uuid` only | **No POST.** GET also 401s — `user/prescription.read` is not on the client |
| Procedure / lab order write | `GET /api/procedure`, `GET /api/procedure/:uuid` only | **No POST.** GET 401s likewise |
| Billing / fee-sheet row | none — `/api/billing`, `/api/fee_sheet`, `.../encounter/:e/billing` all 404 | **No route at all** |
| Encounter sign / close | no concept in either API | — |
| Encounter update (`billing_note`, etc.) | `PUT /api/patient/:puuid/encounter/:euuid` exists | **500** — `EncounterService::updateEncounter` returns the string "You are not authorized to see this encounter." (the `sensitivities` ACL check fails for `gfc-app-api`) and the controller crashes on the string. Server-side ACL item. |
| Code-table search (ICD-10 / CPT) | none — `/api/code*` 404; `FHIR ValueSet` serves `list_options` + appointment categories only (checked `FhirValueSetService.php`) | **No code search anywhere in the API** |

**App behavior (spec §2.4 interim, in place):** the app keeps `encounter_billing`,
`prescriptions`, `clinical_orders`, `encounter_attestations`, `encounter_addenda` and
writes a machine-parseable **GFC structured note** (a second `soap_note` row) onto the
encounter, regenerated on every change. `billing_note` and a clinician stamp are set on the
encounter **at create** (the POST accepts them; the PUT does not work). Back-office staff
key the charge from the structured note / Billing note until a billing write exists.

**For the maintainer:** (a) widen the `gfc-app-api` ACL group to include `sensitivities`
so the encounter PUT works; (b) when the Session 5 client is registered, add
`user/prescription.read`, `user/procedure.read`, `user/list.read`, `user/ValueSet.read`,
`user/drug.read`; (c) confirm the **ICD-10-CM code set is loaded** (Administration →
Other → External Data Loads) — see Quirk 2.

### Quirk 1 — `soap_note` / `vital` routes key by NUMERIC pid + encounter id (app fix landed)

`POST /api/patient/:pid/encounter/:eid/soap_note` takes the **numeric** `pid` and `eid`
(no uuid translation in `EncounterRestController`). Passing uuids — which the 4.1 build did —
is silently coerced to `pid 0 / encounter 0`, so **every note written by 4.1 landed
orphaned** (visible as `pid: 0` rows with no encounter). Fixed in `openemr.js` this session:
ids are resolved before every note/vital call. The orphaned 4.1 test notes remain on the
dev instance (TEST DATA); pre-4.4 encounters therefore show "no narrative note" in the app
and cannot be signed until re-documented.

Related: the note **list** query (`EncounterService::getSoapNotes`) joins `forms` to
`form_soap` on `form_id` **without a `formdir` filter**, so a non-SOAP form row on an
encounter whose `form_id` collides with another encounter's `form_soap.id` leaks that other
note into the list (reproduced live: encounter 21 listed encounter 20's note). The app now
reads its notes by the `sid` it recorded and treats the list as a hint only. Also: the
validator answers **HTTP 200 with a validation map** (e.g. `{"plan":{"LengthBetween::TOO_SHORT":…}}`)
when a section is under 2 characters — no note is written; the app now detects the missing
`sid` and refuses instead of reporting success.

### Quirk 2 — FHIR Condition read-back drops the ICD-10 code

`POST /api/patient/:puuid/medical_problem` with `diagnosis: "ICD10:E11.9"` succeeds, but
`GET /fhir/Condition?patient=…` returns the problem with `code.text` (the title) only and
**no `coding`**; `GET /api/patient/:puuid/medical_problem` (list and single) returns an
empty `data` array for the same patient. `BaseService::addCoding()` never drops an entry
(it returns the code even with an empty description), so either the `diagnosis` column is
not being read back on this build or the FHIR mapper skips codes it cannot describe — the
latter would mean **ICD-10-CM is not loaded** into the `codes` table. Cannot be told apart
from the API; please check the code-set load and the FHIR Condition output.

**App behavior meanwhile:** the T1 carry-forward lists the OpenEMR problem, flags it as
needing a code, and fills the code back in from the app's own prior encounter records for
that problem uuid once it has been coded once (`mergeCandidateSources`). A code typed in
full is accepted on format; OpenEMR resolves the description on read-back once the set is
loaded. The app never keeps a code list.

### Quirk 3 — Encounter lists return every row twice

Both `GET /fhir/Encounter?patient=…` and `GET /api/patient/:puuid/encounter` return each
encounter **twice** for TEST PatientOne (24 rows for 12 encounters, eids `26,26,25,25,…`),
a join duplication on the server. The app's FHIR bundle flattener now dedupes by
resourceType/id, which also fixes the doubled rows in the 4.1 chart's encounter section.

### Verified OK this session
Token + 41 scopes incl. `user/appointment.read/write` (the 4.2 client swap is live for this
env); FHIR reads; appointment list; `POST encounter` accepting `billing_note`; numeric-id
`soap_note` POST/PUT/GET-by-sid; `medication` POST (used as the in-chart copy of an Rx);
whole-instance `GET /fhir/Encounter` for the coding queue. Vitals still 500 unconditionally
(Defect 1 unchanged, also with numeric ids). `GET /fhir/Encounter/{id}` (single) 403s on the
org-policy ACL while the search works.

---

## 8.4 upgrade record (2026-09-05) — what changed, what is verified, what is still open

The live instance was upgraded in place per Master Setup Guide v4 Phase 6A (steps 1–4 by the owner; step 5 by the app team). Test data only.

**Verified live on 2026-09-05 (v2 client, password grant):**
- `GET /apis/default/api/version` → `{"v_major":8,"v_minor":4,"v_patch":0,"v_database":543,"v_acl":13}`. Schema upgrades 8.2.0 → 8.3.0 → 8.4.0 completed cleanly; Connectors settings and both APIs survived the image change.
- `.well-known/openid-configuration` advertises **226 scopes** (7.0.4 advertised fewer). Every one of the app's 43 `config.js` scopes is still supported. Grant types: `authorization_code`, `password`, `refresh_token`.
- **`user/prescription.write` exists** on 8.4 (the guide flagged its spelling as unconfirmed — it is exactly that string). `user/prescription.read`, `user/procedure.read`, `user/list.read`, `user/ValueSet.read`, `user/drug.read` all exist.
- **`user/procedure.write` does NOT exist** on 8.4. The Phase 6B order route therefore cannot be guarded by it; per the guide's own fallback rule it goes under `user/encounter.write`. Other write scopes 8.4 advertises that the app does not request: `user/Practitioner.write`, `user/Organization.write`, `user/facility.write`, `user/insurance.write`, `user/insurance_company.write`, `user/message.write`, `user/practitioner.write`, `user/surgery.write`, `user/transaction.write`, `user/dental_issue.write`.
- **Scope over-request is tolerated:** asking the v2 client for the 49-scope set returns a token granted only the subset it holds (HTTP 200, 42 scopes). The `config.js` list can therefore carry the 8.4 additions before the deployed credentials are swapped.
- The v2 client (`dlHHtxPDc1gS…`) still authenticates on 8.4 with its 41-scope grant.

**v3 client registered (Phase 6A step 5 / 9.3):** dynamic registration at `/oauth2/default/registration`, `application_type=private`, `client_name="GFC Care Platform (server) v3 8.4"`, `token_endpoint_auth_method=client_secret_post`, `redirect_uris=["https://app.godwinsfamilycarellc.com/oauth/callback"]`, scope = the 43 current + the 6 additions above. Registered on the first attempt; all **49 scopes echoed back, none stripped**. Client id begins `EBZL0Xzvw-`. Secret handed to the owner for Secrets Manager only; never in the repo. Capability statement saved at `docs/openemr/capability-8.4.json` (34 FHIR resources).

**Not yet verified (needs the v3 client enabled + credentials swapped, then the Part VII.4 walk):**
- `POST /api/prescription` exists and accepts a record (Gap 1 row 1).
- Vitals `POST …/vital` no longer 500s (Defect 1) — re-enable the native write in Session 4.5.
- Document `POST/GET …/document` no longer 500s (Defect 2) — re-enable the OpenEMR copy in Session 4.5.
- Encounter PUT after the `sensitivities` ACL grant (Phase 8.6); FHIR Practitioner/Organization/Coverage after the org-level read grant.
- Whether 8.4 added an appointment update route (the tombstone swap stays until proven).
- FHIR Condition coding after the ICD-10-CM load (Quirk 2), encounter-list duplication (Quirk 3), the `soap_note` numeric-id and 200-with-map quirks (Quirk 1).

**Still no API route on 8.4** for fee-sheet charges or procedure-order creation — Phase 6B stands as written.
