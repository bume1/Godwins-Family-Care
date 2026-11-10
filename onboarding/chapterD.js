// ============================================================================
// CHAPTER D · CLINICIAN, CONTRACTED — transcribed from Onboarding Playbook v3.0
// ============================================================================
// TRUE CONTRACTORS ONLY (owner, 2026-11-08). A hybrid — employed and also
// contracted for exams — is Chapter E and clears every W-2 requirement.
//
// A nurse practitioner or physician assistant retained as an independent
// contractor (1099). D.1: GFC VERIFIES competence, orients the clinician to its
// systems and standards, and holds them to deliverables by contract. It does
// NOT train them in clinical practice, direct their method, or supervise
// day-to-day work. Running the relationship as employment converts the
// classification in substance, whatever the agreement says.
//
// D.2 is enforced in this file, and test/onboarding_chapter_d.test.js fails
// the build if it drifts:
//   * no Form I-9 or Form W-4 is collected, only a W-9;
//   * the Employee Handbook is not issued (D.8), nor the Code of Conduct,
//     which is an employee policy;
//   * no CLINICAL training: no competency evaluation, observed skill,
//     countersigned manual or probation item, and readiness (C.8) is
//     determined without modules. The contractor DOES take a short set of
//     NON-CLINICAL Training Library modules (owner, 2026-11-08): systems,
//     privacy, the AI policy, the documentation standard and the role card's
//     escalation contacts, signed off as standards acknowledged (ATTEST), never
//     as competency. That is D.6's "systems and standards", not instruction in
//     clinical practice.
//   * no scheduling-expectations item (mandatory shifts point to employment).
//
// D.1 and D.5: C.2's clinical and regulatory requirements apply WITHOUT
// MODIFICATION, so the credentialing rows are C.6's, and their
// classifications are copied from C.2 with that citation. Classifications are
// never assigned here. Chapter D has no classification table of its own.
//
// D.3 names the Executive Director, the Clinical Director, the delegating
// physician and the credentialing owner. Any other actor is INFERRED for the
// owner to confirm.
//
// `when` adds one key to Chapter C's:
//   baaRequired   the clinician's access or role requires a business
//                 associate agreement (D.4)
// ============================================================================

'use strict';

const { ref } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X, classification: cls } = V;
const C = require('./chapterC');

const P = (section) => ref('PLAYBOOK', section);
const C2 = P('C.2');
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_CLASS = 'Chapter D carries no classification table and C.2 has no row for this item.';
const cItem = (id) => C.ITEMS.find(x => x.id === id);

const CHAPTER = Object.freeze({
  id: 'D',
  title: 'Clinician, Contracted',
  ref: P('D'),
  relationship: '1099',
  appliesTo: 'Nurse practitioner or physician assistant retained as an independent contractor',
  // D.1 and D.2: no clinical training, so readiness never waits on a module.
  trainsClinically: false
});

const PHASES = Object.freeze([
  { id: 'D.4', number: 1, label: 'Scope Letter & Agreement', plainWhen: 'Before clearance begins',
    title: 'Phase 1 · Scope Letter and Agreement', when: 'Before clearance begins', ref: P('D.4') },
  { id: 'D.5', number: 2, label: 'Credentialing', plainWhen: 'Starts the day you sign',
    title: 'Phase 2 · Credentialing and Compliance Activation', when: 'Begins on the date of signature', ref: P('D.5'),
    separateRecord: 'CREDENTIALING' },
  { id: 'D.6', number: 3, label: 'Systems & Standards', plainWhen: 'After clearance',
    title: 'Phase 3 · Systems Access and Standards Review', when: 'After clearance', ref: P('D.6') },
  // D.7: readiness by service line follows C.8.
  { id: 'D.7', number: 4, label: 'Ready to See Patients', plainWhen: 'Each service line opens on its own',
    title: 'Readiness, Monitoring, and Escalation', when: 'By service line', ref: P('D.7'), readiness: true }
].map(Object.freeze));

// D.8. HIPAA is not in the list; confidentiality is in the agreement (D.4).
// The standards acknowledgment is a document the Clinical Director writes
// into the agreement; no canonical copy is in Policies / Current, so the
// office files the one for the engagement, as with a job description.
const ACKNOWLEDGMENTS = Object.freeze([
  Object.freeze({ id: 'CONTRACT_STANDARDS', title: 'Documentation, quality and client experience standards incorporated into the agreement',
    version: 'Current', ref: P('D.6'), driveFileIds: [] })
]);

