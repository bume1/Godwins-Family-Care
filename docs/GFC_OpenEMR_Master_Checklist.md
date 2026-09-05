# GFC OpenEMR — Master Checklist
### Deployment → configuration → billing → deposits

**Created:** 2026-09-05 · **Working document — check items as you complete them.**

**Source hierarchy (read this first):**
1. `GFC_OpenEMR_Billing_Configuration_Guide_v3.pdf` — **authority** on identity, facilities, codes, billing, compliance. Supersedes v2.3 Phase 7 onward.
2. `GFC_OpenEMR_Deploy_Setup_Guide_v2.pdf` — **authority** on the AWS deployment (Part I, Phases 0–6) and the Appendix D app↔EMR compatibility matrix. Its Phases 7–11 are superseded where v3.0 disagrees (see §A below).
3. `OPENEMR_SERVER_DEFECTS_2026-08.md` + `GFC_OpenEMR_Remediation_Plan_2026-09.md` — live findings from the app's Session 4.1/4.4 preflights. Where these disagree with either guide about what the API actually does, **these win** — they were measured against the running server.
4. `GFC_Billing_Segment_App_Integration_Spec.md` — the app half. Meets the EMR half at the charge-ready gate.

---

## A. Where v3.0 overrides v2.3 — do not follow the old instruction

| Topic | v2.3 said | v3.0 says (correct) | Why |
|---|---|---|---|
| Place of service | Facility POS hardcoded to `12 — Home` | One facility record **per physical site**, each with its own POS (F1=12, F2=13, F3=14, F5=31, F7=10) | Broke the moment GFC saw a patient in a licensed community (v3.0 §13.6) |
| Clinical ACL | Clinical group gets "No Fees/Financial permissions" | Clinicians get **Fee Sheet write, no financial visibility** | The restrictive reading breaks same-day charge capture (v3.0 §13.5) |
| Fee schedule | Anchor fees **to** the Medicare PFS Georgia locality | Charge master at **125–150% of** the Medicare allowable | Charging at allowable permanently caps collections from every payer that would have paid more (v3.0 §13.4) |
| Organizational NPI | Leave blank permanently; bill under Bethel's individual NPI | Populate the clinical Type 2 NPI **once the 855B is approved** | Entity structure has since been decided (v3.0 §7.2) |
| Payers to enter | Enter seven, incl. BCBS, Aetna, UHC, Cigna, Humana | **Only payers GFC holds a contract with.** Commercial credentialing runs through CAQH ProView | Adding a payer to OpenEMR does not make you able to bill it (v3.0 §13.3) |
| Modifiers | Not mentioned | Configure **25, 95, 93, 59, GT** before the first claim | Without them, legitimate same-day services bundle and deny (v3.0 §8.2) |
| Practice address | 4300 Paces Ferry Rd SE, Suite 500, Atlanta | **Conflict** — NPPES has 4945 Baker Plantation Way, Acworth. Resolve before enrollment | Address mismatch is the most common cause of a stalled enrollment (v3.0 §5) |

---

## B. Already complete (v2.3 Part I — the AWS deployment)

- [x] Phase 0–6: security groups, RDS, EC2, DNS, OpenEMR 7.0.4 install, backups, cost alarm
- [x] Phase 8 (v2.3): FHIR + Standard REST APIs enabled, OAuth2 client registered, app connected
- [x] Live at `emr.godwinsfamilycarellc.com`, AWS BAA accepted, ~$40–55/month

---

## C. Phase 1 — Unblock the app (20 minutes · do before anything else)

From the remediation plan, Bucket A. Both are pure configuration.

- [ ] **C1. Widen the API user's ACL.** Administration → Users → Groups → add **sensitivities** to `gfc-app-api`'s ACL group.
      *Fixes:* encounter `PUT` 500s, so the app can update an encounter after create.
