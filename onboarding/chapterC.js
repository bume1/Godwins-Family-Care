// ============================================================================
// CHAPTER C · CLINICIAN, EMPLOYED — transcribed from Onboarding Playbook v3.0
// ============================================================================
// Every row cites the Playbook section it came from. Titles are the
// Playbook's own headings. Nothing here restates what an item requires: the
// wizard links the section, and the section is the requirement.
//
// `steps` is who does what, in order. Onboarding is collaborative (owner,
// 2026-11-08), so most items open with her step and close with the office's.
// `actorBasis` says where each step's actor came from:
//   STATED   — the Playbook names that role for this work (C.3 roles table or
//              the item text)
//   INFERRED — the Playbook describes the work but names nobody; the actor is
//              our reading and is listed for the owner to confirm.
//   OWNER_CONFIRMED — an inferred actor the owner has confirmed.
//
// OWNER ADDITIONS. A few items are not in Playbook v3.0 Chapter C and were
// kept by the owner from the #260 checklist. They carry `addedBy` and point at
// the Clinical Manual section that requires them where one does, never at the
// Playbook. The Playbook should be revised to list them.
//
// `classifications` are copied from the C.2 Applicable Requirements table, or
// from the Clinical Manual's §1.6 table where C.2 carries no row and the
// manual does, and each one cites which. An empty list means neither table
// classifies the item, and `classificationNote` says so. It is never filled
// in by us.
//
// `when` narrows on the hire's inputs. An absent key does not narrow.
//   serviceLines        any of IME · PRIVATE_PAY · INSURED · BEHAVIORAL
//   controlledSubstances  the scope includes controlled substances
//   outsideEmployment   she holds another clinical position
//   residenceUnderPhc   she provides services in a client residence under the
//                       private home care license (C.2, criminal records check)
//   drives              she drives to patients
//   prescribes          her scope includes prescribing
//   telehealth          she will conduct telehealth visits
// ============================================================================

'use strict';

const { ref, PAY_GUIDE } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X, classification: cls } = V;

const P = (section) => ref('PLAYBOOK', section);
const M = (section) => ref('CLINICAL_MANUAL', section);
const C2 = P('C.2');
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
// The owner confirmed every inferred actor in the first transcription
// (2026-11-08). Actors on items added later start INFERRED again.
const CONFIRMED = 'OWNER_CONFIRMED';
const M_ = (section) => ref('CLINICAL_MANUAL', section);
const OWNER_ADDED = 'Owner addition, 2026-11-08: kept from the #260 checklist though Playbook v3.0 Chapter C does not list it.';
const NO_CLASS = 'Owner addition; neither Playbook C.2 nor Clinical Manual §1.6 classifies it.';
const NO_C2_ROW = 'Playbook C.2 carries no row for this item.';

const CHAPTER = Object.freeze({
  id: 'C',
  title: 'Clinician, Employed',
  ref: P('C'),
  relationship: 'W2',
  appliesTo: 'Nurse practitioner or physician assistant on payroll'
});

