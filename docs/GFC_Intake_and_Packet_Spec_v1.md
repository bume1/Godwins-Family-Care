# GFC Intake & Patient Packet — Build-Ready Spec v1.1

**Revision v1.1:** Tier and Triage Level vocabulary corrected to the canonical Track A / Track B system throughout (§2B, §2C, §3.2, §5, §6). No other content changed.

**Scope:** Private Home Care arm. In-Home Primary Care arm noted where it branches; its own packet comes later.
**Sources reviewed:** `template-gfc-intake.php` (digital Assessment + Intake), the scanned paper packet (Face Sheet, Nursing Assessment, Service Plan, Medication Form, Pain Assessment, Care Instructions, Service Agreement, Bill of Rights, Supervisory note), the GFC build prompt/plan, and the service-line handout.
**Not legal advice.** The consent language below is a working draft. Have counsel or your Georgia licensure consultant review it against PCH/home-care rules and, for the primary care arm, Medicare conditions of participation before it goes live.
**Companion to** `GFC_App_Build_v2.md` (the master guide). This holds the field-level intake detail; the guide holds the architecture and sequencing.
**Visual reference:** `docs/prototype/client-prototype-full.html` is the build target for the client portal + intake screens (Session 3); `docs/prototype/phcp-portal-prototype.html` also shows the gate and family-monitoring views.

---

## 1. The model: three stages, one record

| Stage | Who completes it | Where it lives | Purpose |
|---|---|---|---|
| 1 — Assessment | Family, public link | Digital form (front door) | Lead capture + service-line triage |
| 2 — Intake & Enrollment | Family, token link | Digital form | Self-reported PHI + signed consents |
| 3 — Clinician Packet | RN, in the home | App → OpenEMR (clinical system of record) | Verified clinical assessment + care plan + ongoing |

**Boundary principle:** the family *self-reports* in Stages 1–2. The RN *verifies and signs* in Stage 3. The form feeds the record; it does not replace the nurse. Anything that requires a license, a measurement, or a signature from a clinician belongs in Stage 3.

---

## 2. Field-by-field disposition

### 2A. Stays in Intake — already in the digital form, keep as-is
Demographics, primary family contact, service-path selector, ADL level and help-needed, In-Home Primary Care screening, cognition, reason for reaching out, schedule and urgency, payment expectation, support-service interest, caregiver stress. Stage 2: homebound and recent medical activity, medical team, diagnoses, allergies, medications, skilled-care needs, recent clinical events, per-task ADLs, IADLs, behavioral and cognitive status, six-month functional risk, home/staff safety, decision-making and legal status, two emergency contacts, caregiver-matching preferences, insurance and LTC detail.

### 2B. Add to Intake — missing today, belongs in the family-facing form
| Add | Source it comes from | Notes |
|---|---|---|
| Patient Bill of Rights & Self-Determination acknowledgment | Paper `Pt_BoR` | E-signature. Georgia licensure expectation. Not in current consents. |
| State licensing & complaint notice | Paper Acknowledgment of Rights | Display ORS line + 24-hr number, capture acknowledgment. |
| Emergency treatment + financial-responsibility consent | Paper Face Sheet | Crisis Protocol covers 911/988 but not agreement to pay transport/treatment cost. |
| Advance directive / POA / POLST **document upload** | Paper Face Sheet | Today the form only asks DNR status + a legal-docs checkbox. Capture the actual document. |
| Insurance member ID / group / Medicaid # (or card image) | Paper Face Sheet | Form takes insurance *type* + SSN last-4 + LTC policy only. Capture full IDs at enrollment. |
| HIPAA Notice of Privacy Practices acknowledgment | New | Distinct from the ROI. The ROI authorizes sharing; the NPP documents that they received your privacy practices. |
| Split ROI into **ROI-family** and **ROI-provider** | Refines current single ROI | The app gates the family portal on ROI-family. One combined ROI can't drive that gate. |
| Service-path-branched consents (IHPC) | New | See §4.2. |
| Computed acuity / Track placement output | New | See §3. |

