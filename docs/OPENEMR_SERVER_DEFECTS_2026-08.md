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