// Phase identifiers follow the Playbook's own positional numbering, scoped by
// chapter, never global (Training Library §2.1).
// `id` and `title` are the Playbook's. They are references and never shown to
// a person on a screen (owner, 2026-11-08: "C.4" and "C.5.2" mean nothing to
// the office or the new hire). Screens show `number` and `label`, with
// `plainWhen` under it; the Playbook title stays available in the detail view
// for anyone who wants the source.
const PHASES = Object.freeze([
  { id: 'C.4', number: 1, label: 'Pre-Hire Screening', plainWhen: 'Before your offer',
    title: 'Phase 1 · Pre-Hire Screening', when: 'Before an offer is extended', ref: P('C.4') },
  { id: 'C.5', number: 2, label: 'Offer & Employment Paperwork', plainWhen: 'When you accept the offer',
    title: 'Phase 2 · Offer and Employment Documentation', when: 'At offer', ref: P('C.5') },
  { id: 'C.6', number: 3, label: 'Credentialing', plainWhen: 'Starts the day you sign',
    title: 'Phase 3 · Credentialing and Compliance Activation', when: 'Begins on the date of signature', ref: P('C.6'),
    // C.6: tracked on the credentialing record SEPARATELY from the onboarding
    // checklist, so a payer delay never reads as not ready to practice.
    separateRecord: 'CREDENTIALING' },
  { id: 'C.7', number: 4, label: 'Systems & Orientation', plainWhen: 'Before you see patients on your own',
    title: 'Phase 4 · Systems Access and Clinical Orientation', when: 'After clearance, before independent practice', ref: P('C.7') },
  { id: 'C.8', number: 5, label: 'Ready to See Patients', plainWhen: 'Each service line opens on its own',
    title: 'Phase 5 · Readiness Determination', when: 'By service line', ref: P('C.8'),
    // The phase opened service line by service line rather than by items.
    readiness: true },
  { id: 'C.9', number: 6, label: 'First 90 Days', plainWhen: 'Your first visits and check-ins',
    title: 'Supervised Practice and Ongoing Monitoring', when: 'From the first encounter', ref: P('C.9') }
].map(Object.freeze));

// Acknowledgment versions. The Playbook's C.11 and R3.3 name Clinical
// Policies and Procedures version 2.0; the manual in Drive is 2.2. The owner
// directed on 2026-11-08 that clinicians acknowledge 2.2. The Playbook's
// figure is kept here so the disagreement stays visible until the Playbook is
// corrected.
// Each document links its CANONICAL copy in 01 Company / Policies &
// Procedures / Current (Admin P&P §17.2). #260 linked copies in another
// folder, one of them a superseded Clinical P&P v2.0; those are not used.
const ACKNOWLEDGMENTS = Object.freeze([
  { id: 'EMPLOYEE_HANDBOOK', title: 'Employee Handbook and its acknowledgment', version: '2.0', ref: P('R3.3'),
    driveFileIds: ['1T0xnb9XKYnWw4cP4CHTcLk6j453SSskc', '1I3evN7Y6ymBnroMLWMpEV134RDM4KzBU'] },
  { id: 'CODE_OF_CONDUCT', title: 'Staff Code of Conduct', version: '2.0', ref: P('R3.3'),
    driveFileIds: ['1rbI6shvNo7zRpqh1nrw7-zrO2-Fsj1JO'] },
  { id: 'FIELD_ADDENDUM', title: 'Field Addendum to the Staff Code of Conduct', version: '1.0', ref: P('R3.3'),
    driveFileIds: ['1ju5IVJG50_EJUIqDTlCgQF6P3-f8HBCH'] },
  { id: 'HIPAA_ACK', title: 'HIPAA and Confidentiality Acknowledgment', version: '2.0', ref: P('R3.3'),
    driveFileIds: ['14EH51ldVGQZXWt_bSoSI8kYUWLLkJYAP'] },
  { id: 'CLINICAL_MANUAL', title: 'Clinical Policies and Procedures', version: '2.2', source: 'CLINICAL_MANUAL',
    ref: P('R3.3'), playbookStates: '2.0', versionSetBy: 'Owner decision, 2026-11-08',
    driveFileIds: ['1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6'] },
  // No canonical job description is in Current; the office files the one for
  // the role.
  { id: 'JOB_DESCRIPTION', title: 'Job description for the assigned role', version: 'Current', ref: P('R3.3'),
    driveFileIds: [] }
].map(Object.freeze));

