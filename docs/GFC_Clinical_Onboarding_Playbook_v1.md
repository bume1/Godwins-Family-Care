# GFC Clinical Onboarding, Credentialing & Privileging Playbook

**Version 1.0 · November 2026 · Admin-facing · Powers the clinical arm of the GFC app onboarding wizard**

Replaces: NP Credentialing Verification Playbook, 1099 Clinician Onboarding Playbook, W2 Clinician Onboarding Playbook, Hybrid Clinician Onboarding Playbook, NP Onboarding Pathway, Hiring System Map (retired).

Read alongside: Clinical Policies and Procedures Manual GFC-CLIN-v2.0, Clinical SOPs Set 1, Employee Handbook v2.0, Team Roles and Responsibilities v2, and the GFC Team README (docs.google.com/document/d/1BrANo-fKoY2tW_8dDDjR9ykUddsp1spCQcrn3yFJrIk). Every document link the wizard uses is in GFC_Wizard_Resource_Map_v1.md.

---

## How to use this document

Part 1 is the logic the app runs on: how a track is built, who owns what, and which gates lock which work.
Part 2 is the item library. Every item has an ID, a rule for when it applies, an owner, the proof required, where it is verified, the gate it blocks, and how often it repeats.
Part 3 covers privileging, orientation, ongoing compliance, and the roles reserved for later.

The wizard never stores a "playbook per person." It stores the person's inputs and builds the checklist from the item library every time those inputs change. Ticking a new lane adds only that lane's items. Removing one hides its open items and keeps completed ones in the record.

---

# PART 1 · HOW THE WIZARD BUILDS A TRACK

## 1.1 The four inputs

Every track is built from four inputs set in the Admin Hub when the person is added.

| Input | Values today | Notes |
|---|---|---|
| **Role** | `NP`, `MD_DELEGATING`, `MD_DIRECTOR` | One person can hold more than one role (a physician can be both supervising physician and medical director). Future roles are listed in 1.3. |
| **Relationship** | `W2`, `1099`, `HYBRID` | Hybrid means W2 for clinical care and 1099 for exams, under two separate agreements. |
| **Lanes** | `CLINICAL`, `EXAMS` | NPs only. A physician has no lane. No lane ticked means no lane items are generated. |
| **Credentials and add-ons** | `FNP`, `PMHNP`, `PRESCRIBES`, `CONTROLLED`, `TELEHEALTH`, `INSURED_BILLING`, `STATE_NC`, `STATE_AL` | Dual-certified NP = `FNP` + `PMHNP`. No separate third block. |

## 1.2 Composition rule

The checklist is the union of these blocks, in this order:

```
CORE(relationship)
+ FAMILY core            (Licensed Clinician core for every clinical role)
+ ROLE block(s)          (NP, MD-DEL, MD-DIR)
+ CREDENTIAL blocks      (FNP, PMHNP)
+ RELATIONSHIP block     (W2, 1099, HYBRID)
+ LANE blocks            (CLINICAL, EXAMS)
+ PRIVILEGING block      (every clinical role)
+ ADD-ON blocks          (PRESCRIBES, CONTROLLED, TELEHEALTH, INSURED_BILLING)
+ STATE blocks           (GA is default and built into the blocks above; NC and AL add on)
+ ONGOING schedule       (generated once the first gate opens)
```

An item appears once even if two blocks call for it. Example: a hybrid NP gets one license verification, not two.

## 1.3 Role registry and room for future roles

Roles belong to a **family**. The family decides which core block applies and which gates exist.

| Family | Roles live now | Roles reserved (no items yet) | Core blocks | Gates available |
|---|---|---|---|---|
| Licensed clinical | NP, MD (delegating, director) | RN, LMSW | CORE + CLIN | All |
| Clinical support | none | Clinical Care Coordinator | CORE + SUPPORT (reserved) | ACCESS, ROLE_READY |
| Administrative | none | Community Care Associate, Community Care Liaison, Executive Assistant | CORE + ADMIN (reserved) | ACCESS, ROLE_READY |

Build provisions so these drop in later without rework:

- **Item ID prefixes are reserved now.** Live: `CORE`, `CLIN`, `NP`, `FNP`, `PMH`, `MD`, `DIR`, `W2`, `C99`, `HYB`, `LCL`, `EXM`, `PRV`, `RX`, `CS`, `TH`, `INS`, `NC`, `AL`, `ONG`. Reserved: `RN`, `SW`, `CCC`, `CCA`, `CCL`, `EA`, `SUP`, `ADM`. Adding a role never renumbers existing items.
- **A role with no block yet** shows "Track not yet defined" in the Admin Hub, as Kelvin's card does today. The wizard does not error.
- **License verification is a lookup table**, keyed by license type: Nursys for RN and APRN, the Georgia Composite Medical Board for MD and DO, and a slot for the Georgia social work licensing board when LMSW is added.
- **Supervision is a link between people**, not a field on the NP. Today: NP → supervising physician. Later: LMSW → clinical supervisor, RN → Clinical Director. The parent's status can block the child's gates (see 1.5).
- **Privileging is role-agnostic.** For licensed roles it is a clinical privilege list. For support and admin roles the same mechanism becomes a "scope of work" approval with the same sign-off flow.
- **Gates are declared per family**, so an executive assistant never sees a Board or protocol gate.

## 1.4 Owners

Every item carries one owner pill. These match the prototype.

| Pill | Meaning |
|---|---|
| **Clinician** (shows her first name) | She does it herself |
| **GFC** | Office work. Item also carries an internal owner role: Credentialing Owner, Clinical Director, Executive Director, or Supervising Physician. The app maps roles to people in settings, so the playbook never names staff. |
| **Outside** | A board, payer, contractor, or vendor, on their clock |
| **Self-paced** | A module or video with no meeting |

Live sessions held in Georgia are scheduled and hosted by the Executive Director. Clinical content in those sessions is led by the Clinical Director, in person or by video.

## 1.5 Gates

A gate is a lock in the app. Each one lists the items that must be complete before it opens, and the app shows the clinician only the items still outstanding and who owes them.

| Gate | Opens | Requires |
|---|---|---|
| **G0 · ACCESS** | App and EHR accounts | Background check cleared (`CLIN-11`), Core signatures for her relationship type |
| **G-MD · PHYSICIAN READY** | Parent gate for every NP under this physician | All `MD` items complete, physician agreement executed, NP capacity confirmed |
| **G1 · EXAMS** | Exam Workspace, case acceptance | G0, all `EXM` items, exam privileges approved (`PRV`), malpractice set for this lane |
| **G2 · PATIENT VISITS** | Clinical Workspace, scheduling, charting | G0, G-MD, protocol agreement executed and Board-approved where it includes prescribing, clinical privileges approved, Manual and SOP attested, malpractice confirmed for her scope, BLS current |
| **G3 · CONTROLLED PRESCRIBING** | Controlled substance e-prescribing | G2, DEA at the GA practice address, GA PDMP registration, DEA training attestation, controlled privileges approved |
| **G4 · PSYCH** | Psych templates, psych codes | G2, PMHNP certification verified, psych taxonomy live on NPI, psych scope in the protocol agreement, psych covered by malpractice |
| **G5 · BILLING (per payer)** | Claims to that payer only | G2, payer enrollment effective. One gate per payer. Original Medicare, then each commercial or MA plan separately. |
| **ROLE_READY** | Reserved for support and admin roles | Defined when those tracks are built |

Gate opening is a recorded event: who signed it, what cleared, the approved scope, and the date. That record is the credentialing committee decision and the audit trail.

Expected order for a hybrid NP: G0, then G1 (exams usually open first, often weeks ahead), then G2, then G3 and G4, then G5 payer by payer.

---

# PART 2 · THE ITEM LIBRARY

Column key: **When** = rule for inclusion · **Owner** · **Proof** = what gets uploaded or recorded · **Verify** = primary source · **Gate** = what it blocks · **Repeats**

## 2.1 CORE · Every new team member

Pulled from the current Gusto document set. Tagged by relationship. Items move from Gusto into the app as the transition completes.