- [ ] **C2. Load the ICD-10-CM code set.** Administration → Other → External Data Loads → **ICD-10-CM**.
      *Fixes:* FHIR `Condition` returning no diagnosis coding; enables fee-sheet diagnosis selection (v3.0 §8.3). Also the app's coding-assist carry-forward stops guessing.
- [ ] **C3. Verify C2 worked.** Re-run a problem-list write from the app and confirm the ICD code survives read-back.

---

## D. Phase 2 — Identity, security, organization (v3.0 §7.1–7.2)

Administration → Config. **Click Save on each tab** — settings do not persist tab-to-tab.

- [ ] **D1. Security tab:** idle session timeout **900 seconds**; password expiration 90 days; minimum length 12; strong passwords required; lockout after 5 failed logins
- [ ] **D2. Logging tab:** audit logging on, **every** patient-record subcategory enabled (views, updates, disclosures), no truncation of PHI-access events
- [ ] **D3. Appearance tab:** application title "Godwins Family Care"
- [ ] **D4. MFA on every account**, admin account first — including A6 (owner) and A7 (biller) when created
- [ ] **D5. Resolve the address conflict** (Acworth vs Paces Ferry). Then make NPPES, PECOS, the CMS-855B, the IRS record, and OpenEMR all agree. **Blocks enrollment.**
- [ ] **D6. Organization record:** name "Godwins Family Care LLC" (never "Godwins" alone) · the resolved address · GFC LLC's EIN · organizational NPI **blank until the 855B is approved** · Billing Location, Accepts Assignment, Service Location all checked

---

## E. Phase 3 — Facility records (v3.0 §4, §7.3)

One record per physical site, each with its own POS. **Do not default to POS 12** because the code family is called "home or residence."

| Archetype | Setting | POS | E/M family |
|---|---|---|---|
| F1 | Private residence | 12 | 99341–99350 |
| F2 | Assisted living community | 13 | 99341–99350 |
| F3 | Group home | 14 | 99341–99350 |
| F4 | Custodial care facility | 33 | 99341–99350 |
| F5 | Skilled nursing facility | 31 | **99304–99310** — different family |
| F6 | Nursing facility, non-skilled | 32 | 99304–99310 |
| F7 | Telehealth, patient at home | 10 | Per service + modifier |
| F8 | Telehealth, patient elsewhere | 02 | Per service + modifier |

- [ ] **E1. F1 — private residence, POS 12.** Active now; covers Ellijay and other private-home clients
- [ ] **E2. Hickory Log Personal Care Homes** — **BLOCKED.** Obtain the DCH license type, number, and bed count; record the actual operating model; then map to F2 (POS 13) or F3 (POS 14). If borderline, request written guidance from Palmetto GBA and file the response with the facility record
- [ ] **E3. F7 — telehealth, POS 10.** Pending psych go-live
- [ ] **E4. Per facility:** legal name, street address, unit, phone, administrator contact · correct POS · facility policy on outside practitioners, medication orders, resident consent, records access, emergency escalation · BAA where GFC handles the facility's PHI · marked as a **service location** (GFC remains the billing location)

---

## F. Phase 4 — Provider records (v3.0 §3, §7.4)

Build from the archetype table; named people are instances. Never configure a one-off.

**Current roster:**

- [ ] **F1. Bethel Godwins — A1** (primary care NP) · NPI 1902310568 · taxonomy 363LF0000X · GA license RM186487 · Provider + Authorized checked · own electronic signature · MFA · ACL: Clinical
- [ ] **F2. Thanmayie Bethi — A2** (dual-certified NP) · NPI 1962038307 · GA license 246736 · **BLOCKED: psych billing cannot go out until 363LP0808X is added to her NPI in NPPES**
- [ ] **F3. Bianca Ume — A6** (non-rendering owner/administrator) · **Provider unchecked** · ACL: Administrators · appears on the CMS-855B in ownership and managing control
- [ ] **F4. Collaborating physician — A4** · TBD · required for both NPs' protocol agreements and the Schedule II referral path
- [ ] **F5. Biller — A7** · ACL group configured and empty until hired

