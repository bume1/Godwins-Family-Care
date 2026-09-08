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

### 8.4 preflight results (2026-09-06, v3 client enabled, TEST PatientOne pid 1 / encounter eid 7)

Token: the v3 client returns **47 granted scopes** (the two `api:*` meta scopes are never echoed; 41 → 47 is the sync-indicator change). `openemr.getStatus()` with the v3 credentials: `connected: true, grantedScopeCount: 47, appointmentScopes: true`.

| Guide VII.4 row | 7.0.4 state | 8.4 result (verified live) | App action |
|---|---|---|---|
| **Vitals** `POST patient/{pid}/encounter/{eid}/vital` | 500 unconditionally (Defect 1) | **FIXED.** 201 `{"vid":16,"fid":41}`; row readable at `…/vital/16` (carries `euuid`, `date`); surfaces in FHIR Observation as the vital-signs panel + component rows. List GET `…/vital` returned an empty array for the encounter — read by vid or via FHIR Observation. | 4.5: re-enable the native write; keep the both-arm BP text in the note by design |
| **Documents** `…/document` | 500 SQL-bind bug (Defect 2) | **500 gone. Route re-keyed on 8.4:** `/api/patient/{pid}/document` takes the **numeric pid** (uuid → 400 `Invalid pid`; swagger confirms `{pid}`). `POST` multipart (`document` field, `?path=/Test`) → 200 `true` (no id returned). **Read-back not yet proven:** `GET …/document?path=…` returned 404 for `/Test`, `/Medical Record`, empty and absent `path`; FHIR `DocumentReference` returns **403** on both the v2 and v3 clients (so it is an ACL/policy item, not a scope item). Where the probe file landed is unconfirmed. | 4.5: switch the document path from `puuid` to `pid` (`openemr.js:503`), re-enable the OpenEMR copy only after a read-back path is proven. **Owner (Phase 8.6):** add DocumentReference (and Coverage) to the org-level read grant, then re-probe. |
| **Prescription** `POST /api/prescription` | no write route (Gap 1 row 1) | **CLOSED.** 201 `{"id":1,"uuid":"a2ad5540-…"}` with body `{patient_id, drug, dosage, quantity, provider_id}` (that is the whole schema: no route/frequency/refills/sig fields — pack the sig into `dosage` or keep the medication-list row for the structured sig). The record **surfaces in FHIR `MedicationRequest`** for the patient; `GET /api/prescription` lists it alongside `lists`-table medications. Scope `user/prescription.write` is the guard. | 4.5: switch to the native POST; confirm read-back through MedicationRequest (proven) before retiring the app-side `prescriptions` store |
| **Encounter PUT** `patient/{puuid}/encounter/{euuid}` | 500 on the `sensitivities` ACL | **WORKS without the ACL change.** 8.4 requires two extra body fields, `user` and `group` (200 with a validation map naming them otherwise); with `{reason, user, group}` the PUT returns 200 and the updated row. The 7.0.4 crash did not reproduce. | The app does not PUT encounters today. When 4.5 adds the per-visit facility/POS change, send `user` + `group`. The `sensitivities` grant may still be wanted for reads; no longer blocks the PUT. |
| **Providers** FHIR `Practitioner`, `Organization` | 403 org-policy ACL | **FIXED** (200, totals 1 and 2) on both the v2 and v3 clients. | 4.5: keep the degraded fallback code path, but it should no longer trigger |
| FHIR `Coverage` | 403 | still **403** on both clients | Owner (Phase 8.6): org-level read grant. B-series reads coverage. |
| **Appointments** update route | none | **Still none.** Swagger for `/api/patient/{pid}/appointment/{eid}` lists only GET and DELETE. | Tombstone swap stays |
| **Orders** `POST /api/procedure` | GET-only | still **404 Route not found** on POST | Phase 6B route stands; guard under `user/encounter.write` (no `user/procedure.write` on 8.4) |
| **Fee-sheet charge** | no route | no route | Phase 6B route stands |
| **FHIR Condition coding** | text only (Quirk 2) | 3 problems, **0 with coding** — the code table is still empty | Owner (Phase 8.6): ICD-10-CM load, then re-probe |
| **Encounter list duplication** (Quirk 3) | every row twice | **persists** on 8.4 (28 rows, 14 unique) | dedupe stays |
| Encounter row shape | — | 8.4 rows also carry `provider_uuid`, `provider_username`, `facility_uuid`, `billing_facility_uuid` (null/ids) | useful for the 4.5 per-visit facility picker and signer→provider mapping |