| ID | Item | When | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|---|
| CORE-01 | Accepted offer | W2, HYBRID | Clinician | Signed offer | G0 | Once |
| CORE-02 | Engagement letter | 1099 only | Clinician | Signed letter naming the work and per-case terms | G0 | Once |
| CORE-03 | Employment agreement | W2, HYBRID | Clinician | Signed agreement | G0 | Once |
| CORE-04 | Independent contractor agreement | 1099, HYBRID | Clinician | Signed ICA with insurance clause and quality standards as deliverables | G0 | Once |
| CORE-05 | Scope letter naming which work falls under which agreement | HYBRID | GFC · Executive Director | Signed one-pager | G0 | On change |
| CORE-06 | Form I-9 | W2, HYBRID | Clinician | Completed I-9, Section 2 within 3 business days of start | G0 | Once |
| CORE-07 | Form W-4 | W2, HYBRID | Clinician | Filed | G0 | On change |
| CORE-08 | Direct deposit authorization | W2, HYBRID | Clinician | Filed | G0 | On change |
| CORE-09 | Form W-9 and vendor payment setup | 1099, HYBRID | Clinician | W-9 on file, vendor record created | G0 | On change |
| CORE-10 | Non-Disclosure & Non-Solicitation Agreement | All | Clinician | Signed | G0 | Once |
| CORE-11 | Staff Code of Conduct v2.0 and Field Addendum v1.0 for anyone entering homes (RES-05, RES-06) | All. For 1099 it is signed as a contractual standard, not employee policy | Clinician | Signed | G0 | Annually |
| CORE-12 | Employee Handbook v2.0 acknowledgment (RES-03, RES-04) | W2, HYBRID. Never 1099-only | Clinician | Signed acknowledgment | G0 | On revision |
| CORE-13 | Team Roles and Responsibilities v2 (RES-02) | All | Clinician | Acknowledged | G0 | On revision |
| CORE-14 | HIPAA privacy and security training and attestation (TRN-005, then RES-07) | All | Self-paced | Completion record and signed attestation | G0 | Annually |
| CORE-15 | Emergency contact and personal details | W2, HYBRID | Clinician | Entered in app | G0 | On change |
| CORE-16 | Background check authorization (FCRA disclosure) | All | Clinician | Signed authorization | Starts CLIN-11 | Once |

Notes for the Gusto set as it stands today:
- **Split the combined "Clinician Offer, Employment & Contractor Agreements" document** into CORE-03 and CORE-04 as two standalone signatures. A single combined document makes the 1099 lane read as a condition of employment, which is the exact thing the hybrid structure has to avoid.
- **The IME provider screening application moves out of Core** and into the Exams lane (EXM-02). It does not apply to a clinician who only does clinical care.
- **Now in Drive:** Code of Conduct v2.0 (CORE-11), Field Addendum v1.0 (CORE-11), and HIPAA Acknowledgment v2.0 (CORE-14). **Still needed:** W-9 for anyone 1099 (CORE-09) and background authorization (CORE-16), both handled with the contracts.

## 2.2 CLIN · Every licensed clinician