**Onboarding checklist — run for every rendering clinician (A1–A5), no exceptions:**

- [ ] State license verified at the issuing board, dated screenshot retained
- [ ] National certification(s) verified with the issuing body, certificate copy retained
- [ ] Type 1 NPI confirmed in NPPES with **every taxonomy they will bill under** listed, primary designated deliberately
- [ ] NPPES credential field and practice address accurate
- [ ] CMS-855I filed, with reassignment to GFC in the same application
- [ ] **OIG LEIE and SAM.gov exclusion screening cleared** (v3.0 §13.1 — highest exposure item in the audit)
- [ ] Malpractice coverage confirmed for every scope they will practice
- [ ] DEA registration and Georgia PDMP enrollment, if prescribing
- [ ] Nurse protocol agreement executed and filed with GCMB, if APRN
- [ ] Distinct OpenEMR user, Provider + Authorized flags, individual NPI, all taxonomies, own electronic signature, MFA enrolled
- [ ] Credential expiration dates entered in the tracker (v3.0 §14)
- [ ] Code set they are permitted to bill recorded against their user record

**No shared logins, ever.** One human, one account — the login drives the note signature, which must match the claim.

---

## G. Phase 5 — Access control (v3.0 §7.5) — **corrected from v2.3**

| Archetype | ACL group | Fee Sheet | Payments / AR / Adjustments | Reports |
|---|---|---|---|---|
| A1–A5 | Clinical | **Write** | No | Own encounters only |
| A6 | Administrators | Write | Yes | All |
| A7 | Accounting | Write | Yes | Financial |
| A8 | Front Office | No | No | Scheduling only |

- [ ] **G1.** Clinical group: Fee Sheet write enabled, financial visibility denied
- [ ] **G2.** Administrators, Accounting, Front Office groups configured per the table
- [ ] **G3.** Confirm the native patient portal stays **disabled** — the GFC app is the only patient-facing surface. Clients, families, and caregivers never log in to OpenEMR

---

## H. Phase 6 — Codes, modifiers, fee schedule (v3.0 §8)

OpenEMR ships with no CPT codes (AMA-licensed). Enter only what GFC bills, at Administration → Coding → Codes.

**H1. A1/A2 primary care codes:**
- [ ] Home/residence E/M, new patient: **99341, 99342, 99344, 99345** — **99343 was deleted; do not enter it**
- [ ] Home/residence E/M, established: **99347, 99348, 99349, 99350**
- [ ] Nursing facility E/M **99304–99310** — only if F5 or F6 is ever served
- [ ] **G0438** initial AWV, **G0439** subsequent AWV
- [ ] **99497** advance care planning
- [ ] **99495, 99496** transitional care management

**H2. A2-only psych codes** — enter only once F2 above is unblocked:
- [ ] 90791 (diagnostic eval, no medical services) · 90792 (with medical services) · 90832/90834/90837 (psychotherapy 30/45/60) · +90833/+90836/+90838 (add-on to E/M) · 96127 · 96116

**H3. A9 LCSW codes** — if/when an LCSW is hired:
- [ ] 90791 (**not** 90792) · 90832/90834/90837 · 90846/90847 · 90853 · 96127 · health behavior assessment codes · **no E/M codes under any circumstance**

**H4. Modifiers — missing entirely from v2.3:**
- [ ] **25** — significant, separately identifiable E/M same day as another service. *The AWV plus a problem visit is the routine case; without modifier 25 the E/M denies*
- [ ] **95** — synchronous audio-video telehealth
- [ ] **93** — audio-only telehealth, behavioral health
- [ ] **59 / X{EPSU}** — distinct procedural service; use sparingly and only with documentation
- [ ] **GT** — legacy telehealth on some payers; confirm per payer