### 2C. Move to the Clinician Packet — Stage 3, RN completes in the home
These are in the paper packet and should be rebuilt as an app-owned clinician form, pre-filled from the family's intake so the nurse confirms rather than re-keys.
- Vitals / clinical baseline (BP both arms, HR, temp, weight)
- Systems exam, lung sounds, skin and wound findings with measurements
- Behavioral pain assessment (the PAINAD-style tool on the paper Pain Assessment)
- Detailed home-hazard inventory (smoke/CO detectors, grab bars, non-skid, running water, secondary exit) — this is a clinical safety check, separate from the intake's staff-safety screen
- RN triage / Track assignment and signature
- Physician orders for any skilled task
- Care Plan / Service Plan authored by the RN: problems, goals and objectives, task list, visit frequency, days/times, duration, charge plan, client co-signature, effective and target dates
- Medication reconciliation against the family-reported list
- Supervisory / skilled-nursing visit notes and reassessment dates (paper `Pt_Sup`)

### 2D. Retire — paper now duplicated by the digital intake
- Face Sheet demographic, contact, emergency, physician, pharmacy, and insurance blocks (now collected in intake; just add the full insurance IDs per 2B)
- Patient Care Instructions task checklist and functional-limitations list (now help-needed, IADL, skilled-tasks, ADL)
- Standalone Medication Form (now the intake medication rows; fix the data shape per §3)
- The self-reportable portions of the Nursing Assessment (medical history, allergies, subjective ADLs, mobility) — keep only the clinician-measured portions, which move to Stage 3

---

## 3. Data-shape fixes for app integration
1. **Medications.** The form concatenates rows into one pipe-delimited string on submit and drops prescribing provider. The app wants structured records: name, dose, route, frequency, prescribing provider, pharmacy — and they must match the care plan and client profile. Store as rows, not a string.
2. **Track vocabulary.** Paper says "Triage Level I/II/III" and older drafts say "Care Tier 1/2/3." Retire both. The canonical system is **Track A and Track B**, and no new materials should carry tier language. Track A (Personal Care) runs A1 Essential ADL, A2 Comprehensive ADL and IADL, A3 IADL-Forward Support, and A4 Behavioral Support and Cognitive Wellness. Track B is skilled nursing. Use this as the single enum and map the legacy labels so nothing is re-keyed: Tier 1 / Level I maps to A1, Tier 2 / Level II maps to A2, Tier 3 / Level III maps to A4, and any skilled-nursing designation maps to Track B. (A3 is new and has no legacy equivalent.)
3. **PHI destination (resolved).** Stage 1 (lead, no PHI) can stay on the current Apps Script. Stage 2 PHI now writes to **encrypted AWS RDS** inside the BAA boundary; uploaded documents go to **HIPAA Google Drive**; Stage 3 clinical data goes to **OpenEMR**. No PHI to a Google Sheet, and drop the blind `no-cors` submit so success is confirmable.
4. **DOB once.** Stage 1 asks Age, Stage 2 asks DOB. Collect DOB once and derive age.

---

## 4. Consent fixes

### 4.1 Service Agreement scope — REWRITE (do this first)
The signed agreement currently disclaims the services you sell. This is a liability gap, not wording.

**Current (page 10):**
> "Godwins Family Care LLC provides non-medical personal care services only. Our caregivers are trained to observe and report health changes to the family and medical team but do not provide skilled nursing, medication administration, clinical assessments, or therapeutic services."

**Replace with:**
> Godwins Family Care LLC delivers care through two service lines. **Private Home Care** provides non-medical personal care and companionship, including assistance with activities of daily living and medication reminders, and, where ordered, skilled nursing delivered by licensed nurses under the oversight of our family nurse practitioner or supervising physician. **In-Home Primary Care** provides medical visits, assessment, prescribing, and chronic disease management led by a nurse practitioner.
>
> Personal care aides provide reminders and support and observe and report changes in condition. They do not administer medication or make clinical decisions. Skilled nursing and medical services are provided only by appropriately licensed clinicians and only as set out in your care plan.
>
> Your care plan is developed with you, your family, and your care team, and is reviewed periodically. Please report any change in condition or care needs promptly so the plan can be updated.