Test artifacts left on TEST PatientOne (labeled): vitals row vid 16 on eid 7, prescription "TEST DATA amoxicillin", one text document "probe-84-TEST.txt" whose category is unconfirmed.

---

## Phase 6B acceptance (2026-09-06) — ✅ **GAP 1 CLOSED** for charges, orders and code search

The patch is installed on the live instance as derived image `gfc/openemr:8.4.0-p1`
(route-map wrapper, no diff, built from `docker-compose.yml` so no `docker compose pull`
can revert it). Acceptance ran end to end against a TEST encounter with the app's own
token. **Run 3: 17 of 17, zero failures.** Gap 1 is closed for the fee-sheet charge, the
procedure order and code search.

It took three runs. Runs 1 and 2 each failed one assertion, and both failures were defects in
our own controller rather than the server — recorded below, because the second was introduced
by the fix for the first and that is worth remembering. The server side was never the problem:
routes resolved, both gates held, writes landed in the right tables, and the `die()` guard
returned clean JSON from run 1 onward.

| Assertion | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `POST …/encounter/{eid}/billing` → 201, row in `billing` | ✅ | ✅ | ✅ |
| `GET …/encounter/{eid}/billing` → 200, reads back | ✅ | ✅ | ✅ |
| billed `code` stored (the CPT, `99348`) | ✅ | ❌ stored `I10`, the diagnosis | ✅ |
| modifier / units / fee / rendering provider stored | ✅ | ✅ | ✅ |
| diagnosis pointers `ICD10\|E11.9:ICD10\|I10:` | ❌ `ICD10\|Array:…` | ✅ | ✅ |
| `POST …/encounter/{eid}/order` → 201 | ✅ | ✅ | ✅ |
| `GET …/encounter/{eid}/order` → 200, codes attached | ✅ | ✅ | ✅ |
| order `procedure_code` stored (`85025`) | — | — | ✅ |
| order `diagnoses` stored (`ICD10:E11.9;ICD10:I10`) | not tested | not tested | ✅ |
| bad encounter → clean JSON 400, never the `die()` page | ✅ | ✅ | ✅ |
| `GET /api/codes?type=ICD10&search=…` → 200 | ✅ | ✅ | ✅ |

Run 3, verbatim from the charge read-back:

```json
{"id":3,"code_type":"CPT4","code":"99348","code_text":"Home visit, established patient (TEST DATA)",
 "modifier":"25","units":1,"fee":"187.50","justify":"ICD10|E11.9:ICD10|I10:","provider_id":5,
 "authorized":1,"billed":0,"activity":1}
```

The bad-encounter guard, which is what keeps `addBilling()`'s `die()` from ever emitting an
HTML page mid-response:

```json
{"validationErrors":{"encounter":["No such encounter for this patient"]},"internalErrors":[],"data":[],"links":[]}
```

`GET /api/codes` returns 200 with **0 rows**. That is the route working against empty tables —
ICD-10-CM has not been loaded (see below). It is not a defect in the route.

### Two corrections to the record

**1. The 401s were a SCOPE failure, not an ACL failure. The earlier entry in this file
was wrong and cost an install cycle.**

