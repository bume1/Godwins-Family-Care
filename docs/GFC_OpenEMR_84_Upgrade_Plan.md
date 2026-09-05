# OpenEMR 7.0.4 → 8.4 Upgrade Plan
### Plus the read-vs-write linking strategy for capabilities with no API

**Decision:** 2026-09-05, Bianca. First clinical visit moved to Friday 09/12, so the upgrade happens **before** first release rather than after. Supersedes the v2.3 deferral (which set a ~January 2027 review) — 8.x has had time to mature, and 8.4 closes real gaps.

---

## 1. What the upgrade buys, verified against 8.4 source

| Item | 7.0.4 | 8.4 |
|---|---|---|
| Prescription write | `GET` only | **`POST /api/prescription` exists** |
| Document endpoints 500 (`DocumentService.php`) | Bind array missing on the category lookup | **Fixed** — line ~90 passes `sqlQuery($sql, [str_replace("_", "", $lastInPath)])` |
| Vitals endpoint 500 (`VitalsCalculatedService`) | `private int $authUserId` assigned null in API context | **Fixed** — `getCurrentUserId()` falls back to the session when unset |
| Procedure / order write | `GET` only | **Still `GET` only** |
| Billing / fee-sheet write | No route | **Still no route** |
| Code search | None | **Still none** |
| Encounter sign / close | No concept | **Still no concept** (`PUT .../encounter/:euuid` exists in both — our 500 is the ACL, not the version) |

**Net:** prescriptions become a native write, both server-side 500s disappear, and the local patches planned in the remediation plan §B are no longer needed. Orders, billing writes, and code search remain absent at every version — those are solved by linking, not by upgrading (§4 below).

---

## 2. Upgrade path

7.0.4 → 8.4.0 crosses five schema upgrades, all present in the OpenEMR source: `7_0_4-to-8_0_0`, `8_0_0-to-8_1_0`, `8_1_0-to-8_1_1`, `8_1_1-to-8_2_0`, `8_2_0-to-8_3_0`, `8_3_0-to-8_4_0`. OpenEMR's own upgrade routine walks these in order on first start after the image changes; they are not run by hand.

**This is a major version jump, not a patch.** The pinned-image discipline from v2.3 Phase 5 is what makes it controllable — the version only changes when the compose file changes.

---

## 3. Sequence — do this on a scratch instance first

### Step 1 — Snapshot everything (non-negotiable)
- [ ] RDS → `gfc-openemr-db` → **Take snapshot**, name it `pre-84-upgrade-<date>`. Wait for it to complete
- [ ] EC2 → Volumes → the `gfc-openemr` volume → **Create snapshot**, description "pre-8.4 upgrade"
- [ ] Confirm both show Completed before continuing

### Step 2 — Rehearse on scratch
- [ ] Restore the RDS snapshot to a **new** instance, `gfc-openemr-db-scratch` (same class, same security group)
- [ ] Launch a scratch EC2 from the volume snapshot, or a fresh t3.small pointed at the scratch DB
- [ ] On scratch, edit `/opt/openemr/docker-compose.yml`: change `image: openemr/openemr:7.0.4` → `image: openemr/openemr:8.4.0`
- [ ] `cd /opt/openemr && sudo docker compose pull && sudo docker compose up -d`
- [ ] `sudo docker compose logs -f` — watch the schema upgrades run. **Do not interrupt.** Expect several minutes
- [ ] Verify on scratch: log in as admin · open a patient chart · Fee Sheet loads · Billing Manager loads · Administration → Coding → Codes still shows the entered CPT codes · facilities and users intact
- [ ] Note anything that moved: **8.x menu paths differ from 7.x in places, and both the master checklist and v3.0 were written against 7.0.4 menus**

### Step 3 — Re-verify the API surface on scratch
- [ ] Pull the capability statement: `GET /apis/default/fhir/metadata`
- [ ] Pull the Swagger listing: `/swagger`
- [ ] Confirm `POST /api/prescription` accepts a write
- [ ] Confirm the document endpoints no longer 500 (upload a test PDF, read it back)
- [ ] Confirm the vitals endpoint no longer 500s
- [ ] **Re-register the app's OAuth client against scratch.** Scopes bind at registration and 8.4 may name or gate them differently. Include the reads missing in 7.0.4: `user/prescription.read`, `user/procedure.read`, `user/list.read`, `user/ValueSet.read`, `user/drug.read`
- [ ] Run the app's Session 4.4 preflight probe against scratch and diff the results against `OPENEMR_SERVER_DEFECTS_2026-08.md`