| ID | Item | When | Owner | Proof | Verify | Gate | Repeats |
|---|---|---|---|---|---|---|---|
| CLIN-01 | Upload license, certifications, CV, government photo ID | All clinical | Clinician | Uploads |  | Starts CLIN-02 to 06 | Once |
| CLIN-02 | Individual NPI (Type 1) active, correct taxonomy and address | All clinical | GFC · Credentialing Owner | Dated screenshot | NPPES NPI Registry | G0 | On change |
| CLIN-03 | NPDB report | All clinical | Clinician runs self-query, GFC reviews | Report on file, any entry explained in writing | NPDB | G1, G2 | At recredentialing |
| CLIN-04 | Exclusion screening at intake: OIG, SAM, Georgia OIG list | All clinical | GFC · Credentialing Owner | Dated results, name matches checked against NPI | OIG LEIE, SAM.gov, GA DCH list | G0 | Monthly (ONG-01) |
| CLIN-05 | Disciplinary history, every state ever licensed | All clinical | GFC · Credentialing Owner | Dated board lookups | Nursys or each state board | G1, G2 | Monthly via license monitoring |
| CLIN-06 | Ten-year work history, gaps over 30 days explained | All clinical | Clinician provides, GFC verifies current and most recent employer | CV and written gap explanations | Employer contact | G2 | At recredentialing |
| CLIN-07 | Two professional references, one from a physician who has seen her practice | All clinical | GFC · Credentialing Owner | Dated reference notes | Direct call | G2 | Once |
| CLIN-08 | Education verified | All clinical | GFC · Credentialing Owner | Transcript or registrar confirmation. Current national certification counts as indirect proof for NPs | Registrar | G2 | Once |
| CLIN-09 | BLS current | All clinical. ACLS only when a contractor requires it | Clinician | eCard | AHA eCard lookup | G1, G2 | Every 2 years |
| CLIN-10 | Malpractice, by relationship | All clinical | See rule | **W2:** confirm GFC's policy reaches her actual scope, including psych and every setting. **1099:** carrier-issued COI, GFC named additional insured, limits meet GFC floor, tail plan if claims-made. **HYBRID:** both, one per lane, confirmed in writing | Carrier | G1, G2 | Annually |
| CLIN-11 | Fingerprint background check | All clinical | Outside | Clearance on file, determination recorded | GAPS | G0 | Per policy |
| CLIN-12 | TB screening | Anyone entering homes or clinics | Clinician | Result uploaded |  | G1, G2 | Annually |
| CLIN-13 | Immunization record per GFC health screening policy | Anyone entering homes or clinics | Clinician | Records or declinations uploaded |  | G2 | Flu annually |
| CLIN-14 | Driver's license and personal auto insurance | Anyone driving to patients | Clinician | Copies uploaded, expiration logged |  | G2 | On expiration |
| CLIN-15 | Outside employment disclosure | All clinical | Clinician | Disclosure form. If another clinical job, review its exclusivity clause before filing anything naming her |  | G2 | Annually |
| CLIN-16 | Home-Based Clinical Care standard: Clinical P&P v2.0 plus Clinical SOPs Set 1, viewed and signed (RES-08, RES-09) | All clinical, every lane | Clinician | Signature and timestamp |  | G1, G2 | On revision |
| CLIN-17 | Clinical Policies and Procedures Manual, read, attested, two scenario questions | All clinical | Self-paced, countersigned by Clinical Director | Attestation, answers, countersignature |  | G2 (and G1 for sections 12 and 13) | On revision |
| CLIN-18 | 24-hour self-reporting duty acknowledged (any action, claim, charge, or exclusion) | All clinical | Clinician | Signed acknowledgment |  | G0 | Once |
| CLIN-19 | Systems identity: own app and EHR login, own e-signature, MFA, no shared logins | All clinical | GFC | Account created and tested with her |  | Follows G0 | Once |
| CLIN-20 | Time tracking live in the app, tested before the first paid hour | W2, HYBRID | GFC | Test entry confirmed |  | G2 | Once |

## 2.3 NP · Nurse practitioner role

| ID | Item | When | Owner | Proof | Verify | Gate | Repeats |
|---|---|---|---|---|---|---|---|
| NP-01 | Georgia RN license active, unencumbered | All NPs | GFC · Credentialing Owner | QuickConfirm result | Nursys | G1, G2 | Monthly via e-Notify |
| NP-02 | Georgia APRN authorization active, population matches certification | All NPs | GFC · Credentialing Owner | Dated result | Nursys / GA Board of Nursing | G1, G2 | Monthly via e-Notify |
| NP-03 | Enroll in Nursys e-Notify | All NPs | GFC · Credentialing Owner | Enrollment confirmation | Nursys |  | Continuous |
| NP-04 | Protocol agreement executed with the supervising physician, scope written to full practice (see Part 3) | All NPs | Supervising Physician starts it, Clinician completes her half | Executed agreement in her file and at every site | GCMB | G2 | Annually reviewed |
| NP-05 | Clinician completes her portion of the online filing (uploads, attest, sign) | NPs who prescribe | Clinician | Filing confirmation | GCMB portal | G2 | Once |
| NP-06 | Board approval of the prescriptive protocol agreement | NPs who prescribe | Outside | Approval on file | GCMB | G2 | On amendment |
| NP-07 | Non-prescribing protocol on file at site | NPs on Exams lane | GFC · Clinical Director | Signed protocol in file |  | G1 | Annually reviewed |
| NP-08 | Prior protocol agreements confirmed not carried over | All NPs | GFC | Note in file |  | G2 | Once |

Physician capacity is checked under MD-07 before NP-04 is started.

## 2.4 FNP and PMHNP · Credential blocks