**H5. Fee schedule:**
- [ ] Set the charge master at **125–150% of the Medicare allowable**, Georgia locality. **Not at Medicare rates**
- [ ] Enable the ICD-10 code set for fee-sheet diagnosis selection (same as C2)
- [ ] Mark every code active and confirm it appears on a test encounter's Fee Sheet
- [ ] Calendar the recurring **January** task: reload the fee schedule after the annual PFS update

---

## I. Phase 7 — Payers and clearinghouse (v3.0 §11.1, v2.3 §9.2)

- [ ] **I1. Insurance companies** — Administration → Practice Settings → Insurance Companies. One record per payer. **Payer IDs from Availity's payer list, not the payer's website**
- [ ] **I2. Priority order:** Medicare Part B (Palmetto GBA, Jurisdiction J) → each Medicare Advantage plan on the roster as its own payer → Medigap carriers → Georgia Medicaid
- [ ] **I3. Commercial payers: do not enter** until GFC holds a contract with them (v3.0 §13.3). Build a CAQH ProView profile per clinician first; track credentialing status per payer per clinician
- [ ] **I4. X12 partner** — Administration → Practice Settings → X12 Partners → Availity, version **005010X222A1** (837P). Sender IDs = Availity Customer ID; receiver IDs and qualifiers copied exactly from the Availity EDI Connection Guide
- [ ] **I5.** Reopen each payer and set its X12 Partner to Availity
- [ ] **I6. Availity enrollment** (longest pole — start early): register GFC, submit EDI/batch access, per-payer transaction enrollment, and **per-payer ERA enrollment**. Register under GFC's group NPI and EIN once the 855B is approved, not an individual
- [ ] **I7. BAA executed with Availity** (v3.0 §13.13 — they handle every claim's worth of PHI)

---

## J. Phase 8 — Per-patient setup (v3.0 §9)

- [ ] **J1.** Demographics: name exactly as on the Medicare card, DOB, residence address
- [ ] **J2.** Insurance: MBI primary; Medigap or Medicaid secondary; subscriber equals self
- [ ] **J3.** Signature on file **YES** for both release of information and assignment of benefits, backed by the signed intake packet. *A facility nurse supervisor cannot sign unless she holds documented legal authority*
- [ ] **J4.** POA or responsible party recorded, with a **separate billing contact field**
- [ ] **J5.** Existing PCP recorded
- [ ] **J6.** Facility record assigned (from §E) — this drives POS
- [ ] **J7. Keep as separate fields**, since each drives different billing behavior: Medicare Advantage enrollment + plan name · Medicaid eligibility + category · **QMB status** · secondary/Medigap carrier

**Two revenue assumptions to verify per patient:**
- [ ] **J8. Annual wellness visits:** G0438 is once per lifetime, G0439 once per 12 months, following the beneficiary's claims history — not which practice considers itself primary. Pre-check last G0402/G0438/G0439 dates from the **Palmetto eServices portal**; a 270/271 alone will not return AWV history. Keep AWV out of any launch revenue forecast until the roster is checked
- [ ] **J9. Medicare Advantage:** sort every roster patient into Original Medicare FFS / MA in-network / MA out-of-network but potentially payable / MA requiring authorization or single-case agreement / unverifiable. For an out-of-network MA patient, a claim to Palmetto is **not payable**. MA behavioral health often carries separate network and authorization rules from medical — check both lanes

---

## K. Phase 9 — Visit workflow and charge capture (v3.0 §10)

Encounter defaults: service facility per §E, billing facility GFC, rendering provider set to the person in the room. **Defaults must be overridable.**

- [ ] **K1.** Each note carries: service date, patient location, rendering clinician · medically appropriate history and exam · either the MDM basis or a total practitioner time statement (psych documents psychotherapy time **separately** from E/M time) · assessment and plan tied to each diagnosis used on the claim · medication reconciliation and a record of where prescribing was routed · the rendering practitioner's own signature and attestation · a late-entry policy preserving true date, time, and amendment reason
- [ ] **K2. Prescribing:** route medication changes to the patient's established authorized prescriber until prescriptive authority, the GCMB protocol agreement, e-prescribing and EPCS setup, formulary, and the facility's order process are all confirmed for that clinician. Document the recommendation, the communication, the acceptance or rejection, and who ultimately prescribed. **Schedule II routes out under v3.0 §6 regardless of enrollment status**

**K3. The charge-ready gate — nothing enters the billing queue until all eight are true:**
- [ ] 1. Note signed and locked
- [ ] 2. Diagnosis-to-service linkage reviewed
- [ ] 3. Rendering provider validated against the §F roster
- [ ] 4. **Rendering provider's certification matches the code billed** (v3.0 §3.2 table): A1 cannot bill the psych set · A9 cannot bill E/M · A10 cannot bill anything independently
- [ ] 5. **Facility record and POS match where the service actually happened**
- [ ] 6. Eligibility and payer order validated
- [ ] 7. Enrollment and reassignment confirmed active for that date of service
- [ ] 8. Required consent, notice, or authorization documented

> The app enforces these checks; OpenEMR carries the evidence. This is why the app requires codes at sign: no encounter goes unbilled, and nothing bills that should not.

---

## L. Phase 10 — Claims, remittance, and deposits (v3.0 §11)

**L1. Eligibility (270/271):**
- [ ] Run **twice per claim** — before the visit and again before claim release. Enrollment changes between those points
- [ ] Availity 270/271, or the free Availity Essentials portal in the interim

**L2. Claim flow:**
- [ ] Generate the 837 batch in **Fees → Billing Manager** → download → upload in Availity Essentials. Manual at launch volume, roughly five minutes per batch
- [ ] **Send one test claim, confirm acceptance, then release the rest**
- [ ] Validate payer IDs, provider IDs, facility and POS mapping, and the rendering field on the test before the batch goes
- [ ] Keep three failure modes separate — clearinghouse rejections, payer front-end rejections, adjudicated denials. Different owners, different fixes
- [ ] **Weekly denial and rejection report, worked every Friday**

**L3. Remittance and posting:**
- [ ] Paths: Fees → Posting Payments (835 upload) and Fees → Batch Payments (manual EOBs). Confirm both load under the admin login
- [ ] **ERA auto-posting stays deferred.** Post manually for the first months to learn each payer's denial patterns

**L4. Patient responsibility — 2026 figures:**
- [ ] $283 annual Part B deductible, then Medicare pays 80% and **20% is patient responsibility of the Medicare allowed amount, not the charge**. With a charge master at 125–150%, calculating by hand overcharges every patient. The number comes from the **835 remittance**
- [ ] **Hard rule: no statement goes out before the ERA posts**

| Patient situation | Who pays the 20% | Statement? |
|---|---|---|
| Medigap | Medigap, via automatic crossover | No |
| **QMB** | **Nobody bills the patient.** Write off what Medicare does not pay | **Never** |
| Medicaid, non-QMB | Medicaid up to its allowable | No |
| Traditional Medicare, no secondary | Patient or POA | Yes |
| Medicare Advantage | Plan copay, per the plan's EOB | Per plan |

- [ ] No cost sharing at all on AWVs (G0438, G0439) or on ACP (99497) when furnished with a covered AWV
- [ ] **QMB hard hold** in OpenEMR blocking statements, collection tasks, and manual balance transfers for confirmed QMB patients. Federal law prohibits billing QMB individuals for Medicare-covered deductibles, coinsurance, or copays — including under Medicare Advantage, and including when Medicaid pays less than the full amount. **System control, not a staff instruction**
- [ ] Statement trigger fires **only** on posted-ERA patient responsibility
- [ ] Medigap crossover confirmed on the first remittance rather than assumed; drop secondaries manually if it does not

**L5. Deposits and reconciliation (spans OpenEMR + the app):**
- [ ] Stripe payments and Medicare EFT deposits both reconcile against the **835 posted in OpenEMR**. One patient balance, sourced from OpenEMR
- [ ] Flow: OpenEMR posts the 835 → patient responsibility appears → the app reads it via API → the app collects via Stripe where a balance is owed and the patient is not QMB or Medigap-covered → the app writes the payment back to OpenEMR's ledger
- [ ] **The app must never hold a second balance.** If the app and OpenEMR disagree, OpenEMR wins

**L6. Telehealth window (v3.0 §11.4):**
- [ ] Medicare telehealth flexibilities extended through **12/31/2027**; the patient's home remains an acceptable originating site for behavioral health through that period with no in-person requirement
- [ ] From **01/01/2028**, an in-person visit within six months prior to the first behavioral telehealth service, and annually thereafter. Patients established on behavioral telehealth **on or before 12/31/2027 are grandfathered**
- [ ] Front-load establishment dates deliberately and track per patient. Confirm with Palmetto whether a resident in a licensed community counts as "home" for POS 10 before billing that way

---

## M. Phase 11 — Care management line (v3.0 §12) — only if launching CCM/CoCM/BHI

- [ ] **M1.** Care management platform selected; **BAA executed before any PHI moves**
- [ ] **M2.** Integration lanes verified against the live server, both directions
- [ ] **M3.** Every charge lands in OpenEMR — a platform that bills independently splits the claim stream and breaks reconciliation, denial tracking, and ERA posting
- [ ] **M4.** Time-log export tested and retained on **GFC-controlled storage**, not only the vendor's system. In a CCM/CoCM audit the time log is the evidence
- [ ] **M5.** Monthly reconciliation: platform-eligible patients counted against charges posted in OpenEMR. A gap in either direction is a revenue leak or a compliance problem
- [ ] **M6.** Consent language built into the encounter template — the launch visits double as initiating visits, so the consent conversation belongs in the visit, not a follow-up call weeks later
- [ ] **M7.** Per-patient check that no other practitioner is already billing CCM (verify **before** enrolling, not after the denial)
- [ ] **M8.** 24/7 access arrangement decided and staffed, with a named designated care team member. Decide who answers at 2am before the first patient enrolls
- [ ] **M9.** Program-level time separation confirmed so CCM and BHI minutes never overlap
- [ ] **M10.** Cost-sharing disclosure script for non-QMB patients — CCM and CoCM carry the standard 20% coinsurance as a recurring monthly charge

---

## N. Server-side patches (remediation Bucket B) — parallel track

Not blocking the billing configuration above. Best completed before real clinical use. GFC controls this server; these are ours to fix. **Verify each against the actual source before patching** — line numbers came from stack traces, not from reading the file.

- [ ] **N1. Document endpoints 500** — `DocumentService.php` ~line 92: a category-lookup query with a `?` placeholder appears to be issued without its bind array, so the query returns false and a bool reaches a function expecting an array. *Blocks:* received clinical records filing to the chart (v2.3 Appendix D row 15, v3.0 document routing rule), and the care-plan PDF into OpenEMR Documents (the Drive copy already works). Full procedure in `GFC_OpenEMR_Remediation_Plan_2026-09.md` §B1
- [ ] **N2. Vitals endpoint 500** — `VitalsCalculatedService::$authUserId` typed `int` receives `null` in API context. *Blocks:* vitals as structured chart data. Readings currently preserved verbatim in the encounter note with a clinician warning
- [ ] **N3.** Record each patch (file, diff, date, OpenEMR version) so a future upgrade does not silently revert it. Consider upstreaming — OpenEMR is open source

**Bucket C (API surface gaps — prescriptions, orders, billing rows, sign/close have no write API in 7.0.4):** decision deferred. The app's interim holds these records and mirrors them into the chart as a structured note. Revisit when manual charge entry becomes a real time cost, or when the B-series billing work needs charges natively in OpenEMR.

---

## O. Blocking items outside OpenEMR

**Blocking claim release:**
- [ ] Add psych taxonomy 363LP0808X to NPI 1962038307 in NPPES
- [ ] Resolve the Acworth vs Paces Ferry address conflict
- [ ] PECOS status for the group and each rendering clinician
- [ ] Correct NPPES taxonomy on NPI 1710678339 (currently 251E00000X Home Health, which fits neither line); obtain the clinical Type 2 NPI
- [ ] File the CMS-855B under GFC LLC; file reassignments through PECOS
- [ ] Hickory Log DCH license type and number; POS determination
- [ ] OIG and SAM screening for the full roster

**Blocking clinical operations:**
- [ ] Outside employment agreement exclusivity check for any clinician with another employer
- [ ] Face sheets, MBIs, payer order, POA billing contacts, QMB flags, MA flags, PCP information
- [ ] Delegating physician identified, with scope covering every archetype's practice and capacity for the chart review load
- [ ] Schedule II referral pathway documented
- [ ] Home/residence E/M note template live
- [ ] Charge capture log identifying rendering clinician and date of service

**Structural and compliance:**
- [ ] Per-patient AWV history pull from Palmetto eServices
- [ ] MA roster split with network status and claim routing, medical and behavioral separately
- [ ] Separate books, bank accounts, and insurance policies by service line
- [ ] Written trigger for revisiting the entity split
- [ ] Georgia healthcare attorney call on professional entity ownership
- [ ] BAAs: Availity, each facility, telehealth platform
- [ ] Write-off, adjustment, and refund policy
- [ ] ABN process — form stocked, staff trained on when to issue, signed copies filed to the chart
- [ ] Credential expiration tracker populated
- [ ] Any GFC document still referencing a standalone CMS-855R (retired — merged into the 855I)
- [ ] MFA rollout complete; tested restore performed

---

## P. Acceptance test — run before the first real claim (v3.0 Appendix A)

All must pass.

- [ ] 1. Log in as each rendering clinician with MFA. Calendar shows their availability and visit categories
- [ ] 2. Open a TEST patient assigned to each facility archetype in use. Confirm the encounter picks up the correct POS
- [ ] 3. New encounter → Fee Sheet → add a home E/M code → **fee auto-populates at the charge-master rate, not the Medicare rate**
- [ ] 4. **Attempt to bill a psych code as an A1 clinician. It should be blocked by the charge-ready gate**
- [ ] 5. Add an AWV plus a problem E/M on the same day with modifier 25. Both appear on the claim
- [ ] 6. Fees → Billing Manager → the encounter appears as a billable claim with Availity as its X12 partner. **Do not transmit**
- [ ] 7. **Mark a TEST patient QMB. Attempt to generate a statement. It should be blocked**
- [ ] 8. Administration → System → Logs → every action above appears, attributed correctly
- [ ] 9. RDS shows an encrypted database with backups; yesterday's EBS snapshot exists; the budget alarm is armed

---

## Q. Recurring maintenance (v3.0 §14 + v2.3 §11.2)

| Cadence | Task |
|---|---|
| Weekly | Denial and rejection report worked |
| Monthly | OIG LEIE and SAM re-screen, full roster |
| Monthly | Credit balance report; refunds inside the 60-day clock |
| Monthly | Adjustment and write-off review by a second person |
| Monthly | Server patch (`apt-get update && upgrade`), OpenEMR patch (`docker compose pull && up -d`), backup verification, cost check |
| Quarterly | Delegating physician chart review per v3.0 §6, documented |
| Quarterly | Backup restore drill to a scratch instance |
| Quarterly | Audit log review with written findings |
| Annually | Credential expiration sweep: licenses, certifications, DEA, PDMP, CAQH attestation, malpractice, protocol agreements |
| Annually (January) | **Reload the fee schedule after the Medicare PFS update** |
| Annually | Facility POS re-verification against current DCH licenses |
| Every 5 years | Medicare revalidation |
