# GFC Clinical Completeness Spec v1
## OpenEMR clinician-workflow capability coverage in the GFC app

**Date:** 2026-09-03 · **rev 1.1** (adds §7 code source-of-truth and §8 coding assist)
**Purpose:** Enumerate every OpenEMR front-end capability pertinent to an FNP's home-based primary care workflow, state what the GFC clinical portal covers today, and define what must exist for the portal to carry a full clinical visit end to end.
**Owner decisions encoded here:** billing is completed in OpenEMR's back end for now, but the **note → billing route must be accounted for in the app**. Quest HL7 lab interface is deferred (months out); lab ordering must still be capturable. Session 4.1 (PR #19) and 4.2 (PR #22) are merged.

**Priority key:** **P0** = required for first clinical test use · **P1** = required before routine use · **P2** = later session.

---

## 1. Capability matrix

| # | OpenEMR clinician capability | In the app today | Gap | Priority |
|---|---|---|---|---|
| 1 | Patient search / list | ✅ 4.1 — IHPC/both list, link + sync state | — | — |
| 2 | Patient registration / demographics | ✅ 4.1 — Patient create/update via FHIR | — | — |
| 3 | Chart view (problems, allergies, meds, encounters) | ✅ 4.1 live read | — | — |
| 4 | Encounter creation | ✅ 4.1 (H&P) + 4.2 (follow-up route) | — | — |
| 5 | Visit documentation / SOAP note | ✅ 4.1 — H&P per intake spec §2C, written as `soap_note` | Follow-up visits need a **shorter SOAP form**, not the full H&P | **P0** |
| 6 | Vitals | ⚠️ Captured in the form; REST endpoint 500s server-side; readings preserved verbatim in the note | Re-test after EMR fix; keep note fallback | P1 |
| 7 | Problem list (ICD-10) | ✅ 4.1 write | Needs **ICD-10 code lookup/search**, not free text, so codes flow to billing | **P0** |
| 8 | Allergies | ✅ 4.1 write | — | — |
| 9 | Medication list + reconciliation | ✅ 4.1 | — | — |
| 10 | **Prescribing (new Rx / refill)** | ❌ Not built | Write prescription records to OpenEMR (`/prescription`). **E-prescribing (eRx/Surescripts) is NOT in scope** — transmission stays as today (phone/fax/EMR-direct); the app records the Rx so the chart is complete | **P0** |
| 11 | **Orders — labs, imaging, procedures** | ❌ Not built | Capture the order in the chart (order type, tests, priority, diagnosis linkage, status). **No Quest HL7 interface — deferred months.** Transmission remains manual (Quest portal / requisition); the app records the order and its status | **P0** |
| 12 | **Results review (labs/imaging inbound)** | ❌ Not built | Manual result entry + document attach against the order, so the chart shows result received/reviewed with a clinician acknowledgment stamp | **P1** |
| 13 | Immunizations | ❌ Not built | Record administered immunizations | P2 |
| 14 | Care plan | ✅ 4.1 — versioned, RN + client signature, signed PDF | — | — |
| 15 | Appointments / scheduling | ✅ 4.2 | Verify the appointment-scoped OAuth client swap is deployed | **P0 (deploy step)** |
| 16 | Documents / scanned attachments | ⚠️ Server defect (SQL binding bug, `DocumentService.php:92`) | Care-plan PDF served from Drive; general document upload blocked until EMR fix | P1 |
| 17 | **Encounter coding → billing (fee sheet)** | ❌ Not built | See §2 — the note→billing route | **P0** |
| 18 | Encounter sign / close | ❌ Not built | Clinician attests and closes the encounter; closed encounters lock from further edit (addenda only) | **P0** |
| 19 | Clinical inbox / task list | ❌ Not built | Results to review, unsigned notes, pending co-signs | P1 |
| 20 | Referrals / transitions of care | ❌ Not built | 3.4 transfer-of-care ROI covers inbound records; outbound referral not built | P2 |
| 21 | Patient portal clinical read | ⏳ Session 4.3 | Prompt ready | P1 |
| 22 | Growth charts, pediatric tools | n/a | Out of scope — adult home-based primary care | — |

