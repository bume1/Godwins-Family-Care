# OpenEMR Remediation & Realignment Plan
**Date:** 2026-09-05
**Context:** Session 4.4 preflight (documented in `OPENEMR_SERVER_DEFECTS_2026-08.md`) found that several capabilities the app specs assume are either broken or absent in OpenEMR 7.0.4. This plan sorts every blocked item by **what kind of fix it needs**, so effort goes where it pays.

GFC self-hosts and controls this OpenEMR instance, so server-side fixes are available to us — this is not a vendor waiting game.

---

## Bucket A — Configuration only. No code. Do first.

| # | Item | Fix | Unblocks |
|---|---|---|---|
| A1 | Encounter `PUT` 500s — `EncounterService::updateEncounter` fails the `sensitivities` ACL check for `gfc-app-api` | Administration → Users → Groups (ACL): add **sensitivities** to the `gfc-app-api` user's ACL group | Updating an encounter after create (billing note, clinician stamp, corrections). App currently sets these at create only. |
| A2 | FHIR `Condition` read-back returns no ICD-10 coding; `medical_problem` list returns empty | Administration → Other → **External Data Loads** → confirm/load the **ICD-10-CM** code set | Real diagnosis codes round-tripping; coding-assist T1 proposing coded problems; eventually real code search |
| A3 | Missing read scopes on the API client | When registering the Session 5 OAuth client, include `user/prescription.read`, `user/procedure.read`, `user/list.read`, `user/ValueSet.read`, `user/drug.read`. Scopes bind at registration and cannot be widened after | Reading Rx/order data back out of OpenEMR rather than app-side only |

**A1 and A2 are the highest value-per-minute items in this document.** Both are admin-screen changes.

---

## Bucket B — Application bugs in our own OpenEMR. Small patches.

We control this server (SSH key on file), so these are ours to fix. Both are believed to be one-line defects. **Verify against the actual file before patching — the line numbers below came from stack traces, not from reading the source.**

### B1 — Document endpoints 500 (blocks all document upload/download)

**Symptom.** `POST /api/patient/:puuid/document` and the download route both 500. The upload surfaces as `getResponseForPayload(): Argument #1 must be of type array, bool given`.

**Diagnosis from the trace.** `src/Services/DocumentService.php` (~line 92) issues:
`SELECT id FROM categories WHERE replace(LOWER(name), ' ', '') = ?`
without passing the bind array, so the literal `?` reaches MySQL, the query returns `false`, and the response helper receives a bool where it expects an array. The earlier "`sites/default/documents` not writable" hypothesis was **wrong** — the trace is application code, not the filesystem.

**Fix procedure (do not skip step 1):**
1. Read the actual method. Confirm the `sqlQuery(...)` / `sqlStatement(...)` call and whether the bind array is genuinely missing or is being passed empty.
2. If the bind is missing, pass the category name as a bind parameter in the array argument.
3. If the bind is present, the real fault is elsewhere — capture the true SQL error (enable SQL error logging) before changing anything.
4. Guard the caller: when the category lookup returns falsy, return a proper error rather than letting a bool flow into `getResponseForPayload()`.
5. Test: upload a PDF via the API to a test patient, confirm 200 + a document id, confirm it appears in the patient's chart, confirm download.
6. Record the patch (file, diff, date, OpenEMR version) in this document so a future OpenEMR upgrade doesn't silently revert it.

**Unblocks:** received clinical records filing to the chart (v2 §5.4 document routing rule), the care-plan PDF into OpenEMR Documents (Drive copy already works), and any future scanned-document workflow.

### B2 — Vitals endpoint 500s unconditionally

**Symptom.** Every vitals write 500s regardless of payload shape (five shapes tested, including note-only).

**Diagnosis from the trace.** `VitalsCalculatedService::$authUserId` is typed `int` but receives `null` — the API context does not populate the authenticated user id the way the UI session does.

