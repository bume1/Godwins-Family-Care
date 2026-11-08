// ============================================================================
// CHAPTER E · CLINICIAN, HYBRID — Onboarding Playbook v3.0, Chapter E
// ============================================================================
// One clinician, employed (W-2) for clinical care AND separately contracted
// (1099) for independent medical examinations. E.1: "Run Chapter C for the
// employed engagement and Chapter D for the contracted engagement."
//
// OWNER RULE, 2026-11-08: a hybrid clears EVERY W-2 requirement. The employed
// side is Chapter C whole and unchanged — Employee Handbook, I-9 and W-4,
// training, competency, orientation, everything. The contractor side is small
// and exists for payment classification only, so Chapter D's employment
// guards (no Handbook, no training) do NOT apply here; they are for a
// true contractor, who is Chapter D alone.
//
// What E adds on top of C is one phase, the contracted engagement:
//   * the independent contractor agreement for the examination work (E.2:
//     each agreement complete and independent, reviewed by counsel as a pair)
//   * Form W-9 and vendor payment setup (E.2: payroll for one, vendor
//     payment for the other)
//   * the E.3 separation: separate time records, payment runs and case
//     remittances, offered-and-accepted exam assignments, and the malpractice
//     policy that responds to each engagement.
//
// Everything built once (E.2 left column) is Chapter C's own item and is not
// repeated: licensure, NPI, the protocol agreement (E.5: ONE agreement covers
// both), DEA, exclusion screening, the clinical record identity.
// ============================================================================

'use strict';

const { ref } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X } = V;
const C = require('./chapterC');

const P = (section) => ref('PLAYBOOK', section);
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_CLASS = 'Chapter E carries no classification table.';

const CHAPTER = Object.freeze({
  id: 'E',
  title: 'Clinician, Hybrid',
  ref: P('E'),
  relationship: 'W2+1099',
  appliesTo: 'A clinician employed for clinical care and separately contracted for independent medical examinations',
  // The employed side trains exactly as Chapter C does.
  trainsClinically: true,
  usesTrainingLibrary: true
});

// C's phases, with the contracted engagement after the employment paperwork.
// Numbers are renumbered for the screen; ids stay the Playbook's.
const CONTRACT_PHASE = Object.freeze({ id: 'E.2', label: 'Exam Contract & Payment', plainWhen: 'For your exam work, paid separately',
  title: 'The Contracted Engagement', when: 'Alongside the employment paperwork', ref: P('E.2') });
const PHASES = Object.freeze((() => {
  const out = [];
  C.PHASES.forEach(p => { out.push(p); if (p.id === 'C.5') out.push(CONTRACT_PHASE); });
  return out.map((p, n) => Object.freeze(Object.assign({}, p, { number: n + 1 })));
})());

const CONTRACT_ITEMS = Object.freeze([
  { id: 'E.2.01', phase: 'E.2', title: 'Independent contractor agreement for examinations', ref: P('E.2'),
    // E.3 test 5: neither agreement conditioned on the other; counsel reviews
    // the pair together.
    counselReview: true,
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, INFERRED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'E.2.02', phase: 'E.2', title: 'Form W-9 and vendor payment setup', ref: P('E.2'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.PAYROLL_FINANCE_OFFICER, X.VERIFY, INFERRED)],
    elements: ['Form W-9', 'Vendor payment setup, separate from payroll'],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'E.2.03', phase: 'E.2', title: 'The two engagements kept separate', ref: P('E.3'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    elements: [
      'Exam assignments are offered and accepted, never scheduled like clinical shifts',
      'Separate time records: clinical hours on the GFC clock, exam work by case',
      'Separate payment runs and case remittances',
      'The malpractice policy that responds to each engagement'
    ],
    classifications: [], classificationNote: NO_CLASS }
].map(it => Object.freeze(Object.assign({ chapter: 'E' }, it))));

module.exports = {
  CHAPTER, PHASES,
  ACKNOWLEDGMENTS: C.ACKNOWLEDGMENTS,           // the full W-2 set, Handbook included
  ITEMS: Object.freeze(C.ITEMS.concat(CONTRACT_ITEMS)),
  CONTRACT_ITEMS,
  SERVICE_LINES: C.SERVICE_LINES, DETERMINATIONS: C.DETERMINATIONS, RECURRING: C.RECURRING
};