### 4.2 Consent set, branched by service path
The form already knows which arm the client chose. Branch the consent page on it.

**Both arms:**
- HIPAA Notice of Privacy Practices acknowledgment *(add)*
- HIPAA ROI — split into ROI-family and ROI-provider *(refine)*
- **HIPAA Transfer-of-Care ROI** — client authorization for GFC to request records from prior providers. Multi-provider (one signing event generates one PDF per prior provider). Handles 42 CFR Part 2 protected categories (mental health, substance use, HIV/AIDS, genetic testing) as a separate opt-in defaulted FALSE. Prefills from the `priorProviders` field group on the client profile (§ Client Care Profile Schema). Uses canvas signature capture rather than typed name. Does NOT gate the portal. Reference implementations: `docs/source-forms/gfc_roi_upload.gs` and `docs/source-forms/template-gfc-roi-upload.php`. Built in Session 3.4. *(add)*
- Service Agreement *(rewrite per 4.1)*
- Patient Bill of Rights & Self-Determination acknowledgment *(add)*
- Emergency treatment + financial-responsibility consent *(add)*
- Emergency & Crisis Protocol, 911/988 *(have)*
- Photo / continuous-monitoring opt-in *(add, inactive — your Phase 2 field)*

**Private Home Care only:**
- Client / responsible-party financial agreement (rates, billing, cancellation)
- Personal-care-aide scope acknowledgment (reminders and observation, not administration)

**In-Home Primary Care only:**
- Consent to medical treatment
- Assignment of Medicare / insurance benefits
- The medical practice's Notice of Privacy Practices

### 4.3 Signature and audit requirements
Every consent: typed name + acknowledgment checkbox + server-side timestamp and IP. Store a consent **status per type** (Service Agreement, ROI-family, ROI-provider, `roiTransfer`, monitoring) so it maps directly to the app's consent records and drives the family-portal gate. The app should refuse to activate the family portal until ROI-family is signed, with no manual override.

**Transfer-of-Care ROI exception.** The Transfer-of-Care ROI uses canvas signature capture rather than typed name, because it produces provider-facing PDFs that need an actual signature image. All other elements (timestamp, IP, status per type) apply. This ROI spawns a parent `consent_events` record plus one `consent_provider_authorizations` child row per authorized prior provider, plus `consent_records_categories` rows for each checked record type. Server-side must validate all 45 CFR 164.508 required elements (description of information, purpose, expiration, right to revoke, redisclosure statement, signature, date) before saving. 42 CFR Part 2 protected categories (substance use, mental health, HIV/AIDS, genetic testing) are gated behind a separate opt-in that defaults FALSE and MUST be enforced at the query layer, not just the UI.

---

## 5. Who completes what, and when
1. Family submits **Assessment** (public). System routes by service path and payer, outputs a provisional Track placement.
2. Team connects, sends token. Family completes **Intake**, signs the branched consent set.
3. RN visit: completes the **Clinician Packet** in the app, confirms or corrects the family's report, takes vitals, runs the safety and pain assessments, assigns the final Track placement, authors and co-signs the care plan.
4. Ongoing: supervisory visits and reassessments append to the record; care-plan versions are retained.

---

## 6. Open decisions for Bianca
- ~~Confirm the tier vocabulary~~ — **resolved:** adopt Track A (A1 to A4) and Track B as the single enum; retire Tier and Triage Level, mapping legacy labels per §3.2.
- ~~Where Stage 2 PHI writes~~ — **resolved:** encrypted AWS RDS (operational) + Drive (documents) + OpenEMR (clinical).
- Confirm counsel/licensure review of the rewritten Service Agreement and the IHPC medical consents before launch.
