# Session 4.5 — Claude Code Prompt
## Wire the app to OpenEMR 8.4 + the Phase 6B routes; retire the workarounds

**Prerequisites — verify before starting:**
- OpenEMR 8.4.0 live (done 2026-09-05, database 543)
- Phase 6B patch installed, acceptance 17/17 (done 2026-09-06, Gap 1 closed)
- ACL grants in place on the GFC API group: `sensitivities`, `encounters`/`coding_a`
- **`OPENEMR_CLIENT_ID` / `OPENEMR_CLIENT_SECRET` swapped in the deployed environment to the v4 client (54 scopes) and the app restarted.** Owner action. If the app is still on an older client the 6B routes are unreachable and nothing below can be proven live.

**Model:** Opus.
**Contract:** Master Setup Guide v4.1 Part VII. **Acceptance:** its Appendix A.
**Important:** TEST DATA ONLY.

---

## The 6B route contract — do not reverse-engineer this

All routes take **numeric** `pid` and `eid`, not uuids (same rule as the note and vital routes — 4.1 lost a week to this). All are gated at two layers: OAuth scope (derived from the route path) and ACL `encounters`/`coding_a`.

| Route | Purpose |
|---|---|
| `POST /api/patient/:pid/encounter/:eid/billing` | Write a fee-sheet charge line. **This is what makes sign-and-close land in Billing Manager.** |
| `GET /api/patient/:pid/encounter/:eid/billing` | Read charges on an encounter |
| `DELETE /api/patient/:pid/encounter/:eid/billing/:id` | **Void** a charge — never a hard delete |
| `POST /api/patient/:pid/encounter/:eid/order` | Create a procedure order plus its order-code rows |
| `GET /api/patient/:pid/encounter/:eid/order` | Read orders on an encounter |
| `PUT /api/patient/:pid/encounter/:eid/order/:orderId` | Update order status |
| `GET /api/codes?type=&search=&limit=` | Search the loaded code tables |

**Charge payload keys:** `code_type` (default `CPT4`), `code`, `provider_id`, `units` (default 1), `fee`, `diagnoses` (array of `{code, code_type}` objects **or** bare code strings — both normalize), `justify` (fallback when `diagnoses` is absent), `code_text`, `authorized` (default 1), `modifier`, `ndc_info`, `notecodes`, `pricelevel`, `revenue_code`, `payer_id`.

**Order payload keys:** `provider_id`, `codes` (array), `order_priority` (default `normal`), `order_status` (default `pending`), `procedure_order_type` (default `laboratory_test`), `date_ordered`, `clinical_hx`, `order_diagnosis`, `patient_instructions`.

**Order status update:** `order_status` only.

**Code search:** `search` requires at least 2 characters; `limit` clamps to 1–100, default 25; `type` optional filter.

---

## Paste this into Claude Code