**Fix procedure:** locate where `authUserId` is set for API requests; populate it from the OAuth token's user, or make the property nullable and guard the calculation that consumes it. Test a vitals write end to end, then re-enable the app's vitals write path (it currently preserves readings verbatim in the note and warns the clinician).

**Note:** OpenEMR is open source. If either patch is clean and general, upstreaming it means the next version upgrade keeps it.

---

## Bucket C — API surface gaps. Not bugs. Decision required.

These are capabilities 7.0.4 simply does not expose. No configuration fixes them.

| Capability | State in 7.0.4 |
|---|---|
| Prescription write | `GET` only, no `POST` |
| Procedure / lab order write | `GET` only, no `POST` |
| Billing / fee-sheet row write | No route at all |
| Encounter sign / close | No concept in either API |
| ICD-10 / CPT code search | No route in either API |

**Current state (spec §2.4 interim, shipped in 4.4):** the app holds these records in its own store (`encounter_billing`, `prescriptions`, `clinical_orders`, `encounter_attestations`, `encounter_addenda`) and mirrors them into the chart as a machine-parseable structured note on the encounter. The clinical narrative is never overwritten. Back office keys charges from that note.

**Three options:**

1. **Keep the interim.** Zero further work. Cost: back office manually keys each charge into OpenEMR's fee sheet. Tolerable at low visit volume; scales badly.
2. **Patch our fork to add the missing write routes.** Days of work, ours to maintain across upgrades. Highest fidelity — records land natively in OpenEMR where billing tooling already reads them.
3. **Wait for upstream.** No timeline; not a plan.

**Recommendation:** stay on option 1 through first clinical use and the early visit volume. Revisit option 2 when either (a) manual charge entry becomes a real time cost, or (b) the B-series billing work starts and needs charges natively in OpenEMR. Decide then with real usage data rather than now on speculation.

---

## Realigned expectations by capability

| Capability | Works today | After Bucket A | After Bucket B | Needs Bucket C |
|---|---|---|---|---|
| Chart reads (problems, allergies, meds, encounters) | ✅ | ✅ | ✅ | — |
| Visit documentation (H&P, follow-up SOAP) | ✅ | ✅ | ✅ | — |
| Diagnoses with real ICD-10 codes | partial (app-side) | ✅ round-trips | ✅ | — |
| Vitals into the chart as structured data | ❌ (verbatim in note) | ❌ | ✅ | — |
| Encounter update after create | ❌ | ✅ | ✅ | — |
| Documents / received records to chart | ❌ | ❌ | ✅ | — |
| Care-plan signed PDF | ✅ via Drive | ✅ | ✅ + in OpenEMR | — |
| Prescriptions | app record + note | + readable back | same | native write |
| Lab / imaging orders | app record + note | + readable back | same | native write |
| Charge to fee sheet | app record + note | same | same | native write |
| Sign & close | app-side attestation | same | same | native concept |
| Code search | OpenEMR problem list + own history | ✅ real search | same | — |

---

## Doc alignment items

- `GFC_OpenEMR_Deploy_Setup_Guide_v2.pdf` — referenced by `GFC_App_Build_v2.md` §6 (Appendix D compatibility matrix) but **not in this repo**, and the desktop copy predates significant changes to the deployment. **Do not import it as-is.** Either update it first, or drop the §6 reference so sessions stop citing a document they cannot read. Session 4.4's live preflight (recorded in `OPENEMR_SERVER_DEFECTS_2026-08.md`) is currently the more accurate account of the API surface — treat that as authoritative until the guide is refreshed.
- **v2 §5.4 document routing rule** (received clinical records → OpenEMR document area) was never carried into a session prompt. It is blocked by B1. Add it explicitly to the P1 set so it is deferred deliberately rather than forgotten.
- `GFC_Billing_Spec_Input_Checklist.md` — desktop only, not in this repo. Four must-have answers still open; the billing consultant can close several.