OpenEMR's standard API derives the required scope from the route path:
`HttpRestRouteHandler::checkSecurity()` takes the resource from the last path segment
and the permission from the HTTP method, then `AuthorizationListener::onRestApiSecurityCheck()`
requires `user/<resource>.<permission>` on the access token. So
`POST …/encounter/{eid}/billing` demands `user/billing.c`, which no client held and which
the server would not even accept at registration (`invalid_scope … Check the user/billing.read
scope`). The patch now registers five scopes at build time (`gfc-add-scopes.php`):
`user/billing.read/.write`, `user/order.read/.write`, `user/codes.read`. A **v4 client**
carrying all 54 scopes was registered and enabled; the routes answered immediately.

How to tell the two layers apart next time, from the message alone:

- ACL refusal → `"Organization policy does not have permit access resource"`
- scope refusal → `"Unauthorized"`

The `encounters`/`coding_a` ACL grant the owner made is still correct and still required —
it is the second gate, and it is what keeps a note-writer from posting charges per Master
Setup Guide v4 §8.5. It simply was not the thing returning 401.

**`docs/GFC_Release_Runway.pdf` (commit `b0d81db`) records the wrong diagnosis and needs
regenerating.**

**2. Two defects in the controller, both found by acceptance, both ours.**

*Run 1* stored `justify` as `"ICD10|Array:ICD10|Array:"`. The app sends diagnoses as objects
(`{code_type, code}`); casting one straight to string yields the literal `Array`. The charge
looked correct in Billing Manager and would have carried broken diagnosis pointers onto the
claim — found on a denial, not in the UI.

*Run 2*, after that fix, stored the charge's `code` as `I10` — the last **diagnosis** — with
`code_type` still `CPT4`. The fix's loop had reused the variable name `$code`, which already
held the CPT being billed, so it overwrote the home-visit E/M before `addBilling()` ran.
Worse than the first defect: it bills the wrong code entirely.

Both are now one shared helper, `normalizeDiagnoses()`, because the charge path and the order
path read the same input into two different output formats:

| Column | Format | Read by |
|---|---|---|
| `billing.justify` | `ICD10\|E11.9:ICD10\|I10:` | `Claim::diagIndexArray()` |
| `procedure_order_code.diagnoses` | `ICD10:E11.9;ICD10:I10` | procedure order form |

The order path carried the identical `Array` defect and nobody had noticed, because the
first acceptance run posted an order with **no diagnoses**. The run now sends object-shaped
diagnoses on both and asserts both stored formats.

Both fixes are deployed (controller sha256 `c17bdef5…`, rebuilt 2026-09-06) and run 3 is clean.

**The lesson worth keeping:** run 1 fixed a symptom at one call site instead of the cause, and
the fix introduced a worse bug — a variable-name collision that billed the diagnosis instead of
the E/M. Neither would have failed loudly in the UI. The charge row looked correct in Billing
Manager both times; it would have surfaced as a denial weeks later. Acceptance is what caught
both, and only because it asserts stored values rather than HTTP status codes.

### Gap 1 status after this

| Capability | State |
|---|---|
| Fee-sheet charge write | ✅ live, proven end to end |
| Procedure order write | ✅ live, proven end to end |
| Code search (`GET /api/codes`) | ✅ route live; returns 0 rows until ICD-10-CM is loaded |
| Prescription write | ✅ native on 8.4 (`POST /api/prescription`) |
| Encounter sign / close | app-side (spec §3); no server concept, unchanged |

Session 4.5 can now be proven against the live EMR: sign-and-close reaches Billing Manager.

### Still open, separately

- **Billing facility is not a charge field and never was.** `addBilling()` has no such
  parameter and the `billing` table no such column; it lives on
  `form_encounter.billing_facility`. The per-visit facility picker is Session 4.5 scope.
- **ICD-10-CM is not loaded** (Administration → Other → External Data Loads). This does
  **not** affect the charge write — `billing.justify` is free text and the app supplies the
  codes. It affects three things only: `GET /api/codes` returns 0 rows, FHIR `Condition`
  reads back uncoded, and OpenEMR's own Fee Sheet diagnosis picker is empty.
- Org-level read for FHIR **DocumentReference** and **Coverage** (both still 403), and
  `sensitivities` — Phase 8.6 items on the same ACL screen.

---