```
You are continuing the GFC Care Platform build. Read CLAUDE.md first and
honor its prerequisite gate. Sessions 4.1, 4.2, 4.3, 4.4 are merged. OpenEMR
is on 8.4.0 with the Phase 6B patch installed and accepted 17/17. TEST DATA
ONLY.

Branch: session/04.5-native-writes (or harness-assigned)

Read first, in full:
- docs/GFC_Session4.5_ClaudeCode_Prompt.md — the 6B route contract table
  above. Route paths and payload keys are given; do not rediscover them.
- CLAUDE.md — current state, especially the 09/2026 Phase 6B entry
- docs/GFC_OpenEMR_84_Master_Setup_Guide_v4_1.pdf Part VII — the alignment
  contract. Appendix A is acceptance.
- docs/OPENEMR_SERVER_DEFECTS_2026-08.md — what is fixed on 8.4 and what
  still is not
- docs/openemr-patches/8.4.0-p1/ — the patch source, INSTALL.md, and
  acceptance.js (reuse its assertion style)
- openemr.js, clinicalRepository.js, public/clinical.html

PREFLIGHT — stop and report if any fails
1. Token issues, and the granted-scope count matches the v4 client. If the
   count looks like the older client, the deployed env was not swapped —
   STOP and say so. Do not proceed against stale credentials.
2. One live round trip on each 6B route against a test patient.
3. POST /api/prescription writes and surfaces in MedicationRequest.
4. Vitals POST writes both a row and a FHIR Observation.
5. Encounter PUT succeeds WITH `user` and `group` in the body (it fails
   without them — this is an 8.4 behaviour, not a bug to work around).

DISTINGUISHING FAILURES — read before debugging any 401
OpenEMR gates these routes at two independent layers and the messages differ:
  - ACL failure: "Organization policy does not have permit access resource"
  - Scope failure: "Unauthorized"
Rev 1 of the runway doc blamed ACL alone and it cost an install cycle. If you
hit either, report which layer and stop. Do NOT weaken a route guard, add a
fallback path, or route around it.

SCOPE — five pieces, each in its own commit

A. Native 8.4 writes
- Prescriptions: move from the app-side record to POST /api/prescription.
- Vitals: re-enable the write path. It currently preserves readings verbatim
  in the note with a clinician warning because the endpoint 500'd on 7.0.4.
  Keep the note copy as belt-and-braces; the structured row is now primary.
- Encounter updates: use PUT with `user` and `group` in the body, so fields
  no longer have to be set only at create time.
- Documents: the route is now keyed by numeric pid. Read-back is UNPROVEN and
  FHIR DocumentReference still 403s. Wire the write, but keep serving the
  care-plan PDF from the Drive reference on client.carePlanDocs. Do not
  switch the patient-facing download to OpenEMR Documents in this session.

B. The 6B routes
- Charges: POST .../billing on sign-and-close. Rendering provider is the
  signing clinician; billing provider stays the config value
  gfc_payer_credentialing.billing_npi_used, never a literal.
- Charge voids: DELETE .../billing/:id. Void, never hard delete.
- Orders: POST .../order, status advanced via PUT .../order/:orderId.
- Code search: GET /api/codes replaces the app-side coding workaround.
  NOTE: ICD-10-CM may not be loaded yet, in which case this returns empty.
  That is a data-load gap, not a code defect — handle an empty result
  gracefully and keep the T1 carry-forward and T2 favorites as sources.

C. Retire the workarounds — SEPARATE COMMITS, AFTER B IS PROVEN LIVE
- Remove the app-side clinical_orders and encounter_billing stores.
- Remove the [GFC ORDERS] and [GFC CODING] blocks from the structured note.
- Keep [GFC ATTESTATION] and [GFC ADDENDA] — sign-and-close is still
  app-side; 8.4 has no encounter sign/close concept.
- Do NOT combine adding a native write and removing its workaround in one
  commit. Add, prove live, then remove. A failure must be attributable.

D. Per-visit billing facility picker
- Writes form_encounter.billing_facility.
- The picker is sourced from OpenEMR's own facility list (GET /api/facility),
  never a hardcoded or app-side list. Offer the facilities OpenEMR marks
  billing_location=1. GFC currently has two: Vinings (id 3) and Buckhead (id 4).
- POS is inherited from the chosen facility's record (facility.pos_code)
  rather than carried as a separate app setting.
- It is NOT a charge field: addBilling() has no such parameter and the
  billing table has no such column. Do not add it to the charge payload.

  ⚠️ BEFORE IMPLEMENTING THE POS INHERITANCE, READ THIS. Verified live
  2026-09-08: BOTH facility records carry pos_code "11" (Office). The app
  currently sends pos_code "12" (Home) on every encounter, which is correct for
  a home-visit practice. Inheriting POS from the facility as configured today
  would code every home visit as an office visit — a billing error that returns
  201 and surfaces later as a denial or an audit finding, which is exactly the
  failure mode this session's acceptance rules exist to catch.
  Resolve the data before wiring the behaviour. Either:
    (a) correct pos_code to 12 on both facility records in OpenEMR
        (Administration → Facilities), then inherit — preferred, since it makes
        OpenEMR's own record correct for anyone reading it; or
    (b) keep POS as the app-level config and drop the inheritance; or
    (c) inherit as the default and let the clinician override per visit, which
        is the most flexible and the most to build.
  Do not implement inheritance while the facilities still read 11.

E. Session 4.3 live preflight
- 4.3 merged (PR #31) but was proven against a mock, because the build
  sandbox could not reach the EMR during the 8.4 upgrade window. Run its
  three preflight checks against the live instance as part of this session's
  round trip: linked-patient FHIR read, the 403 gate (unlinked / non-clinical
  line / missing consent-to-treat), and an appointment read.

STILL OPEN ON THE SERVER — accommodate, do not fix
- FHIR DocumentReference and Coverage 403 (org-level read grant pending).
  Keep the app-side provider-name fallback.
- No appointment update route on 8.4 — the 4.2 tombstone swap stands.
- Encounter rows still returned twice — keep the FHIR bundle dedupe by
  resourceType and id.
- user/procedure.write does not exist on 8.4 — orders go through the 6B
  route, not a stock one.

DO NOT
- Weaken any route guard or add a fallback around a 401/403.
- Combine a native-write addition with its workaround removal in one commit.
- Put billing_facility on the charge payload.
- Switch the patient-facing care-plan PDF to OpenEMR Documents.
- Build AI features (Session AI.1), claims, eligibility, or Stripe.
- Enter real PHI.

ACCEPTANCE — assert what LANDED, not what returned 200
Phase 6B acceptance took three runs. Both failures were ours, and the second
was introduced by the fix for the first: a loop reused the variable holding
the CPT, so the charge billed the diagnosis code. Neither failed loudly — the
row looked right in Billing Manager and would have surfaced weeks later as a
denial. Every assertion below reads the stored value back.

- Full visit end to end on a test patient: chart -> follow-up note ->
  diagnosis -> prescription -> order -> service code -> sign and close.
- Read the charge back and assert the stored code is the CPT and the
  diagnoses are the ICD codes. Not status codes. Prove they did not swap.
- Prescription appears in MedicationRequest on read-back.
- Vitals produce both a row and a FHIR Observation.
- Order created, status advanced via PUT, read back with the new status.
- A voided charge is marked void, not absent.
- GET /api/codes returns results if ICD-10 is loaded; returns empty
  gracefully if not, with T1/T2 still functioning.
- billing_facility persists on form_encounter and does NOT appear in the
  charge row.
- 4.3 live preflight passes: scoped read works, all three 403 gates hold.
- Non-clinical roles 403 on every new route. All writes hit logActivity().
- App boots; 3.x and 4.x flows unaffected.

Update CLAUDE.md and docs/GFC_SESSION_PLAN.md per the running instruction,
including the step-7 post-merge backfill. Open ONE PR titled "Session 4.5:
Native 8.4 writes + 6B routes; workarounds retired." State plainly in the PR
which acceptance items were proven live and which were not. Stop for review.
```

---

## After this lands
Release. Then: OpenEMR configuration per Master Setup Guide v4.1 (ICD-10 load, facilities, providers, codes, payers), Session 5 planning, and `GFC_SessionAI.1_ClaudeCode_Prompt.md` when the main build settles.