| ID | Item | When | Owner | Proof | Verify | Gate | Repeats |
|---|---|---|---|---|---|---|---|
| FNP-01 | FNP national certification current | `FNP` | GFC · Credentialing Owner | Dated verification and card | AANP (FNP-C) or ANCC (FNP-BC) | G1, G2 | On recertification |
| PMH-01 | PMHNP-BC certification current | `PMHNP` | GFC · Credentialing Owner | Dated verification and card | ANCC | G4 | On recertification |
| PMH-02 | Psychiatric taxonomy added to NPI, primary taxonomy set on purpose | `PMHNP` | Clinician | NPPES screenshot showing both taxonomies | NPPES | G4 | Once |
| PMH-03 | Psych scope written explicitly into the protocol agreement | `PMHNP` | Supervising Physician | Agreement section |  | G4 | With NP-04 |
| PMH-04 | Psych templates and code set enabled for her account | `PMHNP` | GFC | Configured |  | G4 | Once |

The PMH-02 failure is silent. Psych claims deny and read as a coding problem rather than an enrollment one.

## 2.5 MD · Supervising physician

The physician is onboarded as his own track. His completion opens G-MD, which every NP under him depends on.

| ID | Item | When | Owner | Proof | Verify | Gate | Repeats |
|---|---|---|---|---|---|---|---|
| MD-01 | Georgia medical license full, active, unrestricted | `MD_DELEGATING` | GFC · Credentialing Owner | Dated lookup | GCMB | G-MD | Monthly |
| MD-02 | Board certification | `MD_DELEGATING` | GFC · Credentialing Owner | Dated verification | ABMS Certification Matters or AOA | G-MD | On recertification |
| MD-03 | DEA registration, Georgia address | `MD_DELEGATING` | GFC · Credentialing Owner | Certificate and validation | DEA | G-MD | Every 3 years |
| MD-04 | NPDB, exclusions, disciplinary history | `MD_DELEGATING` | Physician self-query, GFC screens | Dated results | NPDB, OIG, SAM, GA list, GCMB | G-MD | Exclusions monthly |
| MD-05 | Malpractice COI | `MD_DELEGATING` | Physician | Carrier COI | Carrier | G-MD | Annually |
| MD-06 | Specialty comparable to each NP's and practice location within the state requirement | `MD_DELEGATING` | GFC · Credentialing Owner | Note in file per NP |  | G-MD | Per new NP |
| MD-07 | NP capacity count against the Georgia cap, including NPs he supervises elsewhere | `MD_DELEGATING` | GFC · Credentialing Owner | Written count signed by physician | Physician attestation | G-MD | Per new NP |
| MD-08 | Physician agreement executed as independent contractor | `MD_DELEGATING` | Executive Director, Physician | Signed agreement |  | G-MD | Annually reviewed |
| MD-09 | Business associate or confidentiality agreement for chart access | `MD_DELEGATING` | Physician | Signed |  | G-MD | Once |
| MD-10 | EHR reviewer account with co-sign and chart review access, MFA | `MD_DELEGATING` | GFC | Account tested |  | G-MD | Once |
| MD-11 | Supervision calendar built at signing: annual on-site observation per NP, quarterly review conference, controlled-substance charts quarterly, adverse-outcome charts within 30 days, 10% of remaining charts annually | `MD_DELEGATING` | GFC · Clinical Director | Calendar entries with owner |  | G-MD | Generated per NP |
| MD-12 | Coverage plan for a gap: designated physician bridge, backup physician named | `MD_DELEGATING` | Executive Director | Plan on file |  | G-MD | Annually |
| MD-13 | Clinical Policies and Procedures Manual acknowledged, sections 2, 3, 10 and 19 | `MD_DELEGATING` | Physician | Acknowledgment |  | G-MD | On revision |

## 2.6 DIR · Medical director

| ID | Item | When | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|---|
| DIR-01 | Medical director agreement or addendum | `MD_DIRECTOR` | Executive Director, Physician | Signed | G-MD | Annually |
| DIR-02 | Named as director on the CMS lab (CLIA) filing | `MD_DIRECTOR` | GFC | Filing copy | Lab testing | On change |
| DIR-03 | Approval authority recorded for clinical policies, standing orders, and privileging sign-off | `MD_DIRECTOR` | Executive Director | Delegation record | Privileging | Annually |

## 2.7 Relationship blocks

