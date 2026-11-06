// ============================================================================
// THE ITEM LIBRARY — Part 2 of GFC_Clinical_Onboarding_Playbook_v1.md
// ============================================================================
// One row per playbook item, in playbook order. This file is DATA. The rules
// that read it live in clinicianOnboarding.js, and the documents and training
// modules it points at live in clinicianResources.js and clinicianTraining.js.
//
// `when` is DECLARATIVE, never a function. A predicate cannot be served to the
// browser, cannot be diffed when the playbook changes, and cannot be checked by
// a test that walks the library. An absent key means "does not narrow on this".
//   roles / relationship / lanes / addons   — any-of match against the inputs
//   field                                   — anyone entering homes or clinics
//   driving                                 — anyone driving to patients
//   prescribes                              — shorthand for the PRESCRIBES add-on
//
// `gates` is the list of gates this item BLOCKS. It is the only place a gate's
// requirements are written down (see clinicianOnboarding.js).
//
// `starts` names items this one unlocks, so the wizard can show the next thing
// rather than everything at once.
// ============================================================================

'use strict';

const O = require('./clinicianOnboarding');
const { OWNERS: OW, OWNER_ROLES: OR, ACTIONS: A, VERIFY_SOURCES: V } = O;

// ---- 2.1 CORE · Every new team member -------------------------------------
// Pulled from the Gusto document set, tagged by relationship. Items move out of
// Gusto into the app as that transition completes. GUSTO REMAINS THE SYSTEM OF
// RECORD for payroll paperwork and nothing here transmits to it — the same rule
// the caregiver packet's Section E follows, build-enforced.
const CORE = [
  { id: 'CORE-01', block: 'CORE', title: 'Accepted offer',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Signed offer', gates: ['G0'], repeats: 'once' },
  { id: 'CORE-02', block: 'CORE', title: 'Engagement letter',
    when: { relationship: ['1099'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Signed letter naming the work and the per-case terms', gates: ['G0'], repeats: 'once' },
  { id: 'CORE-03', block: 'CORE', title: 'Employment agreement',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.SIGN,
    proof: 'Signed agreement', gates: ['G0'], repeats: 'once',
    // Deliberately NOT combined with the contractor agreement (CORE-04): one
    // combined document makes the contractor lane read as a condition of
    // employment, which is the exact thing the hybrid structure has to avoid.
    // That is our reasoning, not her instruction, so it stays out of `detail`.
    detail: 'This is its own signature, separate from the contractor agreement.' },
  { id: 'CORE-04', block: 'CORE', title: 'Independent contractor agreement',
    when: { relationship: ['1099', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.SIGN,
    proof: 'Signed ICA with the insurance clause and quality standards as deliverables',
    gates: ['G0'], repeats: 'once' },
  { id: 'CORE-05', block: 'CORE', title: 'Scope letter naming which work falls under which agreement',
    when: { relationship: ['HYBRID'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.UPLOAD, proof: 'Signed one-pager', gates: ['G0'], repeats: 'on_change' },
  { id: 'CORE-06', block: 'CORE', title: 'Form I-9',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Completed I-9, Section 2 within 3 business days of start', gates: ['G0'], repeats: 'once' },
  { id: 'CORE-07', block: 'CORE', title: 'Form W-4',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Filed', gates: ['G0'], repeats: 'on_change' },
  { id: 'CORE-08', block: 'CORE', title: 'Direct deposit authorization',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Filed', gates: ['G0'], repeats: 'on_change' },
  { id: 'CORE-09', block: 'CORE', title: 'Form W-9 and vendor payment setup',
    when: { relationship: ['1099', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'W-9 on file, vendor record created', gates: ['G0'], repeats: 'on_change' },
  { id: 'CORE-10', block: 'CORE', title: 'Non-Disclosure and Non-Solicitation Agreement',
    when: {}, owner: OW.CLINICIAN, action: A.SIGN, proof: 'Signed', gates: ['G0'], repeats: 'once' },
  { id: 'CORE-11', block: 'CORE', title: 'Staff Code of Conduct, and the Field Addendum for anyone entering homes',
    when: {}, owner: OW.CLINICIAN, action: A.SIGN, proof: 'Signed',
    resources: ['RES-05', 'RES-06'], gates: ['G0'], repeats: 'annually',
    detail: 'For a contractor this is signed as a contractual standard, not as employee policy.' },
  { id: 'CORE-12', block: 'CORE', title: 'Employee Handbook acknowledgment',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.SIGN,
    proof: 'Signed acknowledgment', resources: ['RES-03', 'RES-04'],
    gates: ['G0'], repeats: 'on_revision' },
  { id: 'CORE-13', block: 'CORE', title: 'Team Roles and Responsibilities',
    when: {}, owner: OW.CLINICIAN, action: A.ACKNOWLEDGE, proof: 'Acknowledged',
    resources: ['RES-02'], module: 'TRN-002', gates: ['G0'], repeats: 'on_revision' },
  { id: 'CORE-14', block: 'CORE', title: 'HIPAA privacy and security training and attestation',
    when: {}, owner: OW.SELF_PACED, action: A.SIGN,
    proof: 'Completion record and signed attestation', resources: ['RES-07'],
    module: 'TRN-005', gates: ['G0'], repeats: 'annually' },
  { id: 'CORE-15', block: 'CORE', title: 'Emergency contact and personal details',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.RECORD,
    proof: 'Entered in the app', gates: ['G0'], repeats: 'on_change' },
  { id: 'CORE-16', block: 'CORE', title: 'Background check authorization (FCRA disclosure)',
    when: {}, owner: OW.CLINICIAN, action: A.SIGN, proof: 'Signed authorization',
    gates: [], starts: ['CLIN-11'], repeats: 'once',
    detail: 'A standalone document. The FCRA requires the disclosure to appear in a document consisting solely of it, so it is never folded into another signature.' }
];

// ---- 2.2 CLIN · Every licensed clinician ----------------------------------
const CLIN = [
  { id: 'CLIN-01', block: 'CLIN', title: 'Upload licence, certifications, CV and government photo ID',
    when: {}, owner: OW.CLINICIAN, action: A.UPLOAD, proof: 'Uploads',
    gates: [], starts: ['CLIN-02', 'CLIN-03', 'CLIN-04', 'CLIN-05', 'CLIN-06'], repeats: 'once' },
  { id: 'CLIN-02', block: 'CLIN', title: 'Individual NPI active, correct taxonomy and address',
    when: {}, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Dated screenshot', verify: V.NPPES.id, gates: ['G0'], repeats: 'on_change' },
  { id: 'CLIN-03', block: 'CLIN', title: 'NPDB report',
    when: {}, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Report on file, any entry explained in writing', verify: V.NPDB.id,
    gates: ['G1', 'G2'], repeats: 'every_3_years',
    detail: 'They run the self-query; GFC reviews it.' },
  { id: 'CLIN-04', block: 'CLIN', title: 'Exclusion screening: OIG, SAM and the Georgia list',
    when: {}, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Dated results, name matches checked against the NPI', verify: V.OIG_LEIE.id,
    alsoVerify: [V.SAM.id, V.GA_DCH.id], gates: ['G0'], repeats: 'monthly' },
  { id: 'CLIN-05', block: 'CLIN', title: 'Disciplinary history, every state ever licensed',
    when: {}, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Dated board lookups', verify: V.NURSYS.id, gates: ['G1', 'G2'], repeats: 'monthly' },
  { id: 'CLIN-06', block: 'CLIN', title: 'Ten-year work history, gaps over 30 days explained',
    when: {}, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'CV and written gap explanations', verify: V.EMPLOYER.id,
    gates: ['G2'], repeats: 'every_3_years',
    detail: 'They provide it; GFC verifies the current and most recent employer.' },
  { id: 'CLIN-07', block: 'CLIN', title: 'Two professional references, one from a physician who has seen them practise',
    when: {}, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.RECORD,
    proof: 'Dated reference notes from a direct call', gates: ['G2'], repeats: 'once' },
  { id: 'CLIN-08', block: 'CLIN', title: 'Education verified',
    when: {}, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Transcript or registrar confirmation', verify: V.REGISTRAR.id,
    gates: ['G2'], repeats: 'once',
    detail: 'For an NP a current national certification counts as indirect proof.' },
  { id: 'CLIN-09', block: 'CLIN', title: 'BLS current',
    when: {}, owner: OW.CLINICIAN, action: A.UPLOAD, proof: 'eCard', verify: V.AHA.id,
    gates: ['G1', 'G2'], repeats: 'every_2_years',
    detail: 'BLS is required. ACLS only when a contractor requires it.' },
  { id: 'CLIN-10', block: 'CLIN', title: 'Malpractice cover confirmed for their actual scope',
    when: {}, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Employee: confirm GFC’s policy reaches their actual scope, psych and every setting included. Contractor: carrier-issued COI, GFC named as additional insured, limits meet the GFC floor, tail plan if claims-made. Both: one per lane, confirmed in writing',
    verify: V.CARRIER.id, gates: ['G1', 'G2'], repeats: 'annually' },
  { id: 'CLIN-11', block: 'CLIN', title: 'Fingerprint background check',
    when: {}, owner: OW.OUTSIDE, action: A.EXTERNAL,
    proof: 'Clearance on file, determination recorded', verify: V.GAPS.id,
    gates: ['G0'], repeats: 'per_policy' },
  { id: 'CLIN-12', block: 'CLIN', title: 'TB screening',
    when: { field: true }, owner: OW.CLINICIAN, action: A.UPLOAD, proof: 'Result uploaded',
    gates: ['G1', 'G2'], repeats: 'annually' },
  { id: 'CLIN-13', block: 'CLIN', title: 'Immunization record',
    when: { field: true }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Records or signed declinations uploaded', gates: ['G2'], repeats: 'annually' },
  { id: 'CLIN-14', block: 'CLIN', title: 'Driver’s licence and personal auto insurance',
    when: { driving: true }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Copies uploaded, expiration logged', gates: ['G2'], repeats: 'on_expiration' },
  { id: 'CLIN-15', block: 'CLIN', title: 'Outside employment disclosure',
    when: {}, owner: OW.CLINICIAN, action: A.SIGN, proof: 'Disclosure form',
    gates: ['G2'], repeats: 'annually',
    detail: 'If they hold another clinical job, review its exclusivity clause before filing anything naming them.' },
  { id: 'CLIN-16', block: 'CLIN', title: 'Home-based clinical care standard: the Clinical P&P and the Clinical SOPs, read and signed',
    when: {}, owner: OW.CLINICIAN, action: A.SIGN, proof: 'Signature and timestamp',
    resources: ['RES-08', 'RES-09'], gates: ['G1', 'G2'], repeats: 'on_revision' },
  { id: 'CLIN-17', block: 'CLIN', title: 'Clinical Policies and Procedures Manual: read, attested, scenario questions',
    when: {}, owner: OW.SELF_PACED, action: A.ATTEST_WITH_CHECKS,
    proof: 'Attestation, answers and the Clinical Director’s countersignature',
    countersign: OR.CLINICAL_DIRECTOR, resources: ['RES-08'], module: 'TRN-006',
    gates: ['G1', 'G2'], repeats: 'on_revision',
    detail: 'Sections 12 and 13 are what the exams gate needs; the whole manual is what the patient-visit gate needs.' },
  { id: 'CLIN-18', block: 'CLIN', title: '24-hour self-reporting duty acknowledged',
    when: {}, owner: OW.CLINICIAN, action: A.SIGN, proof: 'Signed acknowledgment',
    gates: ['G0'], repeats: 'once',
    detail: 'Any action, claim, charge or exclusion, reported within 24 hours. A self-report triggers a privilege review.' },
  { id: 'CLIN-19', block: 'CLIN', title: 'Systems identity: their own app and EHR login, their own e-signature, MFA',
    when: {}, owner: OW.GFC, action: A.CONFIGURE, proof: 'Account created and tested with them',
    gates: [], afterGate: 'G0', repeats: 'once',
    detail: 'No shared logins, ever.' },
  { id: 'CLIN-20', block: 'CLIN', title: 'Time tracking live in the app, tested before the first paid hour',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.GFC, action: A.CONFIGURE,
    proof: 'Test entry confirmed', gates: ['G2'], repeats: 'once',
    detail: 'Clinician time and availability live in the app, not in Gusto.' }
];

// ---- 2.3 NP · Nurse practitioner role -------------------------------------
const NP = [
  { id: 'NP-01', block: 'NP', title: 'Georgia RN licence active and unencumbered',
    when: { roles: ['NP'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'QuickConfirm result', verify: V.NURSYS.id, gates: ['G1', 'G2'], repeats: 'monthly' },
  { id: 'NP-02', block: 'NP', title: 'Georgia APRN authorization active, population matches certification',
    when: { roles: ['NP'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Dated result', verify: V.NURSYS.id, gates: ['G1', 'G2'], repeats: 'monthly' },
  { id: 'NP-03', block: 'NP', title: 'Enrolled in Nursys e-Notify',
    when: { roles: ['NP'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.CONFIGURE,
    proof: 'Enrollment confirmation', verify: V.NURSYS.id, gates: [], repeats: 'continuous' },
  { id: 'NP-04', block: 'NP', title: 'Protocol agreement executed with the supervising physician',
    when: { roles: ['NP'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Executed agreement in their file and at every site', verify: V.GCMB.id,
    gates: ['G2'], repeats: 'annually',
    detail: 'Scope written to full practitioner scope. The supervising physician starts it, they complete their half. Their privileges are mapped from this document and can never be broader than it. Physician capacity is checked under MD-07 before this is started.' },
  { id: 'NP-05', block: 'NP', title: 'Their portion of the online Board filing completed',
    when: { roles: ['NP'], addons: ['PRESCRIBES'] }, owner: OW.CLINICIAN, action: A.EXTERNAL,
    proof: 'Filing confirmation', verify: V.GCMB_PORTAL.id, gates: ['G2'], repeats: 'once' },
  { id: 'NP-06', block: 'NP', title: 'Board approval of the prescriptive protocol agreement',
    when: { roles: ['NP'], addons: ['PRESCRIBES'] }, owner: OW.OUTSIDE, action: A.EXTERNAL,
    proof: 'Approval on file', verify: V.GCMB.id, gates: ['G2'], repeats: 'on_change' },
  { id: 'NP-07', block: 'NP', title: 'Non-prescribing protocol on file at the site',
    when: { roles: ['NP'], lanes: ['EXAMS'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.UPLOAD, proof: 'Signed protocol in the file', gates: ['G1'], repeats: 'annually' },
  { id: 'NP-08', block: 'NP', title: 'Prior protocol agreements confirmed not carried over',
    when: { roles: ['NP'] }, owner: OW.GFC, action: A.RECORD, proof: 'Note in the file',
    gates: ['G2'], repeats: 'once' }
];

// ---- 2.4 FNP and PMHNP · Credential blocks --------------------------------
const CREDENTIAL = [
  { id: 'FNP-01', block: 'FNP', title: 'FNP national certification current',
    when: { addons: ['FNP'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Dated verification and card', verify: V.AANP.id, alsoVerify: [V.ANCC.id],
    gates: ['G1', 'G2'], repeats: 'every_3_years' },
  { id: 'PMH-01', block: 'PMH', title: 'PMHNP-BC certification current',
    when: { addons: ['PMHNP'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER, action: A.VERIFY,
    proof: 'Dated verification and card', verify: V.ANCC.id, gates: ['G4'], repeats: 'every_3_years' },
  { id: 'PMH-02', block: 'PMH', title: 'Psychiatric taxonomy added to the NPI, primary taxonomy set on purpose',
    when: { addons: ['PMHNP'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'NPPES screenshot showing both taxonomies', verify: V.NPPES.id,
    gates: ['G4'], repeats: 'once',
    detail: 'This failure is silent. Psych claims deny and read as a coding problem rather than an enrollment one, so it gets chased in the wrong place for months.' },
  { id: 'PMH-03', block: 'PMH', title: 'Psych scope written explicitly into the protocol agreement',
    when: { addons: ['PMHNP'] }, owner: OW.GFC, ownerRole: OR.SUPERVISING_PHYSICIAN,
    action: A.RECORD, proof: 'Agreement section', gates: ['G4'], repeats: 'annually' },
  { id: 'PMH-04', block: 'PMH', title: 'Psych templates and code set enabled for their account',
    when: { addons: ['PMHNP'] }, owner: OW.GFC, action: A.CONFIGURE, proof: 'Configured',
    gates: ['G4'], repeats: 'once' }
];

// ---- 2.5 MD · Supervising physician ---------------------------------------
// His own track. His completion opens G-MD, which every NP under him depends on.
const MD = [
  { id: 'MD-01', block: 'MD', title: 'Georgia medical licence full, active and unrestricted',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Dated lookup', verify: V.GCMB.id, gates: ['G_MD'], repeats: 'monthly' },
  { id: 'MD-02', block: 'MD', title: 'Board certification',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Dated verification', verify: V.ABMS.id, gates: ['G_MD'], repeats: 'every_3_years' },
  { id: 'MD-03', block: 'MD', title: 'DEA registration at a Georgia address',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Certificate and validation', verify: V.DEA.id,
    gates: ['G_MD'], repeats: 'every_3_years' },
  { id: 'MD-04', block: 'MD', title: 'NPDB, exclusions and disciplinary history',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Dated results', verify: V.NPDB.id,
    alsoVerify: [V.OIG_LEIE.id, V.SAM.id, V.GA_DCH.id, V.GCMB.id],
    gates: ['G_MD'], repeats: 'monthly', detail: 'They run the self-query; GFC screens it.' },
  { id: 'MD-05', block: 'MD', title: 'Malpractice certificate of insurance',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Carrier COI', verify: V.CARRIER.id, gates: ['G_MD'], repeats: 'annually' },
  { id: 'MD-06', block: 'MD', title: 'Specialty comparable to each NP’s, practice location within the state requirement',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.RECORD, proof: 'Note in the file for each NP', gates: ['G_MD'], repeats: 'per_new_np' },
  { id: 'MD-07', block: 'MD', title: 'NP capacity counted against the Georgia cap',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.RECORD, proof: 'Written count signed by the physician', gates: ['G_MD'], repeats: 'per_new_np',
    detail: 'Including the NPs they supervise elsewhere. Checked before any NP’s protocol agreement is started.' },
  { id: 'MD-08', block: 'MD', title: 'Physician agreement executed as an independent contractor',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.SIGN, proof: 'Signed agreement', gates: ['G_MD'], repeats: 'annually' },
  { id: 'MD-09', block: 'MD', title: 'Business associate or confidentiality agreement for chart access',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.CLINICIAN, action: A.SIGN,
    proof: 'Signed', gates: ['G_MD'], repeats: 'once' },
  { id: 'MD-10', block: 'MD', title: 'EHR reviewer account with co-sign and chart review access, MFA on',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, action: A.CONFIGURE,
    proof: 'Account tested', gates: ['G_MD'], repeats: 'once' },
  { id: 'MD-11', block: 'MD', title: 'Supervision calendar built at signing',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Calendar entries with an owner', gates: ['G_MD'], repeats: 'per_new_np',
    detail: 'Annual on-site observation per NP, quarterly review conference, controlled-substance charts quarterly, adverse-outcome charts within 30 days, 10% of remaining charts annually.' },
  { id: 'MD-12', block: 'MD', title: 'Coverage plan for a gap, with a backup physician named',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.UPLOAD, proof: 'Plan on file', gates: ['G_MD'], repeats: 'annually' },
  { id: 'MD-13', block: 'MD', title: 'Clinical Policies and Procedures Manual acknowledged, sections 2, 3, 10 and 19',
    when: { roles: ['MD_DELEGATING'] }, owner: OW.CLINICIAN, action: A.ACKNOWLEDGE,
    proof: 'Acknowledgment', resources: ['RES-08'], gates: ['G_MD'], repeats: 'on_revision' }
];

// ---- 2.6 DIR · Medical director -------------------------------------------
const DIR = [
  { id: 'DIR-01', block: 'DIR', title: 'Medical director agreement or addendum',
    when: { roles: ['MD_DIRECTOR'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.SIGN, proof: 'Signed', gates: ['G_MD'], repeats: 'annually' },
  { id: 'DIR-02', block: 'DIR', title: 'Named as director on the CMS lab (CLIA) filing',
    when: { roles: ['MD_DIRECTOR'] }, owner: OW.GFC, action: A.UPLOAD,
    proof: 'Filing copy', gates: [], repeats: 'on_change',
    detail: 'Blocks lab testing rather than a gate.' },
  { id: 'DIR-03', block: 'DIR', title: 'Approval authority recorded for clinical policies, standing orders and privileging sign-off',
    when: { roles: ['MD_DIRECTOR'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.RECORD, proof: 'Delegation record', gates: [], repeats: 'annually' }
];

// ---- 2.7 Relationship blocks ----------------------------------------------
const RELATIONSHIP = [
  { id: 'W2-01', block: 'W2', title: 'Exempt or non-exempt decision in writing',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.RECORD, proof: 'Determination in the file', gates: ['G2'], repeats: 'on_change',
    detail: 'An hourly NP generally fails the salary-basis test and is non-exempt, so overtime-eligible.' },
  { id: 'W2-02', block: 'W2', title: 'OSHA bloodborne pathogens training',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.SELF_PACED, action: A.EXTERNAL,
    proof: 'Completion record', module: 'TRN-204', gates: ['G2'], repeats: 'annually' },
  { id: 'W2-03', block: 'W2', title: 'Hepatitis B vaccine offered within 10 working days of assignment',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.GFC, action: A.UPLOAD,
    proof: 'Vaccine record or signed declination', gates: ['G2'], repeats: 'once' },
  { id: 'W2-04', block: 'W2', title: 'Availability submitted and scheduling expectations set',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.CLINICIAN, action: A.RECORD,
    proof: 'Availability entered in the app', gates: [], repeats: 'continuous' },
  { id: 'W2-05', block: 'W2', title: '30, 60 and 90 day review dates generated',
    when: { relationship: ['W2', 'HYBRID'] }, owner: OW.GFC, action: A.RECORD,
    proof: 'Calendar entries', gates: [], repeats: 'once' },
  { id: 'C99-01', block: 'C99', title: 'Classification guardrails acknowledged by whoever assigns their work',
    when: { relationship: ['1099', 'HYBRID'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.SIGN, proof: 'Acknowledgment by the assigner', gates: ['G1'], repeats: 'annually',
    detail: 'They accept or decline cases, set their own method, are free to work elsewhere, and are never run through the handbook or trained as staff.' },
  { id: 'C99-02', block: 'C99', title: 'Standards provided as deliverables, not as instruction',
    when: { relationship: ['1099', 'HYBRID'] }, owner: OW.GFC, action: A.RECORD,
    proof: 'Standards document sent and acknowledged', gates: ['G1'], repeats: 'on_revision',
    detail: 'Documentation, turnaround and clientele as deliverables.' },
  { id: 'HYB-01', block: 'HYB', title: 'Five separation tests answered in writing',
    when: { relationship: ['HYBRID'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.SIGN, proof: 'Signed worksheet', gates: ['G1'], repeats: 'annually',
    detail: 'Can they decline exam cases; who controls when and where; are the records actually two; is the contract work different work; does the paperwork stand alone.' },
  { id: 'HYB-02', block: 'HYB', title: 'Two pay paths set up and tested',
    when: { relationship: ['HYBRID'] }, owner: OW.GFC, action: A.CONFIGURE,
    proof: 'Both set up and tested', gates: ['G1', 'G2'], repeats: 'once',
    detail: 'Clinical hours through payroll only; exam payouts through vendor payment only.' },
  { id: 'HYB-03', block: 'HYB', title: 'Every encounter tagged to a lane at the point of service',
    when: { relationship: ['HYBRID'] }, owner: OW.SYSTEM, action: A.CONFIGURE,
    proof: 'Lane field required on the encounter', gates: ['G1', 'G2'], repeats: 'continuous' },
  { id: 'HYB-04', block: 'HYB', title: 'Agreements reviewed together by counsel',
    when: { relationship: ['HYBRID'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.RECORD, proof: 'Review note', gates: ['G1'], repeats: 'on_change' }
];

// ---- 2.8 LCL · Clinical lane ----------------------------------------------
const LCL = [
  { id: 'LCL-01', block: 'LCL', title: 'Clinical privileges approved',
    when: { lanes: ['CLINICAL'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Signed privilege list', gates: ['G2'], repeats: 'every_3_years',
    privileging: true,
    detail: 'Mapped from their protocol agreement, narrowed only with a reason, and co-signed by the supervising physician.' },
  { id: 'LCL-02', block: 'LCL', title: 'Clinical systems orientation',
    when: { lanes: ['CLINICAL'] }, owner: OW.SELF_PACED, action: A.EXTERNAL,
    proof: 'App tour completion', module: 'TRN-004', gates: ['G2'], repeats: 'once',
    detail: 'App tour on first login, charting, orders, the results inbox, care management time, charge capture.' },
  { id: 'LCL-03', block: 'LCL', title: 'Live clinical session',
    when: { lanes: ['CLINICAL'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Session record signed by both', module: 'TRN-301',
    gates: ['G2'], repeats: 'once',
    detail: 'Protocol judgment, a real chart walked together, the escalation chain. The Executive Director hosts; the Clinical Director leads.' },
  { id: 'LCL-04', block: 'LCL', title: 'Competency validated on point-of-care testing and home equipment',
    when: { lanes: ['CLINICAL'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Signed competency form', module: 'TRN-220',
    gates: ['G2'], repeats: 'annually' },
  { id: 'LCL-05', block: 'LCL', title: 'Field safety and infection prevention',
    when: { lanes: ['CLINICAL'] }, owner: OW.SELF_PACED, action: A.EXTERNAL,
    proof: 'Completion', module: 'TRN-203', gates: ['G2'], repeats: 'annually' },
  { id: 'LCL-06', block: 'LCL', title: 'First visits observed or paired, same-day debrief',
    when: { lanes: ['CLINICAL'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Debrief notes', module: 'TRN-302',
    gates: [], focusedReview: true, repeats: 'once',
    detail: 'The first 30 days. This is focused review, not a gate: it happens after they start, not before.' }
];

// ---- 2.9 EXM · Exams lane -------------------------------------------------
// NO CONTRACTOR IS NAMED HERE. The contractor is a field set when she is
// assigned, and its own requirements attach to that field. Build-enforced.
const EXM = [
  { id: 'EXM-01', block: 'EXM', title: 'Exam scope set: exam types, sites and contractor',
    when: { lanes: ['EXAMS'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.RECORD, proof: 'Scope recorded', gates: [],
    starts: ['EXM-02'], repeats: 'on_change' },
  { id: 'EXM-02', block: 'EXM', title: 'Provider screening application completed and submitted',
    when: { lanes: ['EXAMS'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Signed application and the submission date', resources: ['RES-20'],
    gates: ['G1'], repeats: 'per_contractor',
    detail: 'They complete it; GFC submits it with the group screening.' },
  { id: 'EXM-03', block: 'EXM', title: 'Screening cleared, training instructions received',
    when: { lanes: ['EXAMS'] }, owner: OW.OUTSIDE, action: A.EXTERNAL,
    proof: 'Clearance notice', gates: ['G1'], repeats: 'per_contractor' },
  { id: 'EXM-04', block: 'EXM', title: 'Disability examination training videos',
    when: { lanes: ['EXAMS'] }, owner: OW.SELF_PACED, action: A.EXTERNAL,
    proof: 'Certificate per module uploaded, hours tracked in the app',
    module: 'TRN-102', gates: ['G1'], repeats: 'per_contractor',
    detail: 'About 20 hours. The link comes from the contractor once screening clears.' },
  { id: 'EXM-05', block: 'EXM', title: 'Contractor’s own required training',
    when: { lanes: ['EXAMS'] }, owner: OW.SELF_PACED, action: A.EXTERNAL,
    proof: 'Certificates uploaded', resources: ['RES-21'], module: 'TRN-103',
    gates: ['G1'], repeats: 'per_contractor' },
  { id: 'EXM-06', block: 'EXM', title: 'Licensed in every state where they examine',
    when: { lanes: ['EXAMS'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Dated lookups', verify: V.NURSYS.id, gates: ['G1'], repeats: 'monthly' },
  { id: 'EXM-07', block: 'EXM', title: 'GFC in-house exam training',
    when: { lanes: ['EXAMS'] }, owner: OW.GFC, ownerRole: OR.EXECUTIVE_DIRECTOR,
    action: A.RECORD, proof: 'Session record and short check', module: 'TRN-104',
    resources: ['RES-23', 'RES-24'], gates: ['G1'], repeats: 'on_revision',
    detail: 'Our exam software and workflow, scheduling and check-in, templates, report turnaround, quality review, restricted chart access, and no solicitation at the exam.' },
  { id: 'EXM-08', block: 'EXM', title: 'Exam privileges approved by exam type',
    when: { lanes: ['EXAMS'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Signed privilege list', gates: ['G1'],
    privileging: true, repeats: 'every_3_years' },
  { id: 'EXM-09', block: 'EXM', title: 'Contractor confirms they are approved to accept cases',
    when: { lanes: ['EXAMS'] }, owner: OW.OUTSIDE, action: A.EXTERNAL,
    proof: 'Approval notice', gates: ['G1'], repeats: 'per_contractor' },
  { id: 'EXM-10', block: 'EXM', title: 'First exam reports reviewed against the standard',
    when: { lanes: ['EXAMS'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Review notes', module: 'TRN-106',
    gates: [], focusedReview: true, repeats: 'once',
    detail: 'The first 5 reports. Focused review, not a gate.' }
];

// ---- 2.10 Add-on blocks ---------------------------------------------------
const ADDON = [
  { id: 'RX-01', block: 'RX', title: 'Prescriptive scope and formulary limits in the protocol agreement',
    when: { addons: ['PRESCRIBES'] }, owner: OW.GFC, ownerRole: OR.SUPERVISING_PHYSICIAN,
    action: A.RECORD, proof: 'Agreement section', gates: ['G2'], repeats: 'annually' },
  { id: 'RX-02', block: 'RX', title: 'E-prescribing account in their name, identity proofed',
    when: { addons: ['PRESCRIBES'] }, owner: OW.GFC, action: A.CONFIGURE,
    proof: 'Account active', module: 'TRN-207', gates: ['G2'], repeats: 'once' },
  { id: 'RX-03', block: 'RX', title: 'Annual pharmacology training documented',
    when: { addons: ['PRESCRIBES'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Certificate, signed by the supervising physician', gates: [], repeats: 'annually' },
  { id: 'CS-01', block: 'CS', title: 'DEA registration at the Georgia practice address, Schedules III to V',
    when: { addons: ['CONTROLLED'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Certificate', verify: V.DEA.id, gates: ['G3'], repeats: 'every_3_years',
    detail: 'Applied for only after the protocol agreement is approved.' },
  { id: 'CS-02', block: 'CS', title: 'DEA training attestation',
    when: { addons: ['CONTROLLED'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Attestation or certificate', gates: ['G3'], repeats: 'every_3_years',
    detail: 'Eight hours on opioid and substance use disorders, at registration or renewal.' },
  { id: 'CS-03', block: 'CS', title: 'Georgia PDMP registration',
    when: { addons: ['CONTROLLED'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Confirmation', module: 'TRN-208', gates: ['G3'], repeats: 'per_policy' },
  { id: 'CS-04', block: 'CS', title: 'Schedule II referral pathway documented',
    when: { addons: ['CONTROLLED'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.UPLOAD, proof: 'Pathway in the file', gates: ['G3'], repeats: 'annually',
    detail: 'Georgia limits APRN Schedule II prescribing to narrow exceptions, so the referral route to the physician is the working answer and has to be written down.' },
  { id: 'CS-05', block: 'CS', title: 'EPCS two-factor setup',
    when: { addons: ['CONTROLLED'] }, owner: OW.GFC, action: A.CONFIGURE,
    proof: 'Configured', gates: ['G3'], repeats: 'once' },
  { id: 'TH-01', block: 'TH', title: 'Licensed in the state where each telehealth patient is located',
    when: { addons: ['TELEHEALTH'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Licence lookups', verify: V.NURSYS.id,
    gates: [], privilegeGate: 'telehealth', repeats: 'monthly' },
  { id: 'TH-02', block: 'TH', title: 'Controlled prescribing by telehealth follows the DEA rule in effect',
    when: { addons: ['TELEHEALTH', 'CONTROLLED'], addonsAll: true },
    owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR, action: A.UPLOAD,
    proof: 'Policy note', gates: ['G3'], repeats: 'on_change',
    detail: 'Confirmed at the point of use, because the rule has changed repeatedly.' },
  { id: 'TH-03', block: 'TH', title: 'Telehealth workflow and platform orientation',
    when: { addons: ['TELEHEALTH'] }, owner: OW.SELF_PACED, action: A.EXTERNAL,
    proof: 'Completion', module: 'TRN-218', gates: [], privilegeGate: 'telehealth', repeats: 'once' },
  { id: 'INS-01', block: 'INS', title: 'CAQH ProView built, attested and GFC authorized',
    when: { addons: ['INSURED_BILLING'] }, owner: OW.CLINICIAN, action: A.EXTERNAL,
    proof: 'Attestation date', verify: V.CAQH.id, gates: ['G5'], repeats: 'every_120_days',
    detail: 'Name, NPI and address identical across CAQH, NPPES and PECOS, or the application stalls without saying why.' },
  { id: 'INS-02', block: 'INS', title: 'Medicare 855I with reassignment to GFC in the same application',
    when: { addons: ['INSURED_BILLING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.UPLOAD, proof: 'Approval letter and the effective date', verify: V.PECOS.id,
    gates: ['G5'], payer: 'medicare', repeats: 'every_5_years',
    detail: 'The 855R no longer exists. Reassignment is filed inside the 855I.' },
  { id: 'INS-03', block: 'INS', title: 'Not on the Medicare opt-out list',
    when: { addons: ['INSURED_BILLING'] }, owner: OW.GFC, action: A.VERIFY,
    proof: 'Dated check', verify: V.PECOS.id, gates: ['G5'], payer: 'medicare', repeats: 'once' },
  { id: 'INS-04', block: 'INS', title: 'Payer-by-payer credentialing',
    when: { addons: ['INSURED_BILLING'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.UPLOAD, proof: 'Written in-network confirmation for each payer',
    gates: ['G5'], perPayer: true, repeats: 'every_3_years',
    detail: 'Highest-volume plans first. One gate per payer, so they can bill one plan while another is still pending.' }
];

// ---- 2.11 State blocks ----------------------------------------------------
// Georgia is built into every block above. These add on.
const STATE = [
  { id: 'NC-01', block: 'NC', title: 'North Carolina licence active and unencumbered',
    when: { addons: ['STATE_NC'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Dated lookups for the clinician and the physician',
    verify: V.NC_BON.id, gates: ['G2'], state: 'NC', repeats: 'monthly' },
  { id: 'NC-02', block: 'NC', title: 'Collaborative practice agreement per NP and site',
    when: { addons: ['STATE_NC'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Executed CPA with a backup physician named', gates: ['G2'], state: 'NC', repeats: 'annually' },
  { id: 'NC-03', block: 'NC', title: 'Approval to Practice through the NC Board of Nursing',
    when: { addons: ['STATE_NC'] }, owner: OW.OUTSIDE, action: A.EXTERNAL,
    proof: 'Initial approval, then final approval before the first visit',
    verify: V.NC_BON.id, gates: ['G2'], state: 'NC', repeats: 'once' },
  { id: 'NC-04', block: 'NC', title: 'North Carolina QI meetings',
    when: { addons: ['STATE_NC'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Meeting records', gates: [], state: 'NC', repeats: 'quarterly',
    detail: 'Monthly for the first 6 months, then every 6 months. The CPA is reviewed yearly.' },
  { id: 'AL-01', block: 'AL', title: 'Alabama licence active and unrestricted',
    when: { addons: ['STATE_AL'] }, owner: OW.GFC, ownerRole: OR.CREDENTIALING_OWNER,
    action: A.VERIFY, proof: 'Dated lookups. The physician must also meet the Alabama experience and CE requirements',
    verify: V.AL_BOARDS.id, gates: ['G2'], state: 'AL', repeats: 'monthly' },
  { id: 'AL-02', block: 'AL', title: 'Standard protocol filed with both Alabama boards',
    when: { addons: ['STATE_AL'] }, owner: OW.CLINICIAN, action: A.UPLOAD,
    proof: 'Joint approval before the first visit', verify: V.AL_BOARDS.id,
    gates: ['G2'], state: 'AL', repeats: 'annually' },
  { id: 'AL-03', block: 'AL', title: 'Alabama controlled substance certificate',
    when: { addons: ['STATE_AL', 'CONTROLLED'], addonsAll: true }, owner: OW.CLINICIAN,
    action: A.UPLOAD, proof: 'Certificate, alongside the DEA registration',
    gates: ['G3'], state: 'AL', repeats: 'every_3_years' },
  { id: 'AL-04', block: 'AL', title: 'Alabama QA with each CRNP',
    when: { addons: ['STATE_AL'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'QA records', gates: [], state: 'AL', repeats: 'quarterly',
    detail: 'Quarterly QA, twice-yearly site visits.' }
];

// ---- PRV · Privileging (playbook Part 3) ----------------------------------
// Every clinical role gets the privileging block. The items are the workflow's
// own steps so the checklist shows where a privilege list has stalled.
const PRV = [
  { id: 'PRV-01', block: 'PRV', title: 'Protocol agreement mapped to the privilege categories',
    when: { lanes: ['CLINICAL', 'EXAMS'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Allowances mapped, one to one', gates: [],
    privileging: true, repeats: 'on_change',
    detail: 'Privileges can be narrower than the agreement but never broader. If the agreement does not allow it, nobody can grant it.' },
  { id: 'PRV-02', block: 'PRV', title: 'Privilege list reviewed and narrowed where needed, with a reason',
    when: { lanes: ['CLINICAL', 'EXAMS'] }, owner: OW.GFC, ownerRole: OR.CLINICAL_DIRECTOR,
    action: A.RECORD, proof: 'Reviewed list, each narrowing carrying its reason',
    gates: [], privileging: true, repeats: 'every_3_years' },
  { id: 'PRV-03', block: 'PRV', title: 'Privilege list co-signed by the supervising physician',
    when: { lanes: ['CLINICAL'] }, owner: OW.GFC, ownerRole: OR.SUPERVISING_PHYSICIAN,
    action: A.SIGN, proof: 'Co-signature', gates: [], privileging: true, repeats: 'every_3_years' }
];

const ITEM_LIBRARY = Object.freeze([]
  .concat(CORE, CLIN, NP, CREDENTIAL, MD, DIR, RELATIONSHIP, LCL, EXM, PRV, ADDON, STATE)
  .map(Object.freeze));

// Block order is the playbook's composition order (1.2) and is what the
// checklist is sorted by, so a person reads it in the order the playbook builds it.
const BLOCK_ORDER = Object.freeze(['CORE', 'CLIN', 'NP', 'FNP', 'PMH', 'MD', 'DIR',
  'W2', 'C99', 'HYB', 'LCL', 'EXM', 'PRV', 'RX', 'CS', 'TH', 'INS', 'NC', 'AL', 'ONG']);

const BLOCK_TITLES = Object.freeze({
  CORE: 'Joining GFC',
  CLIN: 'Your clinical file',
  NP: 'Nurse practitioner',
  FNP: 'Family NP certification',
  PMH: 'Psych NP certification',
  MD: 'Supervising physician',
  DIR: 'Medical director',
  W2: 'As an employee',
  C99: 'As a contractor',
  HYB: 'Employee and contractor',
  LCL: 'Patient visits',
  EXM: 'Exams',
  PRV: 'Privileges',
  RX: 'Prescribing',
  CS: 'Controlled medication',
  TH: 'Telehealth',
  INS: 'Billing insurance',
  NC: 'North Carolina',
  AL: 'Alabama',
  ONG: 'Keeping current'
});

module.exports = { ITEM_LIBRARY, BLOCK_ORDER, BLOCK_TITLES };