## Session 4.5 preflight (2026-09-06) — ❌ **BLOCKED: the deployed OAuth client is still the August v2 one**

Session 4.5 stopped at preflight item 1 and wrote no native-write or 6B code. The server is
fine; the credential swap named as the session's prerequisite was never done.

**Evidence.** The deployed `OPENEMR_CLIENT_ID` is `dlHHtxPDc1gS-_hKVxhYvC4MPFLmLGY7G1x-khy8ZjQ`
— the Session 4.2 appointment client registered in August, recorded verbatim under the 08/2026
entry in `CLAUDE.md`. Not the v3 client (47 scopes), and not the v4 client (54).

| Check | Expected | Actual |
|---|---|---|
| Granted scopes | 54 (v4) | **42** |
| `user/billing.*`, `user/order.*`, `user/codes.read` | granted | **none granted** |
| `user/prescription.*`, `user/procedure.read`, `user/drug.read`, `user/ValueSet.read` | granted | **none granted** |
| `/api/version` | 8.4.0, db 543 | ✅ 8.4.0, db 543 |
| Unauthenticated `GET /api/codes` | 401 (route present) | ✅ 401 — **the 6B patch is installed and healthy** |

**Which layer refused us: the SCOPE layer, not the ACL.** Every 6B route and
`/api/prescription` answered `401 {"message":"Unauthorized"}`. An ACL refusal reads
`Organization policy does not have permit access resource` — and we did see exactly that
wording on DocumentReference and Coverage, which confirms the two layers are distinguishable
here and that we are reading them correctly.

**Two things are required, not one.** The app was requesting 49 scopes; a token carries the
*intersection* of requested and registered. Swapping the env to the v4 client alone would
still have left the 6B routes at 401. Both the env swap and the 54-scope list (commit
`838e067`) are needed.

### Preflight items that DID pass, against the current credentials

| Item | Result |
|---|---|
| Vitals `POST` (defect 1, was an unconditional 500 on 7.0.4) | ✅ **fixed on 8.4** — HTTP 201 `{"vid":17,"fid":43}`, and the FHIR `Observation` vital-signs bundle grew 138 → 154 |
| Encounter `PUT` with `user` + `group` | ✅ succeeds |
| Encounter `PUT` without them | ⚠️ HTTP **200** carrying `validationErrors` for the two missing keys — no row written. Same trap as the `soap_note` 200-with-validation-map; status code alone is not proof of a write |
| FHIR Condition / MedicationRequest / Practitioner reads | ✅ 200 |
| FHIR DocumentReference / Coverage | ❌ 403 ACL — unchanged, Phase 8.6 |
| Encounter duplication | ❌ unchanged — 28 rows for 14 encounters; the app-side dedupe is still load-bearing |

### Three app-side defects this preflight exposed (fixed in this branch)

1. **The document route now rejects the patient uuid.** `POST /api/patient/{uuid}/document`
   answers `400 {"validationErrors":{"pid":["Invalid pid"]}}` on 8.4; the numeric-pid form
   returns 200. Both call sites swallow the error, so the authored and co-signed care-plan
   PDFs had silently stopped filing into OpenEMR. The Drive copy is written first and was
   unaffected, which is why nothing looked wrong. Fixed in `efc0823`.
   Read-back remains unproven: the route returns a bare `true` rather than a document id, the
   standard-API document list 404s, and DocumentReference 403s. The patient-facing care-plan
   PDF stays on the Drive reference.
2. **A 404 on the appointment and medication lists means "empty", not "broken".** A linked
   patient with an empty calendar answers 404 with an empty body — the quirk already handled
   for `soap_note`. Both were raised as errors, so every newly linked patient's Appointments
   tab showed a red `OpenEMR error … (HTTP 404)` in place of an empty state. Fixed in `b251af9`.
3. **A narrowed token was indistinguishable from a healthy one in the UI.** This is why the
   stale client survived the upgrade. OpenEMR reports a scope shortfall by issuing a smaller
   token, not an error, so every route the app already used kept working and the workspace
   showed a green "OpenEMR connected". The status probe now reports requested vs granted,
   the missing scopes by name, and per-capability booleans, and the workspace banners it.
   Fixed in `6d180fd`.