### W2 · Employed clinician

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| W2-01 | Exempt or non-exempt decision in writing. An hourly NP generally fails the salary-basis test and is non-exempt, overtime-eligible | Executive Director | Determination in file | G2 | On pay change |
| W2-02 | OSHA bloodborne pathogens training | Self-paced | Completion record | G2 | Annually |
| W2-03 | Hepatitis B vaccine offered within 10 working days of assignment | GFC | Vaccine record or signed declination | G2 | Once |
| W2-04 | Availability submitted and scheduling expectations set in the app | Clinician | Availability entered |  | Ongoing |
| W2-05 | 30/60/90 review dates generated | GFC | Calendar entries |  | Once |

### C99 · Contracted clinician

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| C99-01 | Classification guardrails acknowledged by whoever assigns her work: she accepts or declines cases, sets her own method, is free to work elsewhere, is never run through the handbook or trained as staff | Executive Director | Acknowledgment by the assigner | G1 | Annually |
| C99-02 | Standards provided as deliverables, not instruction (documentation, turnaround, clientele) | GFC | Standards document sent and acknowledged | G1 | On revision |

### HYB · Hybrid

Includes everything in W2 and C99, plus:

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| HYB-01 | Five separation tests answered in writing: can she decline exam cases, who controls when and where, are records actually two, is the contract work different work, does the paperwork stand alone | Executive Director | Signed worksheet | G1 | Annually |
| HYB-02 | Two pay paths: clinical hours through payroll only, exam payouts through vendor payment only | GFC | Both set up and tested | G1, G2 |  |
| HYB-03 | Every encounter tagged to a lane at point of service | System | Lane field required on encounter | G1, G2 | Continuous |
| HYB-04 | Agreements reviewed together by counsel | Executive Director | Review note | G1 | On change |

## 2.8 LCL · Clinical lane

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| LCL-01 | Clinical privileges approved (Part 3) | Clinical Director and Supervising Physician | Signed privilege list | G2 | Every 3 years |
| LCL-02 | Clinical systems orientation: app tour on first login, charting, orders, results inbox, care management time, charge capture | Self-paced | App tour completion | G2 | Once |
| LCL-03 | Live clinical session: protocol judgment, a real chart walked together, escalation chain | Executive Director hosts, Clinical Director leads | Session record signed by both | G2 | Once |
| LCL-04 | Competency validation on point-of-care testing and home equipment | Clinical Director | Signed competency form | G2 | Annually |
| LCL-05 | Field safety and infection prevention (Manual 13) | Self-paced | Completion | G2 | Annually |
| LCL-06 | First visits observed or paired, same-day debrief | Clinical Director | Debrief notes | Focused review | First 30 days |

## 2.9 EXM · Exams lane

No contractor is named here. The contractor is a field set when the clinician is assigned, and its own requirements attach to that field.

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| EXM-01 | Exam scope set: exam types, sites, contractor | Executive Director | Scope recorded | Starts EXM-02 | On change |
| EXM-02 | Provider screening application completed, submitted with GFC's group screening | Clinician completes, GFC submits | Signed application, submission date | G1 | Once per contractor |
| EXM-03 | Screening cleared, VA training instructions received | Outside | Clearance notice | G1 | Once per contractor |
| EXM-04 | VA disability examination training videos, about 20 hours | Self-paced | Certificate per module uploaded, hours tracked in app | G1 | Per VA requirement |
| EXM-05 | Contractor's own required training | Self-paced | Certificates uploaded | G1 | Per contractor |
| EXM-06 | Licensed in every state where she examines | GFC · Credentialing Owner | Dated lookups | G1 | Monthly |
| EXM-07 | GFC in-house exam training: our exam software and workflow, scheduling and check-in, templates, report turnaround, quality review, restricted chart access, no solicitation at the exam (Manual 12.4) | Executive Director hosts | Session record and short check | G1 | On workflow change |
| EXM-08 | Exam privileges approved by exam type (Part 3) | Clinical Director | Signed privilege list | G1 | Every 3 years |
| EXM-09 | Contractor confirms she is approved to accept cases | Outside | Approval notice | G1 | Per contractor |
| EXM-10 | First exam reports reviewed against contractor and GFC standard | Clinical Director | Review notes | Focused review | First 5 reports |

## 2.10 Add-on blocks