const ITEMS = Object.freeze([
  // ---- D.4 · Scope Letter and Agreement ------------------------------------
  { id: 'D.4.01', phase: 'D.4', title: 'Scope letter', ref: P('D.4'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'D.4.02', phase: 'D.4', title: 'Independent contractor agreement', ref: P('D.4'),
    // D.4: counsel reviews before execution. Counsel is not a platform actor;
    // the Executive Director records the review as part of executing.
    counselReview: true,
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, STATED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'D.4.03', phase: 'D.4', title: 'Tax and confidentiality documentation', ref: P('D.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.PAYROLL_FINANCE_OFFICER, X.VERIFY, INFERRED)],
    elements: ['Form W-9', 'Vendor payment setup'],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'D.4.04', phase: 'D.4', title: 'Business associate agreement', ref: P('D.4'),
    when: { baaRequired: true },
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, INFERRED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },

  // ---- D.5 · Credentialing and Compliance Activation -----------------------
  // C.2 applies without modification, so these are C.6's rows.
  { id: 'D.5.01', phase: 'D.5', title: 'Credentialing packet', ref: P('D.5'),
    steps: cItem('C.6.01').steps, elements: cItem('C.6.01').elements, classifications: cItem('C.6.01').classifications },
  { id: 'D.5.02', phase: 'D.5', title: 'National provider identifier and taxonomy', ref: P('D.5'),
    steps: cItem('C.6.02').steps, classifications: [], classificationNote: NO_CLASS },
  { id: 'D.5.03', phase: 'D.5', title: 'Nurse protocol agreement', ref: P('D.5'),
    // D.5: a prior agreement with another organization does not transfer.
    steps: cItem('C.6.03').steps, classifications: cItem('C.6.03').classifications },
  { id: 'D.5.04', phase: 'D.5', title: 'Designated alternate physician', ref: P('C.10'),
    steps: cItem('C.6.04').steps, classifications: [], classificationNote: cItem('C.6.04').classificationNote },
  { id: 'D.5.05', phase: 'D.5', title: 'Controlled substance authority', ref: P('D.5'),
    when: { controlledSubstances: true },
    steps: cItem('C.6.05').steps, classifications: cItem('C.6.05').classifications },
  { id: 'D.5.06', phase: 'D.5', title: 'Carrier-issued certificate of insurance', ref: P('D.5'),
    // Issued by the carrier, never a copy the clinician supplies.
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    elements: ['Carrier', 'Policy number', 'Limits', 'Policy period', 'Claims-made or occurrence basis',
      'Godwins Family Care LLC named as additional insured, certificate reissued',
      'Extended reporting arrangements, where claims-made'],
    classifications: [cls('Internal policy', 'Malpractice coverage', C2)] },
  { id: 'D.5.07', phase: 'D.5', title: 'Examiner credentialing', ref: P('D.5'),
    when: { serviceLines: ['IME'] },
    // D.5: initiated first; the contracting organization's timeline governs.
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, INFERRED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'D.5.08', phase: 'D.5', title: 'Payer enrollment', ref: P('D.5'),
    when: { serviceLines: ['INSURED'] },
    steps: cItem('C.6.07').steps, separateRecord: 'PAYER_ENROLLMENT', classifications: [], classificationNote: NO_CLASS },
  { id: 'D.5.09', phase: 'D.5', title: 'Exclusion screening and monitoring enrollment', ref: P('D.5'),
    steps: cItem('C.6.08').steps, classifications: cItem('C.6.08').classifications },

  // ---- D.6 · Systems Access and Standards Review ---------------------------
  // Provisioning and the contracted standard. Not clinical instruction.
  { id: 'D.6.01', phase: 'D.6', title: 'System provisioning', ref: P('D.6'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)],
    elements: ['Clinical record account with provider authorization', 'National provider identifier and taxonomies',
      'Electronic signature', 'Multi-factor authentication',
      { row: 'Electronic prescribing access', when: { prescribes: true } }],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'D.6.02', phase: 'D.6', title: 'Standards review', ref: P('D.6'),
    steps: [step(A.CLINICAL_DIRECTOR, X.RECORD, STATED), step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    acknowledges: ['CONTRACT_STANDARDS'],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'D.6.03', phase: 'D.6', title: 'Service line documentation requirements', ref: P('D.6'),
    steps: [step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED), step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  // Owner, 2026-11-09: a contracted clinician completes the same HIPAA and
  // Confidentiality module caregivers take, on Care Courses, and uploads the
  // certificate. A certificate from an outside
  // course is evidence of a standard met, not clinical instruction (D.2).
  // Renewed every year.
  { id: 'D.6.04', phase: 'D.6', title: 'HIPAA and confidentiality on Care Courses', ref: null,
    addedBy: 'Owner addition, 2026-11-09: Playbook v3.0 Chapter D does not list it.',
    repeats: 'annually',
    link: { label: 'Open the HIPAA course', url: require('./caregiverCourses').HIPAA_URL },
    elements: ['Complete the HIPAA and Confidentiality module on Care Courses', 'Upload the certificate of completion'],
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_CLASS }
].map(it => Object.freeze(Object.assign({ chapter: 'D' }, it))));

// D.7: monitoring follows C.9, with the clinician's own malpractice renewal
// verified annually by certificate rather than administered by GFC. Copied
// row by row, classification and citation unchanged.
// Owner, 2026-11-08: non-clinical modules for contractors, chosen from the
// Training Library by id (never copied, never renumbered) and all placed in
// D.6. Each must sign off as ATTEST, CERTIFICATE or NONE; a module the
// Library signs off as OBSERVED or COUNTERSIGN is clinical evaluation and is
// refused by the build guard.
const TRAINING = Object.freeze([
  { id: 'TRN-002', why: 'Role card: boundaries of the engagement and escalation contacts' },
  { id: 'TRN-003', why: 'GFC systems' },
  { id: 'TRN-004', why: 'Application tour' },
  { id: 'TRN-005', why: 'Privacy and security' },
  { id: 'TRN-008', why: 'Artificial intelligence policy' },
  { id: 'TRN-205', why: 'The documentation standard she has contracted to meet' },
  { id: 'TRN-103', why: "The contracting organization's required training (IME scope only)" }
].map(t => Object.freeze(Object.assign({ phase: 'D.6' }, t))));

const RECURRING = Object.freeze(C.RECURRING.map(r => Object.freeze(Object.assign({}, r, {
  id: r.id.replace(/^C\.9\./, 'D.7.'),
  copiedFrom: r.id,
  requirement: r.id === 'C.9.R5'
    ? r.requirement.replace('malpractice renewal', 'malpractice renewal verified by carrier certificate')
    : r.requirement
}))));

// D.7: readiness determinations follow C.8, the same service lines and the
// same conditions.
module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, TRAINING, SERVICE_LINES: C.SERVICE_LINES, DETERMINATIONS: C.DETERMINATIONS, RECURRING };