### Not a defect, but worth an owner's eye

- **Eight duplicate `Demo Client` patient records** exist on the dev instance
  (`a2a76cc8`, `a2a76cd5`, `a2a76f11`, `a2a76f1c`, `a2a76f25`, `a2a77014`, `a2a77078`, plus
  `TEST LINKPROBE` / `TEST LINKFIX`). Consistent with repeated link attempts each creating a
  new patient. TEST DATA, so harmless now, but the link step should be checked for
  idempotency before real patients are enrolled.
- **The billing NPI is still unset**, so sign-and-close is blocked by design. Session 4.5's
  charge write cannot be proven end to end until an admin sets it under
  Coding queue → Billing settings. This is independent of the credential swap — both are
  needed before 4.5 acceptance can run.

### Correction to Master Setup Guide v4.1 §8.6 — the org-level read list is incomplete

§8.6 step 1 tells the owner to "grant org-level read so `/fhir/Practitioner`,
`/fhir/Organization`, and `/fhir/Coverage` stop returning 403." Verified against the live
instance on 2026-09-06, that list is now wrong in both directions:

- **Practitioner and Organization no longer need it.** Both return 200 on 8.4 without any ACL
  change (the upgrade fixed them). Anyone working the guide literally will see them already
  passing and conclude the grant is done.
- **DocumentReference is missing from the list and still 403s.** It is the one the clinician
  actually sees, as the red banner on the chart's Documents card.

So the grant is still required, but for **Coverage, DocumentReference, and `sensitivities`** —
not for the three resources the guide names. Grant org-level read at the group level rather
than working the guide's resource list item by item.

One command confirms it, before and after:

```
node -e 'const o=require("./openemr.js");const e=o.forActor({id:"p",name:"p",role:"admin"});
const u="a284d5c2-670e-4a62-aa95-2d1aa629003c";
Promise.allSettled([e.getDocumentReferences(u),e.getPractitioners()]).then(r=>
r.forEach((x,i)=>console.log(["DocumentReference","Practitioner"][i], x.status==="fulfilled"?"200 OK":x.reason.status)));'
```

Today it prints `DocumentReference 403` / `Practitioner 200 OK`. Both 200 means the grant landed.

Regenerate §8.6 with the corrected list when the guide is next revised.

### ✅ Phase 8.6 org-level read grant — CLOSED 2026-09-08 (owner action)

The owner widened the `gfc-app-api` ACL group. Verified live immediately after, on the same
credentials that were returning 403 an hour earlier:

| Resource | Before | After |
|---|---|---|
| FHIR `DocumentReference` | 403 ACL | **200** |
| FHIR `Coverage` | 403 ACL | **200** |
| FHIR `Encounter/{id}` | 403 org-policy ACL | **400** (bad id — the ACL layer is cleared) |
| FHIR `Practitioner` | 200 | 200 (1 row) |
| FHIR `Condition` | 200 | 200 (3 rows) |

The red "EMR read failed" banner on the chart's Documents card is resolved at the source. The
`permissionPending` presentation added in this branch stays in place: it costs nothing now and
correctly distinguishes a future permission gap from a genuine fault.

**Still open, and unrelated to the ACL:** the deployed `OPENEMR_CLIENT_ID` is *still* the August
v2 client (42 granted scopes, not 54). The owner reported the secrets as "correct" — they are
valid credentials, which is exactly the failure mode: OpenEMR issues a working token for the old
client without complaint, so a check that only asks "are these valid?" passes. The values must be
**replaced** with the v4 client's, not verified.

### CORRECTION 2026-09-08 — the v4 client swap WAS deployed; the build sandbox was stale