### RX · Prescribes (any medication)

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| RX-01 | Prescriptive scope and formulary limits in the protocol agreement | Supervising Physician | Agreement section | G2 | With NP-04 |
| RX-02 | E-prescribing account in her name, identity proofed | GFC, Clinician | Account active | G2 | Once |
| RX-03 | Annual pharmacology training documented | Clinician, Supervising Physician signs | Certificate |  | Annually |

### CS · Controlled substances

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| CS-01 | DEA registration at the Georgia practice address, Schedules III to V. Applied for only after the protocol agreement is approved | Clinician | Certificate | G3 | Every 3 years |
| CS-02 | DEA training attestation (8 hours on opioid and substance use disorders) at registration or renewal | Clinician | Attestation or certificate | G3 | At DEA renewal |
| CS-03 | Georgia PDMP registration | Clinician | Confirmation | G3 | Per PDMP |
| CS-04 | Schedule II referral pathway documented, since Georgia limits APRN Schedule II prescribing to narrow exceptions | Clinical Director | Pathway in file | G3 | Annually |
| CS-05 | EPCS two-factor setup | GFC, Clinician | Configured | G3 | Once |

### TH · Telehealth

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| TH-01 | Licensed in the state where each telehealth patient is located | GFC · Credentialing Owner | License lookups | Telehealth privilege | Monthly |
| TH-02 | Controlled prescribing by telehealth follows the DEA rule in effect at the time, confirmed at point of use | Clinical Director | Policy note | G3 for telehealth | On rule change |
| TH-03 | Telehealth workflow and platform orientation | Self-paced | Completion | Telehealth privilege | Once |

### INS · Insured billing

Tracked separately from onboarding. A clinician can be cleared to see patients long before she can bill a payer.

| ID | Item | Owner | Proof | Gate | Repeats |
|---|---|---|---|---|---|
| INS-01 | CAQH ProView built, attested, GFC authorized. Name, NPI, address identical across CAQH, NPPES, and PECOS | Clinician, GFC | Attestation date | G5 | Every 120 days |
| INS-02 | Medicare 855I with reassignment to GFC in the same application | GFC · Credentialing Owner | Approval letter, effective date | G5 (Medicare) | Revalidate every 5 years |
| INS-03 | Not on the Medicare opt-out list | GFC | Dated check | G5 (Medicare) | Once |
| INS-04 | Payer-by-payer credentialing, highest-volume plans first | GFC · Credentialing Owner | Written in-network confirmation per payer | G5 (that payer) | Every 36 months |

## 2.11 State blocks

Georgia is built into every block above. These add on when a clinician practices elsewhere.

| ID | Item | When | Gate |
|---|---|---|---|
| NC-01 | NC license active and unencumbered (clinician and physician) | `STATE_NC` | G2 for NC |
| NC-02 | Collaborative practice agreement per NP and site, backup physician named | `STATE_NC` | G2 for NC |
| NC-03 | Initial Approval to Practice through the NC Board of Nursing, final approval before first visit | `STATE_NC` | G2 for NC |
| NC-04 | QI meetings monthly for 6 months, then every 6 months. CPA reviewed yearly | `STATE_NC` | Ongoing |
| AL-01 | AL license active and unrestricted. Physician meets AL experience and CE requirements | `STATE_AL` | G2 for AL |
| AL-02 | Standard protocol filed with both Alabama boards, joint approval before first visit | `STATE_AL` | G2 for AL |
| AL-03 | AL controlled substance certificate plus DEA, if prescribing controlled | `STATE_AL` | G3 for AL |
| AL-04 | Quarterly QA with each CRNP, twice-yearly site visits | `STATE_AL` | Ongoing |

---

# PART 3 · PRIVILEGING, ORIENTATION, ONGOING

## 3.1 Privileging

GFC has no privileging process today. This is it.

**The rule:** her privileges mirror the service allowances in her protocol agreement. The protocol agreement is written to full practitioner scope. Privileges can be narrower than the agreement but never broader. If the agreement does not allow it, the app will not let anyone grant it.

**Default:** she receives the full scope of her agreement unless the Clinical Director or Supervising Physician narrows a specific item, with a reason recorded.

**Categories** (the protocol agreement template should list allowances in these same categories so the app can map them one to one):