---

## 2. The note → billing route (P0)

**Owner decision:** billing is completed in OpenEMR's back end for now. The app does not build claims, statements, or clearinghouse submission (that is Track D / B-series). What the app **must** do is make every encounter billable without a clinician re-entering anything in OpenEMR.

### Required in the app

1. **Diagnosis capture with real ICD-10 codes.** The problem list and the visit form must capture selectable ICD-10 codes (search by code or description), not free text. Codes attach to the encounter.
2. **Procedure/service capture with CPT/HCPCS codes.** On visit completion the clinician selects the visit's service code(s). For home-based primary care the working set is the home-visit E/M range (new patient 99341–99345, established 99347–99350), plus care-management codes where applicable (CCM/CCP). Provide a **short, configurable favorites list** rather than the full code set.
3. **Diagnosis↔procedure linkage.** Each service code links to at least one diagnosis code on that encounter.
4. **Write to OpenEMR's billing table for that encounter** (the fee-sheet equivalent) so the charge appears in OpenEMR's Billing Manager ready for back-end processing. If the standard REST API exposes no billing write on this instance, the session must report that explicitly — and as an interim, write the codes into a clearly structured, machine-parseable block on the encounter note plus an app-side `encounter_billing` record, so nothing is lost and back-office staff can key it in one place.
5. **Rendering provider on the charge** = the signing clinician, and the **billing provider** = the config value `gfc_payer_credentialing.billing_npi_used` (currently Bethel Godwins's individual NPI), never hardcoded. Consistent with `GFC_App_Build_v2.md` §13.
6. **Billing-ready state on the encounter**: coded / not-coded, visible in the chart and in a simple staff list of uncoded encounters.

### Explicitly NOT in this scope
Claim generation, 837/835, eligibility, patient statements, Stripe. Those are Track D.

---

## 3. Encounter sign / close (P0)

A clinical note is not a legal record until it is attested. Required:
- "Sign and close encounter" action: clinician attestation, timestamp, signing user recorded as the **actual clinician** (see §4).
- Closed encounters become read-only; corrections happen as an **addendum** with its own timestamp and signer, never a silent edit.
- An encounter cannot be signed until it has: a documented note, at least one diagnosis code, and at least one service code (the billing route above).

---

## 4. Attribution (P0 for real clinical use)

Every clinical write currently authenticates as the `gfc-app-api` service account, so OpenEMR attributes all activity to it rather than to the clinician. For test use this is tolerable. **Before any real patient encounter is recorded, per-user attribution must exist** — either per-user OpenEMR accounts with authorization_code auth (Session 5 scope, recommended by the 4.2 session to pull forward), or, as a documented interim, the app stamping the acting clinician's name and NPI into the note header and encounter record so the chart is not silent about who did the work.

Record whichever path is chosen as a decision in CLAUDE.md.

---

## 5. Deferred, with reasons

| Item | Why deferred | Revisit |
|---|---|---|
| Quest HL7 lab interface | Multi-month effort: account setup, interface spec, message testing, Quest certification. Owner decision 2026-09-03: not now | Later session, own track |
| E-prescribing (Surescripts) | Certification + cost; transmission continues as today | Post go-live |
| Claims / clearinghouse / eligibility | Track D, B-series; spec `GFC_Billing_Architecture_Spec_v1.md` not yet written | B-series |
| Immunizations, outbound referrals, growth charts | Low frequency in this population | P2 |

---

## 6. Build order

**P0 bundle (the "usable tomorrow" set), one session:**
follow-up SOAP form · ICD-10 coded problems · prescription recording · order capture (labs/imaging) · encounter coding + billing route (§2) · sign & close (§3) · attribution interim (§4) · confirm the appointment OAuth client swap is deployed.

**P1 next:** results review + acknowledgment · clinical inbox · vitals re-test after EMR fix · document upload re-test after EMR fix · Session 4.3 patient read.

**P2 later:** immunizations · outbound referrals · Quest HL7 · e-prescribing.


---

## 7. Code sets — source of truth (decided 2026-09-03)

**ICD-10-CM (diagnoses).** Federal, free, identical in all states, reissued every October 1 by CMS/NCHS. There is no Georgia-specific ICD-10 list. Load the CMS code set into OpenEMR via its code loader; the app searches it through OpenEMR. Georgia specificity, where it matters, comes from **Palmetto GBA** (the Medicare contractor for GA) Local Coverage Determinations, which define which diagnoses support medical necessity for home-visit services — a consultant input, not a data feed.

**CPT (services).** The AMA holds CPT copyright; no EMR may redistribute the code set, and OpenEMR does not ship it. GFC does **not** need a license for its use case: the practice hand-enters the small set of codes it actually bills into OpenEMR's fee schedule. Working set is the home-visit E/M range — 99341–99345 (new patient), 99347–99350 (established) — plus care-management HCPCS codes if and when those start.

**Rule: OpenEMR is the source of truth for both sets. The app never maintains its own code list.** It reads codes from OpenEMR and writes selections back. A second list in the app would drift, and the codes in the chart would stop matching the codes on the claim.

**Consequence for the build:** code search endpoints in the app proxy OpenEMR. If a needed code is missing, it gets added in OpenEMR, not in app config.

---

## 8. Coding assist (automation) — tiers

Standard EMRs offer coding suggestions. The equivalent here, in build order. **Guardrail across all tiers: the system proposes, the clinician disposes.** Nothing is auto-selected onto a claim, every suggestion is overridable, and the note must independently support whatever level is billed. "The software chose it" is not an audit defense.

**T1 — Problem-list carry-forward. (P0, build now.)**
Opening a follow-up encounter pre-selects the patient's active problems from OpenEMR as candidate encounter diagnoses; the clinician unchecks what wasn't addressed. For a chronic-disease home panel this covers most visits. Cheapest, highest-yield item in this document.

**T2 — Usage-ranked favorites. (P0, build now.)**
The app records which ICD-10 and CPT codes each clinician actually selects and ranks their picker by that clinician's own frequency, most-recent first. Seeded from a starter set; self-tuning after ~20 visits. Per-clinician, not global.

**T3 — E/M level suggestion. (P1 — build after Dianne confirms thresholds.)**
Under the 2021+ E/M rules a level is supported by either total time or medical decision-making complexity. Time is deterministic and the app already knows encounter start/stop, so it can surface "42 minutes documented — supports 99349" with the rule shown. MDM-based suggestion (problems addressed, data reviewed, risk) is rule-based and can follow. **Do not implement the thresholds from memory — they come from the billing consultant.**

**T4 — Note-to-code inference. (P2 — after real usage.)**
Propose ICD-10 candidates from the assessment text. Build only after several weeks of real notes and confirmed code choices exist to validate suggestions against. Same guardrail: proposals only, never committed without confirmation.

---

## 9. Open items for the billing consultant (Dianne)

1. Confirm the CPT set GFC bills for home-based primary care under Bethel's NPI (E/M range; any care-management codes now or later).
2. Build the starter ICD-10 favorites list from GFC's actual panel, informed by Palmetto GBA coverage determinations for home visits.
3. Confirm documentation requirements per E/M level — what the note must contain to support 99348 vs 99350. **Blocks T3.**
4. Confirm whether an FNP in Georgia bills these independently under her own NPI or requires physician linkage.
5. From `GFC_Billing_Spec_Input_Checklist.md` (currently only in the desktop GFCLLC folder, not in this repo): refund/adjustment policy, and whether GFC uses an accounting system the app should feed.