The 4.5 preflight above reported the deployed client as the August v2 one. That reading was
taken from the **build sandbox's** environment, which held `dlHHtxPDc1gS…`. The Replit
deployment holds `mRVhrg5HB…` — the v4 client — and has all along. The sandbox and the
deployment do not share a secrets store, and nothing in the earlier probe distinguished them.

Re-run against the v4 client id, everything the session was blocked on passes:

| Check | Result |
|---|---|
| Granted scopes | **52** (the 2 absent are `api:oemr` / `api:fhir`, never echoed on 8.4) |
| `user/billing.read/.write`, `user/order.read/.write`, `user/codes.read` | all **granted** |
| `user/prescription.read/.write` | both **granted** |
| `GET …/encounter/28/billing` | **200**, 4 rows |
| `GET …/encounter/28/order` | **200**, 4 rows |
| `GET /api/codes` | **200**, 0 rows (ICD-10 not loaded — data gap, not a defect) |
| `GET /api/prescription` | **200**, 7 rows |

Session 4.5 is unblocked. **Lesson for the next session: verify the client id in the environment
you are actually testing from, and compare it against the deployed one before concluding a
credential swap did not happen.** The scope-shortfall diagnostic added in this branch reports the
truth for whichever environment it runs in — read it from the deployed app, not the sandbox.

### ⚠️ SECURITY — `client_secret` is not validated on the password grant

Found while confirming the client id. Verified on the live instance, five controls:

| Request | Result |
|---|---|
| v4 client id + correct secret | token issued |
| v4 client id + **deliberately wrong secret** | **token issued** |
| v4 client id + **empty secret** | **token issued** |
| non-existent client id | refused, `invalid_client` |
| v4 client id + wrong API-user password | refused, `invalid_grant` |

So on `grant_type=password` this instance authenticates on **client_id existence plus the API
user's password only**. The client secret contributes nothing. Anyone holding the `gfc-app-api`
password and any enabled client id can mint a token carrying that client's full scope set,
without the secret.

Consequences, in order:

1. **Every enabled OAuth client is a live credential**, and disabling the superseded ones (v2, v3,
   and the never-enabled `SQNsx…` duplicate) is a real access control, not tidying. While v2 stays
   enabled, a stale `OPENEMR_CLIENT_ID` keeps working silently — which is exactly how the
   confusion above arose. Disable them and a stale id fails loudly instead.
2. **The `gfc-app-api` password is the whole perimeter** during the dev window. It must be long,
   unique and held only in the secrets store.
3. This is a further argument for the Session 5 migration to `authorization_code` + per-user auth
   and disabling the password-grant global, which the Master Setup Guide already schedules (9.4).

TEST DATA only today, so no PHI exposure. Confirm the behaviour with the EMR maintainer before
HIPAA go-live; it may be an OpenEMR password-grant characteristic rather than a misconfiguration,
but either way the control above (disable superseded clients) applies.

### Facility and POS — owner spec 2026-09-08 (supersedes two earlier notes here)

Two earlier entries in this file were wrong and are withdrawn: one recommended setting
`pos_code` to 12 on the org facility records, the other framed those records as pure
business addresses. The owner's spec:

**POS is a property of the facility record, set once.** Hickory Log's record carries 13 or
14 (pending DCH), the private-residence record carries 12, telehealth carries 10, an office
is 11. A clinician never sees or chooses a POS number.

**The patient selects it.** Each patient lives somewhere fixed, so each patient record is
assigned to a facility — a Hickory Log resident to the Hickory Log record, an Ellijay client
to the private-residence record — and the encounter inherits the facility and its POS from
that assignment.

**The app-side defect this removes.** The app stamped every encounter with one hardcoded
facility and POS 12 from `OPENEMR_FACILITY_ID` / `OPENEMR_POS_CODE`, regardless of who the
patient was. Correct only while every patient is a private residence; the day Hickory Log
goes live it silently puts 12 on claims that should read 13 or 14.

