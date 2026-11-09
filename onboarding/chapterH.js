// ============================================================================
// CHAPTER H · STUDENT AND EXTERN — Onboarding Playbook v3.0, Chapter H
// ============================================================================
// A nursing or clinical student on placement under an affiliation agreement
// with an educational institution. NOT an employee (H.1): no offer, no I-9 or
// W-4, no Employee Handbook, no time clock, and nothing billable (H.2, False
// Claims Act). A student whose work primarily benefits GFC is an employee and
// is onboarded under Chapter A instead; where it is uncertain, Chapter A.
// Build-enforced in test/onboarding_chapter_h.test.js.
//
// Classifications are copied from the H.2 table and cite it.
//
// `when`: entersResidence — the placement involves entering a client
// residence (the Field Addendum, H.3).
// ============================================================================

'use strict';

const { ref } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X, classification: cls } = V;
const { ACKNOWLEDGMENTS: C_ACKS } = require('./chapterC');

const P = (section) => ref('PLAYBOOK', section);
const H2 = P('H.2');
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_H2_ROW = 'Playbook H.2 carries no row for this item.';

const CHAPTER = Object.freeze({
  id: 'H',
  title: 'Student and Extern',
  ref: P('H'),
  relationship: 'PLACEMENT',
  appliesTo: 'A nursing or clinical student on an educational placement under an affiliation agreement'
});

const PHASES = Object.freeze([
  { id: 'H.3', label: 'Affiliation Agreement', plainWhen: 'Before your placement starts',
    title: 'Phase 1 · Affiliation Agreement', when: 'Before placement', ref: P('H.3') },
  { id: 'H.4', label: 'Clearance', plainWhen: 'Before any client contact',
    title: 'Phase 2 · Clearance', when: 'Before any client contact', ref: P('H.4') },
  { id: 'H.5', label: 'Orientation & Placement', plainWhen: 'Your supervised placement',
    title: 'Phase 3 · Orientation and Supervised Placement', when: 'During the placement', ref: P('H.5') }
].map((p, n) => Object.freeze(Object.assign({}, p, { number: n + 1 }))));

// H.7: the Code of Conduct, the HIPAA acknowledgment, the Field Addendum where
// it applies, and the Clinical Rotation Curriculum. Never the Handbook.
const shared = (id) => C_ACKS.find(a => a.id === id);
const ACKNOWLEDGMENTS = Object.freeze([
  shared('CODE_OF_CONDUCT'),
  shared('HIPAA_ACK'),
  shared('FIELD_ADDENDUM'),
  Object.freeze({ id: 'CLINICAL_ROTATION_CURRICULUM', title: 'Clinical Rotation Curriculum', version: 'Current',
    ref: P('H.7'), driveFileIds: [] })
]);

const ITEMS = Object.freeze([
  // ---- H.3 · Affiliation Agreement ------------------------------------------
  { id: 'H.3.01', phase: 'H.3', title: 'Placement is educational, not employment', ref: P('H.1'),
    // Settled before the placement begins. Uncertain means Chapter A.
    elements: ['Primarily benefits the student', 'Does not displace a paid employee',
      'Structured around the educational experience and supervised by the institution',
      'Not presented to clients, families or in any GFC material as staff'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [cls('Statutory', 'Fair Labor Standards Act unpaid placement criteria', H2)] },
  { id: 'H.3.02', phase: 'H.3', title: 'Affiliation agreement executed', ref: P('H.3'),
    elements: ['Supervision responsibilities', 'Permitted scope of student activity',
      'Professional liability coverage: which party carries it, and its limits, confirmed', 'Privacy obligations', 'Duration of the placement'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, INFERRED)],
    classifications: [cls('Internal policy', 'Affiliation agreement', H2)] },
  { id: 'H.3.03', phase: 'H.3', title: 'Student acknowledgments', ref: P('H.3'),
    acknowledges: ['CODE_OF_CONDUCT', 'HIPAA_ACK'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    classifications: [], classificationNote: NO_H2_ROW },
  { id: 'H.3.04', phase: 'H.3', title: 'Field Addendum acknowledgment', ref: P('H.3'),
    when: { entersResidence: true },
    acknowledges: ['FIELD_ADDENDUM'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    classifications: [], classificationNote: NO_H2_ROW },

  // ---- H.4 · Clearance -------------------------------------------------------
  // At the standard the affiliation agreement or GFC requires, whichever is
  // higher. A student who has not cleared does not enter a client residence.
  { id: 'H.4.01', phase: 'H.4', title: 'Background check', ref: P('H.4'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [cls('Internal policy', 'Background check and health screening', H2)] },
  { id: 'H.4.02', phase: 'H.4', title: 'Tuberculosis screening and immunization records', ref: P('H.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [cls('Internal policy', 'Background check and health screening', H2)] },
  { id: 'H.4.03', phase: 'H.4', title: 'Basic life support certification', ref: P('H.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [], classificationNote: NO_H2_ROW },

  // ---- H.5 · Orientation and Supervised Placement ---------------------------
  { id: 'H.5.01', phase: 'H.5', title: 'Orientation', ref: P('H.5'),
    elements: ['Privacy and security obligations', 'Infection control', 'Safety', 'The escalation chain', 'The limits of permitted student activity'],
    steps: [step(A.SUPERVISOR, X.RECORD, INFERRED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [cls('Regulatory', 'Privacy and security obligations', H2)] },
  { id: 'H.5.02', phase: 'H.5', title: 'Supervision and billing limits', ref: P('H.5'),
    // H.5 and H.2: every activity supervised; no independent patient contact,
    // no signing as the responsible clinician, no caseload, and nothing billed.
    elements: ['All student activity is supervised', 'No independent patient contact', 'Never signs documentation as the responsible clinician',
      'No independent caseload', 'Student documentation is countersigned by the supervising clinician', 'Student hours are never billed to a client or payer'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED), step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [cls('Statutory', 'Billing restriction', H2)] },
  { id: 'H.5.03', phase: 'H.5', title: 'Clinical Rotation Curriculum, weeks three to eight', ref: P('H.5'),
    acknowledges: ['CLINICAL_ROTATION_CURRICULUM'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED), step(A.SUPERVISOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_H2_ROW }
].map(it => Object.freeze(Object.assign({ chapter: 'H' }, it))));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, SERVICE_LINES: [], DETERMINATIONS: [], RECURRING: [] };
