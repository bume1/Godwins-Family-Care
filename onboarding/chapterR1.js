// ============================================================================
// SUPERVISING PHYSICIAN — Onboarding Playbook v3.0, Reference R1 (GEORGIA)
// ============================================================================
// Engaging a delegating physician, structured as an independent contractor
// (R1.1), and the recurring review obligations the engagement carries (R1.3).
// GEORGIA ONLY (owner, 2026-11-09): R1.4's North Carolina and Alabama
// summaries are unverified in the Playbook itself and are not built.
//
// The subject of this track is the physician, so the physician's own steps
// use the NEW_HIRE actor. R1.3 carries statutory and rule citations but no
// classification column, so no item carries a classification and each says
// so; nothing is assigned here.
//
// R1.1: compensation set below fair market value for the review work creates
// self-referral and anti-kickback exposure where the physician also refers,
// so the basis for the rate is documented as its own item.
// ============================================================================

'use strict';

const { ref } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X } = V;

const P = (section) => ref('PLAYBOOK', section);
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_CLASS = 'Reference R1.3 cites statute and rule but carries no classification column.';

// Georgia: no more than the combined equivalent of eight APRNs or PAs at once
// (O.C.G.A. § 43-34-25(g)).
const GA_DELEGATION_LIMIT = 8;

const CHAPTER = Object.freeze({
  id: 'R1',
  title: 'Supervising Physician (Georgia)',
  ref: P('R1'),
  relationship: '1099',
  state: 'GA',
  appliesTo: 'A delegating physician for GFC clinicians practicing under delegated medical authority in Georgia'
});

const PHASES = Object.freeze([
  { id: 'R1.2a', label: 'Verify & Engage', plainWhen: 'Before any agreement is signed',
    title: 'Engagement Sequence, steps 1 to 3', when: 'Before execution', ref: P('R1.2') },
  { id: 'R1.2b', label: 'Agreements & Filing', plainWhen: 'One agreement per clinician',
    title: 'Engagement Sequence, steps 4 to 6', when: 'At execution', ref: P('R1.2') }
].map((p, n) => Object.freeze(Object.assign({}, p, { number: n + 1 }))));

const ACKNOWLEDGMENTS = Object.freeze([]);

const ITEMS = Object.freeze([
  // ---- R1.2 steps 1-3 ---------------------------------------------------------
  { id: 'R1.2.01', phase: 'R1.2a', title: 'Physician verified', ref: P('R1.2'),
    elements: ['Current unrestricted Georgia licensure', 'Board certification', 'Controlled substance registration',
      'Current malpractice coverage', 'National Practitioner Data Bank', 'OIG exclusion list', 'System for Award Management',
      'State board disciplinary records', "Specialty comparable to each clinician's scope"],
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'R1.1.01', phase: 'R1.2a', title: 'Physician agreement, with fair market value compensation documented', ref: P('R1.1'),
    elements: ['Independent contractor agreement', 'Compensation reflects the recurring review work', 'The basis for the rate is written down'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, INFERRED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'R1.2.02', phase: 'R1.2a', title: 'Remaining delegation capacity confirmed', ref: P('R1.3'),
    elements: [`No more than the combined equivalent of ${GA_DELEGATION_LIMIT} APRNs or PAs at once`,
      'Physician assistants under the same physician use the same capacity', "Count the physician's existing agreements, with every organization, before each new one"],
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'R1.2.03', phase: 'R1.2a', title: 'Designated alternate physician', ref: P('R1.2'),
    elements: ['In writing, attached to the agreement', 'Same scope of practice',
      'Serves up to sixty days if the delegating physician leaves; without one, prescriptive authority stops'],
    steps: [step(A.NEW_HIRE, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },

  // ---- R1.2 steps 4-6 ---------------------------------------------------------
  { id: 'R1.2.04', phase: 'R1.2b', title: 'Nurse protocol agreements executed and filed, one per clinician', ref: P('R1.2'),
    elements: ['Delegated medical acts', 'Scope of prescriptive authority', 'Practice locations',
      'Filed by the physician with the Georgia Composite Medical Board', 'The clinician does not prescribe until it is in force',
      'Controlled substances: Schedules III to V only, with the narrow emergency exception for hydrocodone or oxycodone'],
    steps: [step(A.NEW_HIRE, X.EXECUTE, STATED), step(A.NEW_HIRE, X.RECORD, STATED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'R1.2.05', phase: 'R1.2b', title: 'Recurring review obligations scheduled', ref: P('R1.2'),
    // "These obligations lapse without producing an alert": the recurring
    // rows below are that schedule, each with its owner.
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_CLASS },
  { id: 'R1.2.06', phase: 'R1.2b', title: 'Retention and exit arrangements', ref: P('R1.2'),
    elements: ['Agreements and every review record retained', 'Board notice within ten working days of termination',
      "Arrangements on the physician's departure"],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_CLASS }
].map(it => Object.freeze(Object.assign({ chapter: 'R1' }, it))));

// R1.3, the recurring obligations, each with its citation in the text.
const RECURRING = Object.freeze([
  { id: 'R1.3.R1', interval: 'Quarterly', days: 90, owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Review and sign 100% of records for patients receiving controlled substance prescriptions (Rule 360-32-.02(7)(a)1)',
    classification: null, classificationNote: NO_CLASS },
  { id: 'R1.3.R2', interval: 'Quarterly', days: 90, owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Evaluate patients receiving controlled substance orders (O.C.G.A. § 43-34-25(c)(9); Rule 360-32-.02(5)(d))',
    classification: null, classificationNote: NO_CLASS },
  { id: 'R1.3.R3', interval: 'Within thirty days of discovery', days: null, event: 'ADVERSE_OUTCOME', owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Review 100% of records in which an adverse outcome occurred (Rule 360-32-.02(7)(a)2)',
    classification: null, classificationNote: NO_CLASS },
  { id: 'R1.3.R4', interval: 'Annually', days: 365, owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Review 10% of all other patient records (Rule 360-32-.02(7)(a)3)',
    classification: null, classificationNote: NO_CLASS },
  { id: 'R1.3.R5', interval: 'Annually', days: 365, owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'On-site observation of each clinician (Rule 360-32-.05(2))',
    classification: null, classificationNote: NO_CLASS },
  { id: 'R1.3.R6', interval: 'Annually', days: 365, owner: [A.DELEGATING_PHYSICIAN, A.EXECUTIVE_DIRECTOR],
    requirement: 'Review, revise or update each agreement with the clinician (O.C.G.A. § 43-34-25(c)(7); Rule 360-32-.02(11))',
    classification: null, classificationNote: NO_CLASS },
  { id: 'R1.3.R7', interval: 'Within ten working days of termination', days: null, event: 'TERMINATION', owner: [A.DELEGATING_PHYSICIAN],
    requirement: 'Notify the Board of a terminated agreement (Rule 360-32-.05(5))',
    classification: null, classificationNote: NO_CLASS }
].map(Object.freeze));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, SERVICE_LINES: [], DETERMINATIONS: [], RECURRING, GA_DELEGATION_LIMIT };