const ITEMS = Object.freeze([
  // ---- C.4 · Pre-Hire Screening -------------------------------------------
  { id: 'C.4.01', phase: 'C.4', title: 'Licensure and authorization verification before interview', ref: P('C.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [
      cls('Statutory', 'Registered nurse licensure', C2),
      cls('Regulatory', 'Advanced practice authorization', C2)
    ] },
  { id: 'C.4.02', phase: 'C.4', title: 'Data bank self-query', ref: P('C.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.4.03', phase: 'C.4', title: 'Documentation sample', ref: P('C.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.CLINICAL_DIRECTOR, X.RECORD, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.4.04', phase: 'C.4', title: 'Clinical references', ref: P('C.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.CREDENTIALING_OWNER, X.RECORD, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.4.05', phase: 'C.4', title: 'Ten-year employment history', ref: P('C.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, STATED), step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED)],
    classifications: [cls('Accreditation standard', 'Ten-year employment history', C2)] },

  // ---- C.5 · Offer and Employment Documentation ---------------------------
  { id: 'C.5.01', phase: 'C.5', title: 'Offer letter and employment agreement', ref: P('C.5'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, STATED), step(A.NEW_HIRE, X.SIGN, STATED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.5.02', phase: 'C.5', title: 'Classification determination', ref: P('C.5'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.5.03', guide: PAY_GUIDE, link: { label: 'Open Pay Setup', url: '/my#hours/pay' }, phase: 'C.5', title: 'Employment and tax documentation', ref: P('C.5'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, STATED), step(A.PAYROLL_FINANCE_OFFICER, X.VERIFY, STATED)],
    elements: ['Form I-9', 'Form W-4', 'Direct deposit authorization', 'Personal details'],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.5.04', phase: 'C.5', title: 'Policy acknowledgments', ref: P('C.5'),
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    acknowledges: ACKNOWLEDGMENTS.map(a => a.id),
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.5.05', phase: 'C.5', title: 'Scheduling expectations', ref: P('C.5'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, CONFIRMED), step(A.NEW_HIRE, X.ACKNOWLEDGE, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },

  // ---- C.6 · Credentialing and Compliance Activation ----------------------
  { id: 'C.6.01', phase: 'C.6', title: 'Credentialing packet', ref: P('C.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, STATED), step(A.NEW_HIRE, X.SUBMIT, STATED),
            step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    // Each element is verified at its primary source, per the Credential
    // Verification reference. The source, pass criteria and recurrence are
    // read from R2, not restated.
    elements: [
      { row: 'State registered nurse licensure', ref: P('R2.2') },
      { row: 'Advanced practice authorization', ref: P('R2.2') },
      { row: 'National certification', ref: P('R2.2') },
      { row: 'Graduate education', ref: P('R2.2') },
      { row: 'National provider identifier', ref: P('R2.2') },
      { row: 'Malpractice coverage', ref: P('R2.2') },
      { row: 'Data bank query', ref: P('R2.2') },
      { row: 'OIG exclusion', ref: P('R2.2') },
      { row: 'Federal debarment', ref: P('R2.2') },
      { row: 'State Medicaid exclusion', ref: P('R2.2') },
      { row: 'Board discipline, all states', ref: P('R2.2') },
      { row: 'Criminal records check', ref: P('R2.2'), when: { residenceUnderPhc: true } },
      { row: 'Life support certification', ref: P('R2.2') },
      { row: 'Employment history', ref: P('R2.2') },
      { row: 'References and identity', ref: P('R2.2') },
      { row: 'Controlled substance registration', ref: P('R2.3'), when: { controlledSubstances: true } },
      { row: 'Nurse protocol agreement', ref: P('R2.3') },
      { row: 'Prescription drug monitoring enrollment', ref: P('R2.3'), when: { controlledSubstances: true } }
    ],
    classifications: [
      cls('Accreditation standard', 'Primary source verification timing', C2),
      cls('Statutory and regulatory', 'Criminal records check', C2)
    ] },
  { id: 'C.6.02', phase: 'C.6', title: 'National provider identifier and taxonomy', ref: P('C.6'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.6.03', phase: 'C.6', title: 'Nurse protocol agreement', ref: P('C.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED),   // remaining delegation capacity
            step(A.DELEGATING_PHYSICIAN, X.EXECUTE, STATED),
            step(A.NEW_HIRE, X.SIGN, STATED),
            step(A.DELEGATING_PHYSICIAN, X.RECORD, STATED)],   // files with the Board
    classifications: [
      cls('Statutory and regulatory', 'Nurse protocol agreement', C2),
      cls('Statutory', 'Delegation capacity', C2)
    ] },
  { id: 'C.6.04', phase: 'C.6', title: 'Designated alternate physician', ref: P('C.10'),
    steps: [step(A.DELEGATING_PHYSICIAN, X.RECORD, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW + ' C.10 and R1.3 cite Rule 360-32-.02(3).' },
  { id: 'C.6.05', phase: 'C.6', title: 'Controlled substance authority', ref: P('C.6'),
    when: { controlledSubstances: true },
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED)],
    // Playbook C.2 says Statutory. Clinical Manual §1.6 says Statutory and
    // regulatory for the same prohibition. Both are carried, each with its
    // source; neither is chosen for the other. Open for the owner.
    classifications: [
      cls('Statutory', 'Schedule I and II prescribing', C2),
      cls('Statutory and regulatory', 'Prohibition on APRN prescribing of Schedule I and II, subject to the emergency exception', M('1.6'))
    ] },
  { id: 'C.6.06', phase: 'C.6', title: 'Malpractice coverage', ref: P('C.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED)],
    classifications: [cls('Internal policy', 'Malpractice coverage', C2)] },
  { id: 'C.6.07', phase: 'C.6', title: 'Payer enrollment', ref: P('C.6'),
    when: { serviceLines: ['INSURED'] },
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, CONFIRMED), step(A.NEW_HIRE, X.COMPLETE, CONFIRMED),
            step(A.CREDENTIALING_OWNER, X.VERIFY, CONFIRMED)],
    separateRecord: 'PAYER_ENROLLMENT',
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.6.08', phase: 'C.6', title: 'Exclusion screening and monitoring enrollment', ref: P('C.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [cls('Recommended practice', 'Exclusion screening', C2)] },
  { id: 'C.6.09', phase: 'C.6', title: 'Outside employment review', ref: P('C.6'),
    when: { outsideEmployment: true },
    steps: [step(A.NEW_HIRE, X.SUBMIT, CONFIRMED), step(A.EXECUTIVE_DIRECTOR, X.RECORD, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },

  // ---- C.7 · Systems Access and Clinical Orientation ----------------------
  { id: 'C.7.01', link: { label: 'Open OpenEMR Sign-In', url: '/clinical#settings' }, phase: 'C.7', title: 'Clinical system identity', ref: P('C.7'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, CONFIRMED), step(A.NEW_HIRE, X.COMPLETE, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.7.02', phase: 'C.7', title: 'Clinical orientation', ref: P('C.7'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, STATED), step(A.CLINICAL_DIRECTOR, X.RECORD, STATED)],
    modulesFrom: 'phase:C.7',
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.7.03', phase: 'C.7', title: 'Documentation standards', ref: P('C.7'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, STATED), step(A.CLINICAL_DIRECTOR, X.OBSERVE, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.7.04', phase: 'C.7', title: 'Service line protocols', ref: P('C.7'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, STATED), step(A.CLINICAL_DIRECTOR, X.RECORD, CONFIRMED)],
    perServiceLine: true,
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.7.05', phase: 'C.7', title: 'Competency evaluation', ref: P('C.7'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, STATED), step(A.CLINICAL_DIRECTOR, X.OBSERVE, STATED)],
    repeats: 'annually',
    classifications: [cls('Internal policy', 'Annual competency assessment of each clinician by the Clinical Director', M('1.6'))] },

  // ---- C.9 · Supervised Practice ------------------------------------------
  { id: 'C.9.01', phase: 'C.9', title: 'First encounters observed or paired, with a same-day debriefing', ref: P('C.9'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, STATED), step(A.CLINICAL_DIRECTOR, X.OBSERVE, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  { id: 'C.9.02', phase: 'C.9', title: 'Early records reviewed, with written feedback', ref: P('C.9'),
    steps: [step(A.CLINICAL_DIRECTOR, X.RECORD, CONFIRMED)],
    classifications: [], classificationNote: NO_C2_ROW },
  // ---- Owner additions (2026-11-08) ---------------------------------------
  { id: 'C.5.06', phase: 'C.5', title: 'Twenty-four hour self-reporting duty acknowledged', ref: M_('5.3'), addedBy: OWNER_ADDED,
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'C.6.10', phase: 'C.6', title: 'Tuberculosis screening', ref: M_('16.5'), addedBy: OWNER_ADDED,
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    repeats: 'annually',
    classifications: [], classificationNote: NO_CLASS },
  { id: 'C.6.11', phase: 'C.6', title: 'Immunization record', ref: M_('16.5'), addedBy: OWNER_ADDED,
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'C.6.12', phase: 'C.6', title: "Driver's license and personal auto insurance", ref: null, addedBy: OWNER_ADDED,
    when: { drives: true },
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'C.6.13', phase: 'C.6', title: 'Licensed in the state where each telehealth patient is located', ref: M_('26.2'), addedBy: OWNER_ADDED,
    when: { telehealth: true },
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'C.6.14', phase: 'C.6', title: 'Controlled prescribing by telehealth follows the DEA rule in effect', ref: null, addedBy: OWNER_ADDED,
    when: { telehealth: true, controlledSubstances: true },
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED), step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'C.7.06', phase: 'C.7', title: 'Annual pharmacology training documented', ref: null, addedBy: OWNER_ADDED,
    when: { prescribes: true },
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED)],
    repeats: 'annually',
    classifications: [], classificationNote: NO_CLASS }
].map(it => Object.freeze(Object.assign({ chapter: 'C' }, it))));

// ---- GFC's service lines (owner, 2026-11-08) --------------------------------
// GFC runs three service lines. The Playbook's C.8 table calls its four rows
// "service lines", but they are readiness gates for scope and billing, and
// they sit INSIDE GFC's lines: IME is the Veteran Exams line; private pay,
// insurance billing and psych all open within In-Home Primary and Psych Care.
// Private Home Care is the caregiver and nurse line (Chapters A and B), so a
// clinician has no gate for it. Screens group the gates under these.
const SERVICE_LINES = Object.freeze([
  { id: 'VETERAN_EXAMS', label: 'Veteran Exams (IME)' },
  { id: 'IN_HOME_PRIMARY_PSYCH', label: 'In-Home Primary and Psych Care' },
  { id: 'PRIVATE_HOME_CARE', label: 'Private Home Care' }
].map(Object.freeze));

// ---- C.8 · Readiness Determination ----------------------------------------
// Each service line opens on its own conditions, recorded by a named owner:
// who reviewed the file, what was verified, the approved scope, and the date.
// That written determination IS the credentialing decision and the audit
// record (C.8). Requirements met is never the same as opened.
//
// The conditions are the C.8 table's clauses, as references. `modules` come
// from each module's own `required_for`, never listed here.
const DETERMINATIONS = Object.freeze([
  { id: 'IME', title: 'Independent medical examinations', label: 'Veteran Exams (IME)', serviceLine: 'VETERAN_EXAMS', ref: P('C.8'),
    conditions: ['Examiner credentialing complete with the contracting organization',
                 'The applicable protocol on file', 'Templates assigned'],
    // Playbook C.2 note and R3.7, Manual §4.1: the non-prescribing protocol
    // under O.C.G.A. 43-34-23 is unverified and requires counsel. Until then
    // the clinician practices under a filed agreement.
    openItem: 'NON_PRESCRIBING_PROTOCOL' },
  { id: 'PRIVATE_PAY', title: 'Private pay primary care', label: 'Private Pay Patients', serviceLine: 'IN_HOME_PRIMARY_PSYCH', ref: P('C.8'),
    conditions: ['Protocol agreement in force, and filed and approved where the clinician prescribes',
                 'Malpractice coverage confirmed for the scope',
                 'Clinical record system and electronic prescribing access provisioned'] },
  { id: 'INSURED', title: 'Insured billing', label: 'Insurance Billing', serviceLine: 'IN_HOME_PRIMARY_PSYCH', ref: P('C.8'), perPayer: true, includes: ['PRIVATE_PAY'],
    conditions: ['Approved individual enrollment and reassignment', 'Active group enrollment',
                 'Written confirmation of network participation from each payer'] },
  { id: 'BEHAVIORAL', title: 'Behavioral health', label: 'Psych Care', serviceLine: 'IN_HOME_PRIMARY_PSYCH', ref: P('C.8'),
    conditions: ['Both certifications verified',
                 'Psychiatric taxonomy active on the national provider identifier',
                 'Behavioral health scope written expressly into the protocol agreement',
                 'Controlled substance registration and prescription monitoring enrollment active',
                 'Psychiatric code set and templates enabled'] }
].map(d => Object.freeze(Object.assign({ chapter: 'C', recordedBy: A.READINESS_OWNER }, d))));

// ---- C.9 · Ongoing Monitoring, the table as written ------------------------
const RECURRING = Object.freeze([
  { id: 'C.9.R1', interval: 'Every thirty days', days: 30, owner: [A.CREDENTIALING_OWNER],
    requirement: 'Exclusion verification and license status monitoring',
    classification: cls('Recommended practice', 'Every thirty days', P('C.9')) },
  { id: 'C.9.R2', interval: 'Quarterly', days: 90, owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Delegating physician review of controlled substance records and evaluation of patients receiving controlled substance orders',
    classification: cls('Regulatory', 'Quarterly', P('C.9')) },
  { id: 'C.9.R3', interval: 'Within thirty days of discovery', days: null, event: 'ADVERSE_OUTCOME', owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Delegating physician review of records in which an adverse outcome occurred',
    classification: cls('Regulatory', 'Within thirty days of discovery', P('C.9')) },
  { id: 'C.9.R4', interval: 'Every one hundred twenty days', days: 120, owner: [A.CREDENTIALING_OWNER],
    when: { serviceLines: ['INSURED'] },
    requirement: 'CAQH re-attestation for any service line billing a commercial payer',
    classification: cls('Accreditation standard', 'Every one hundred twenty days', P('C.9')) },
  { id: 'C.9.R5', interval: 'Annually', days: 365, owner: [A.DELEGATING_PHYSICIAN, A.CLINICAL_DIRECTOR],
    requirement: 'Ten percent record review, on-site observation, agreement review, competency re-evaluation, malpractice renewal, credential expiration review, and performance review',
    classification: cls('Regulatory and internal policy', 'Annually', P('C.9')) },
  { id: 'C.9.R6', interval: 'Every thirty-six months', days: 1095, owner: [A.CREDENTIALING_OWNER],
    when: { serviceLines: ['INSURED'] }, whenBasis: INFERRED,
    requirement: 'Payer recredentialing, initiated ninety to one hundred twenty days before each expiration',
    classification: cls('Accreditation standard', 'Every thirty-six months', P('C.9')) },
  { id: 'C.9.R7', interval: 'Every five years', days: 1825, owner: [A.CREDENTIALING_OWNER],
    when: { serviceLines: ['INSURED'] }, whenBasis: INFERRED,
    requirement: 'Medicare revalidation',
    classification: cls('Regulatory', 'Every five years', P('C.9')) }
].map(Object.freeze));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, SERVICE_LINES, DETERMINATIONS, RECURRING };