**What 4.5 built.** `client.openEmrFacilityId` (an app-side pointer, because OpenEMR 8.4's
patient record carries no facility field — verified live), an admin-only assignment route,
and `resolveEncounterFacility()` which reads facility and POS from the patient's assignment
at every encounter-create site. The globals are gone from the encounter path; build-enforced.
Telehealth is the one per-visit variation and keys off 4.2's `[GFC location=telehealth]`
appointment marker. An unassigned patient, or a facility with no POS on its record, is
reported and blocks **signing** (`SIGN_NO_FACILITY_POS`) but never blocks documenting the
visit — care happens regardless; claims are what need a verified POS.

**On the org record (ids 3 and 4).** Leave POS blank if OpenEMR allows it, otherwise 11. The
real protection is that no encounter is ever assigned to it, enforced by **unchecking Service
Location** on that record once the private-residence record exists.

**Phase 8.3 actions.** Create the private-residence record (POS 12) and Hickory Log (13 or 14
once DCH confirms); assign each patient to their facility; uncheck Service Location on the
org record. No app change is required for a new facility — add it in OpenEMR with its POS and
assign patients to it.

---

## Shadow-data audit findings (2026-09-08) — three server-side items

_Found by the shadow-data audit pass 1, `docs/GFC_Shadow_Data_Audit.md`. Probes ran live against
8.4.0 (database 543) on the v4 client, patient TEST PatientOne, encounter eid 32. TEST DATA only.
The audit also found four app-side defects; those are recorded in the audit document, not here._

### Defect 3 — Documents file with HTTP 200 but are readable by nothing

**Endpoints:**
- `POST /apis/default/api/patient/{pid}/document?path=/Medical%20Record` returns **200**, body `true`.
- `GET /apis/default/fhir/DocumentReference?patient={uuid}` returns **200**, `total: 0`.
- `GET /apis/default/fhir/DocumentReference` unfiltered returns **200**, `total: 0` for the whole instance.
- `GET /apis/default/api/patient/1/document` returns **404 Route not found**. There is no standard-API read route.

This is with the Phase 8.6 org-level ACL grant in place. `DocumentReference` no longer 403s, it
simply reports nothing exists. Care-plan PDFs have been filed across several sessions.

**Why it matters.** This is the only route the app has for putting a PDF in the chart, and it is
the mechanism blocking the care plan, the consents and the Transfer-of-Care ROI from reaching the
medical record at all. The write gives the app no way to detect failure: the only signal is a 200.

**What the maintainer needs to check, in order:**
1. In the OpenEMR UI, open TEST PatientOne's Documents and look for `ShadowAudit_SHADOWAUDIT-1788890606538.pdf`
   and the `CarePlan_*.pdf` files under `/Medical Record`.
2. If they are there, the files are stored and the FHIR `DocumentReference` provider is not
   surfacing them. Server fix, and the missing standard-API read route should be added too.
3. If they are not there, the upload is a silent write failure and the route should return an error
   rather than `true`.

**App behaviour meanwhile:** the app treats the 200 as success and records `emrDocumented: true`.
That is wrong and the app should assert read-back instead. Recorded as G2 in the audit.

### Defect 4 — Phase 6B order route drops `code_text`

**Endpoint:** `POST /apis/default/api/patient/{pUUID}/encounter/{eUUID}/order`

Sending a correctly shaped payload:

```json
{"codes":[{"code":"85025","code_text":"CBC with differential",
           "diagnoses":[{"code_type":"ICD10","code":"I10"}]}]}
```

reads back as:

```json
{"procedure_order_seq":1,"procedure_code":"85025","procedure_name":"",
 "procedure_order_title":"","diagnoses":"ICD10:I10"}
```

`procedure_code` and `diagnoses` persist. **`code_text` is accepted and never stored** — both
`procedure_name` and `procedure_order_title` come back empty. So an order carries a code but no
human-readable test name, and an order for anything without a code carries nothing at all.

**Fix direction:** in the 6B order controller, write `code_text` into `procedure_order_code.procedure_name`
(and `procedure_order_title` where appropriate) alongside `procedure_code`.