### Step 4 — Production upgrade
- [ ] Only after scratch passes. Same image-tag change, same `pull` + `up -d`
- [ ] Watch the logs through the schema upgrades
- [ ] Re-run the acceptance test (master checklist §P)
- [ ] Delete the scratch instances once production is verified — they bill by the hour

### Step 5 — Retire what the upgrade obsoletes
- [ ] Remediation plan §B1 (document patch) and §B2 (vitals patch) — **no longer needed**, mark them closed as "fixed by 8.4"
- [ ] Re-enable the app's vitals write path (it currently preserves readings verbatim in the note with a clinician warning)
- [ ] Switch the app's prescription handling from app-side record to native `POST /api/prescription`

---

## 4. Read-vs-write linking strategy

**Principle:** where OpenEMR exposes a write, the app writes. Where it does not, the app **links the clinician into OpenEMR** to complete the action under her own login, rather than holding a shadow copy.

This is better than the app-side interim on three counts: OpenEMR genuinely holds the record with no reconciliation seam; the action is attributed to the actual clinician instead of the `gfc-app-api` service account; and OpenEMR's own screens already have the code search the API doesn't expose.

Clinicians have OpenEMR logins by design (v3.0 §3 onboarding checklist requires a distinct user, Provider and Authorized flags, own electronic signature, MFA). This does not conflict with v3.0 §7.5 — that rule is that **patients, families, and caregivers** never log in. Clinicians may.

### After 8.4 — where each action lives

| Action | Lane |
|---|---|
| Patient list, chart reads, problems, allergies, meds, encounters | **App** — FHIR reads |
| Encounter create, SOAP note, vitals | **App** — REST writes |
| Problem list, allergy, medication list writes | **App** — REST writes |
| Patient demographics create/update | **App** — FHIR |
| Appointments | **App** — REST (Session 4.2) |
| Documents / received clinical records | **App** — REST (unblocked by 8.4) |
| **Prescriptions** | **App** — `POST /api/prescription` (new in 8.4) |
| **Lab / imaging / procedure orders** | **Link into OpenEMR** — no write route at any version |
| **Fee sheet / charge entry** | **Link into OpenEMR** — no route at any version; also gives real CPT + ICD search |
| **Encounter sign / close** | **App-side attestation** — no OpenEMR concept. The app's charge-ready gate is the signature of record |
| Claims, ERA posting, A/R | **OpenEMR** — Billing Manager, per v3.0 §11 |

### How the links should work
- Deep-link from the app's chart to the OpenEMR screen for **that patient and that encounter**, not the OpenEMR home page
- Open in a new tab so the clinical workflow in the app is not lost
- The app records that the action was routed out — order placed, fee sheet completed — so the charge-ready gate can still check it happened, even though the app did not write the content
- On return, the app re-reads from OpenEMR to reflect what was entered

### What this removes
The app-side `clinical_orders` store and the `[GFC ORDERS]` block in the structured note become unnecessary once orders are placed in OpenEMR directly. Same for `encounter_billing` and `[GFC CODING]` once the fee sheet is completed there. **Do not remove them in the same session as the upgrade** — retire them after the linking flow is proven in real use.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Schema upgrade fails partway | Rehearsed on scratch first; RDS snapshot restores in minutes |
| 8.x menu paths differ from the checklist and v3.0 | Note discrepancies while rehearsing; correct both documents after |
| OAuth client scopes behave differently | Re-register on scratch and re-run the app preflight before production |
| App code assumes 7.0.4 quirks | The 4.4 session encoded several (numeric-id note routes, duplicate encounter rows, validation-map-on-200). Re-run the full live round trip after upgrading; some workarounds may now be unnecessary but leaving them in place is harmless |
| Upgrade eats the week before the visit | Rehearse early in the week. If scratch reveals trouble, abandon and ship on 7.0.4 with the two local patches — that path still works |

**Fallback:** if anything about the upgrade looks unstable by Wednesday, revert to plan A — stay on 7.0.4, apply the two one-line patches (now with 8.4's exact code as the reference), and upgrade after the first visits settle.