| Category | Privileges |
|---|---|
| Settings | Home, clinic, facility (ALF, PCH), telehealth |
| Populations | Adult, geriatric, pediatric (FNP), psychiatric (PMHNP) |
| Assessment | History and physical, Annual Wellness Visit, cognitive screening, functional assessment |
| Diagnostics | Order and interpret labs, imaging, EKG. Point-of-care testing performed |
| Prescribing | Non-controlled. Controlled III to V. Durable medical equipment and home health orders |
| Procedures | Listed one by one (wound care, I&D, suture, specimen collection). Joint injections listed and marked not granted |
| Care management | CCM, APCM, RPM, TCM, BHI |
| Psychiatric | Psychiatric evaluation, medication management, psychotherapy, crisis assessment |
| Exams | By exam type the contractor allows NPs to perform |
| Referrals and coordination | Specialist referral, hospice and home health certification where allowed |

**Workflow in the app:**
1. Protocol agreement uploaded. Allowances mapped to the categories above.
2. Privilege list generated at full agreement scope.
3. Clinical Director reviews and narrows any item, with a reason.
4. Supervising Physician co-signs.
5. Privileges go live and switch on the matching app permissions (order types, templates, e-prescribing schedules, exam types).
6. **Focused review:** for the first 30 days, or first 10 encounters per new privilege, charts are reviewed against the standard. Exam lane: first 5 reports.
7. **Ongoing review:** chart review findings, incidents, and peer review roll up into her privilege file.
8. **Re-privileging** every 3 years with recredentialing, and whenever the protocol agreement is amended. An amendment flags her privileges for review automatically.
9. **Adding a privilege mid-cycle** (new procedure, new exam type) runs steps 3 to 6 for that item only.

For future support and admin roles the same flow becomes "scope of work": tasks they are approved to perform, approved by their supervisor, with the same record.

## 3.2 Orientation design

The goal is no more than a couple of live sessions per hire. Everything else is self-paced, and the score and timestamp are the record.

| Session | Format | Who |
|---|---|---|
| GFC orientation: who we are, org chart, pay schedule, handbook | Recorded, comprehension check | Self-paced |
| App tour on first login | In-app, on her real screens | Self-paced |
| Manual and SOP: read, attest, two scenario questions | In-app | Self-paced, Clinical Director countersigns |
| **Live clinical session** (clinical lane) | About two hours, on site | Executive Director hosts, Clinical Director leads |
| **Live exam session** (exams lane) | GFC exam software and workflow | Executive Director hosts |

For a 1099-only clinician, every orientation item is framed as standards she is agreeing to meet, never as training on how to practice.

## 3.3 Ongoing compliance schedule

Generated automatically once the first gate opens. Each item carries an owner and a reminder that fires before the due date.

| Cadence | Items |
|---|---|
| Monthly | OIG, SAM, Georgia list for every clinician and physician. License status via e-Notify and board lookups. Exam-state licenses |
| Quarterly | Supervising physician review conference. Controlled-substance chart review |
| Within 30 days | Adverse-outcome chart review |
| Every 120 days | CAQH re-attestation |
| Annually | Protocol agreement review. On-site observation by the physician. Pharmacology training. OSHA bloodborne pathogens. HIPAA. Competency assessment. Malpractice renewal. TB. Code of Conduct. 10% chart sample. Performance review (W2). Separation review (hybrid). Physician capacity count |
| Every 2 years | BLS |
| Every 3 years | Recredentialing and re-privileging. DEA renewal. Payer recredentialing, started 90 to 120 days ahead |
| Every 5 years | Medicare revalidation |
| On any event | 24-hour self-report triggers privilege review and possible suspension |

## 3.4 Corrections carried in from the old playbooks

- The 855R no longer exists. Reassignment is filed inside the 855I.
- Clinician time and availability live in the app, not Gusto.
- No IME contractor is named anywhere. The contractor is a field.
- BLS is required. ACLS only if a contractor requires it.
- Malpractice follows the relationship: W2 under GFC's policy, 1099 under her own with GFC as additional insured, hybrid both.

## 3.5 Open items before go-live

1. Protocol agreement template rewritten so its allowances use the privilege categories in 3.1.
2. Combined Gusto agreement split into separate employment and contractor agreements.
3. Code of Conduct, HIPAA, and W-9 added to the Core document set.
4. GFC health screening policy confirmed for clinicians (which immunizations, TB frequency).
5. Internal owner roles mapped to people in app settings (Credentialing Owner especially).