**Scope note:** this sits in our own patch, `docs/openemr-patches/8.4.0-p1/`, not in upstream
OpenEMR. It is ours to fix. The 6B acceptance run passed 17/17 because it asserted the codes and
the diagnosis pointers, which do store, and never asserted the name.

### Not a defect — no audit-log surface exists in the API

Recorded because it shapes what a records request can produce. Every audit surface is unavailable:

```
GET api/log          -> 404 Route not found
GET api/audit        -> 404 Route not found
GET fhir/AuditEvent  -> 404 Route not found
GET fhir/Provenance  -> 401 Unauthorized
```

OpenEMR's `log` table can therefore only be reached through the UI or the database. Combined with
every app write authenticating as `gfc-app-api`, an accounting of disclosures cannot be produced
from OpenEMR through the API for any patient. Not a defect in the installation, and a hard
constraint on go-live. See the attribution section of `docs/GFC_Shadow_Data_Audit.md`.

### Data gap — the drug option lists are empty (blocks structured Rx route + frequency)

`GET /apis/default/api/list/drug_route`, `.../drug_interval` and `.../drug_units` all return
**200 with 0 rows**. OpenEMR resolves a prescription's route and interval against these lists, so
with nothing to resolve to, `route_id` stores null and `interval_id` stores `"0"` no matter what the
app sends. Same class of gap as the ICD-10 load: a data gap, not a defect.

**Consequence:** a prescription in OpenEMR carries drug, dose and quantity in their own columns but
no structured route and no structured frequency.

**App behaviour meanwhile (shipped 2026-09-08):** route and frequency are written into the
prescription's free-text `note`, which does persist, so the sig always reaches the chart. The
structured fields are still sent, so they begin storing the day these lists are seeded with no app
change. Recorded as G5 in the audit.

**Action:** seed `drug_route` and `drug_interval` (and `drug_units`) in OpenEMR's list editor,
alongside the ICD-10-CM load.

### Confirmed still open this pass

- **ICD-10-CM is not loaded.** FHIR `Condition` returns 3 rows for TEST PatientOne, **0 carrying a
  code**. `GET /api/codes` answers 200 with 0 rows. Data gap, not a defect, unchanged.
- **Only two facilities exist** (ids 3 and 4, both POS **11**). No private-residence record (POS 12),
  no Hickory Log, no telehealth record. Until Phase 8.3 runs, `resolveEncounterFacility()` has
  nothing correct to resolve to for a home visit.
- **Encounter duplication:** FHIR `Encounter` returned 14 rows, all 14 unique, for TEST PatientOne
  this pass. The app-side dedupe stays regardless.

### Verified working this pass

Charge write and read-back with the correct CPT and diagnosis separation (`code:"99348"`,
`justify:"ICD10|I10:"`, `provider_id:5`); vitals row accepted, 185 FHIR Observations; SOAP note
write, update and read-by-sid; native prescription write surfacing in FHIR MedicationRequest;
encounter PUT with `user` + `group`; FHIR `Practitioner` readable (1 row, Bethel Godwins, NPI
1902310568); `api/facility` readable.


---

## Follow-up 2026-09-08 — the four app-side audit defects are fixed

Recorded here because two of them change what the maintainer needs to look at.

Fixed in the app and re-proven live (`scripts/verify_shadow_data_fixes.js`, 17/17, stored values
only): the order payload now carries the test name and the diagnosis link; the prescription sends
`date_added` and is linked to its encounter; the encounter carries the acting clinician as
`provider_id`.

**What that means for Defect 4 (the 6B order route).** The app is no longer the reason a test name
is missing. It now sends `code_text: "CBC with differential"` and the route still stores
`procedure_name: ""`. The diagnosis link, sent the same way, stores correctly as `ICD10:I10`. So the
defect is isolated to `code_text` handling in the order controller and nothing else masks it.

**What it means for the encounter provider.** Encounters created from 2026-09-08 carry the real
clinician. Encounters created before it carry the configured default (provider 1) and do not match
the rendering provider on their own charges. These are all TEST DATA, so no correction is needed;
worth knowing when reading older rows.
