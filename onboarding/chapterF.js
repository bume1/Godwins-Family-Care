// ============================================================================
// CHAPTER F · NON-CLINICAL, EMPLOYED — transcribed from Onboarding Playbook v3.0
// ============================================================================
// Office, administrative, clinical operations, care coordination and business
// development employees who do not deliver hands-on care (F.1). The admin
// team: administrators, managers and care coordinators (owner, 2026-11-08),
// and the base of a Community Care Liaison's onboarding (Chapter G builds on
// it).
//
// Same rules as chapterC.js: every row cites its Playbook section, titles are
// the Playbook's own headings, classifications are copied from the F.2 table
// and never assigned by us, and an actor the Playbook does not name is marked
// INFERRED for the owner to confirm. F.3 names four roles: the Executive
// Director, the Payroll and Finance Officer, the credentialing owner and the
// Supervisor.
//
// `when` narrows on the hire's inputs (an absent key does not narrow):
//   outOfState           works from a state other than Georgia (F.6)
//   federallyReimbursed  the role supports a federally reimbursed service line
//                        (exclusion screening, F.2)
//   entersResidence      the role involves entering a client residence (the
//                        Field Addendum, F.5)
//   variableComp         a commission or bonus structure (F.8)
// ============================================================================

'use strict';

const { ref } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X, classification: cls } = V;
const { ACKNOWLEDGMENTS: C_ACKS } = require('./chapterC');
const { SOURCES } = require('./sources');
const CS = require('./coordinatorScope');

const P = (section) => ref('PLAYBOOK', section);
const F2 = P('F.2');
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_F2_ROW = 'Playbook F.2 carries no row for this item.';
const OWNER_ITEM = 'Added by the owner for care coordinators (2026-11-09); not a Playbook row.';

const CHAPTER = Object.freeze({
  id: 'F',
  title: 'Non-Clinical, Employed',
  ref: P('F'),
  relationship: 'W2',
  appliesTo: 'Office, administrative, clinical operations, care coordination and business development employees'
});

const PHASES = Object.freeze([
  { id: 'F.4', number: 1, label: 'Pre-Hire Screening', plainWhen: 'Before your offer',
    title: 'Phase 1 · Pre-Hire Screening', when: 'Before an offer is extended', ref: P('F.4') },
  { id: 'F.5', number: 2, label: 'Offer & Employment Paperwork', plainWhen: 'When you accept the offer',
    title: 'Phase 2 · Offer and Employment Documentation', when: 'At offer', ref: P('F.5') },
  { id: 'F.6', number: 3, label: 'Payroll & Time Setup', plainWhen: 'Before your first paid hour',
    title: 'Phase 3 · Work-State Registration', when: 'Before the first compensated hour', ref: P('F.6') },
  { id: 'F.7', number: 4, label: 'Systems & Role Training', plainWhen: 'Your first weeks',
    title: 'Phase 4 · Systems Access and Role Training', when: 'After the background check result', ref: P('F.7') },
  { id: 'F.9', number: 5, label: 'First 90 Days', plainWhen: 'Your 30, 60 and 90 day reviews',
    title: 'Monitoring, Review, and Escalation', when: 'Days thirty, sixty and ninety', ref: P('F.9') }
].map(Object.freeze));

// F.5 and F.10 list the documents. The Administrative and Business Operations
// P&P: F.10 names version 2.0; the owner directed on 2026-11-08 that the admin
// team acknowledges 2.3, the version in Policies / Current. The Playbook's
// figure is kept so the disagreement stays visible until it is corrected.
const shared = (id) => C_ACKS.find(a => a.id === id);
const ACKNOWLEDGMENTS = Object.freeze([
  shared('EMPLOYEE_HANDBOOK'),
  shared('CODE_OF_CONDUCT'),
  shared('HIPAA_ACK'),
  Object.freeze({ id: 'ADMIN_MANUAL', title: 'Administrative and Business Operations Policies and Procedures', version: '2.3',
    source: 'ADMIN_MANUAL', ref: P('F.10'), playbookStates: '2.0', versionSetBy: 'Owner decision, 2026-11-08',
    driveFileIds: [SOURCES.ADMIN_MANUAL.driveFileId] }),
  shared('JOB_DESCRIPTION'),
  shared('FIELD_ADDENDUM')
]);

const ITEMS = Object.freeze([
  // ---- F.4 · Pre-Hire Screening --------------------------------------------
  { id: 'F.4.01', phase: 'F.4', title: 'Application and structured interview', ref: P('F.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.4.02', phase: 'F.4', title: 'Reference and employment history verification', ref: P('F.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.EXECUTIVE_DIRECTOR, X.VERIFY, INFERRED)],
    classifications: [cls('Internal policy', 'Reference verification before offer', F2)] },

  // ---- F.5 · Offer and Employment Documentation ----------------------------
  { id: 'F.5.01', phase: 'F.5', title: 'Offer letter and employment agreement', ref: P('F.5'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, STATED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.5.02', phase: 'F.5', title: 'Wage and hour classification', ref: P('F.2'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED)],
    classifications: [cls('Statutory', 'Wage and hour classification', F2)] },
  { id: 'F.5.03', link: { label: 'Open Pay Setup', url: '/my#hours/pay' }, phase: 'F.5', title: 'Employment and tax documentation', ref: P('F.5'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, STATED), step(A.PAYROLL_FINANCE_OFFICER, X.VERIFY, STATED)],
    elements: ['Form I-9 within three business days of the start date', 'Form W-4', 'Direct deposit authorization', 'Emergency contact information'],
    classifications: [cls('Statutory and regulatory', 'Work authorization', F2)] },
  { id: 'F.5.04', phase: 'F.5', title: 'Background check', ref: P('F.5'),
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, STATED)],
    classifications: [cls('Internal policy', 'Background check', F2)] },
  { id: 'F.5.05', phase: 'F.5', title: 'Policy acknowledgments', ref: P('F.5'),
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    acknowledges: ['EMPLOYEE_HANDBOOK', 'CODE_OF_CONDUCT', 'HIPAA_ACK', 'ADMIN_MANUAL', 'JOB_DESCRIPTION'],
    classifications: [], classificationNote: NO_F2_ROW },
  // F.5: "The Field Addendum applies only where the role involves entering a
  // client residence."
  { id: 'F.5.06', phase: 'F.5', title: 'Field Addendum acknowledgment', ref: P('F.5'), when: { entersResidence: true },
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    acknowledges: ['FIELD_ADDENDUM'],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.5.07', phase: 'F.5', title: 'Exclusion screening at hire', ref: P('F.2'), when: { federallyReimbursed: true },
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [cls('Recommended practice', 'Exclusion screening', F2)] },

  // ---- F.6 · Work-State Registration ---------------------------------------
  { id: 'F.6.01', phase: 'F.6', title: 'Registration in the work state', ref: P('F.6'), when: { outOfState: true },
    steps: [step(A.PAYROLL_FINANCE_OFFICER, X.RECORD, STATED)],
    classifications: [cls('Statutory', 'State employer registration', F2)] },
  { id: 'F.6.02', phase: 'F.6', title: 'Compensation gate', ref: P('F.6'), when: { outOfState: true },
    steps: [step(A.PAYROLL_FINANCE_OFFICER, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.6.03', link: { label: 'Open Time Clock', url: '/my#hours/clock' }, phase: 'F.6', title: 'Time recording', ref: P('F.6'),
    steps: [step(A.PAYROLL_FINANCE_OFFICER, X.PROVISION, STATED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },

  // ---- F.7 · Systems Access and Role Training ------------------------------
  { id: 'F.7.01', phase: 'F.7', title: 'Identity and access', ref: P('F.7'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED)],
    classifications: [cls('Regulatory', 'Privacy and security obligations', F2)] },
  { id: 'F.7.02', phase: 'F.7', title: 'Collateral', ref: P('F.7'),
    steps: [step(A.SUPERVISOR, X.PROVISION, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.7.03', phase: 'F.7', title: 'Role training plan', ref: P('F.7'),
    steps: [step(A.SUPERVISOR, X.RECORD, STATED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.7.04', phase: 'F.7', title: 'Supervised initial work', ref: P('F.7'),
    steps: [step(A.SUPERVISOR, X.OBSERVE, STATED)],
    classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.7.05', phase: 'F.7', title: 'Documentation practice', ref: P('F.7'),
    steps: [step(A.SUPERVISOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_F2_ROW },
  // ---- A care coordinator's clinical scope (owner, 2026-11-09) --------------
  // Not Playbook rows: the owner added them so a coordinator knows which
  // clinician to support with what. The lines are built from the capability
  // list the app enforces (onboarding/coordinatorScope.js), never typed here.
  { id: 'F.CC.01', phase: 'F.7', title: 'Clinical scope: who does what', ref: null, when: { careCoordinator: true },
    elements: CS.scopeLines(),
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED), step(A.CLINICAL_DIRECTOR, X.RECORD, STATED)],
    classifications: [], classificationNote: OWNER_ITEM },
  { id: 'F.CC.02', phase: 'F.7', title: 'What a coordinator does, and never does', ref: null, when: { careCoordinator: true },
    elements: [
      `What you do, for a licensed clinician: ${CS.sentence(CS.coordinatorDoes())}.`,
      `What you never do (a licensed clinician does it): ${CS.sentence(CS.coordinatorNever())}.`,
      'A note you prepare is signed by a licensed clinician. The app says so if you try: "A care coordinator prepares the note. A licensed clinician signs it."',
      'A care plan you write becomes active only when a clinician co-signs it.'
    ],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    classifications: [], classificationNote: OWNER_ITEM },
  { id: 'F.CC.03', phase: 'F.7', title: 'Supporting each clinician, observed', ref: null, when: { careCoordinator: true },
    elements: [
      'A note prepared for a provider, then signed by the provider',
      'A care plan drafted, then co-signed by a clinician',
      'An RN visit with an order placed under a signed standing order',
      'A case manager (LMSW) screening and referral worked through'
    ],
    steps: [step(A.SUPERVISOR, X.OBSERVE, STATED)],
    classifications: [], classificationNote: OWNER_ITEM },
  // F.8, where applicable: counsel review before the first commission is paid.
  { id: 'F.8.01', phase: 'F.7', title: 'Variable compensation plan reviewed by counsel', ref: P('F.8'), when: { variableComp: true },
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: 'Playbook F.8 sets this out as a practice, with no F.2 row.' },

  // ---- F.9 · Monitoring and review -----------------------------------------
  { id: 'F.9.01', phase: 'F.9', title: 'Thirty-day structured review', ref: P('F.9'), dueDay: 30,
    steps: [step(A.SUPERVISOR, X.RECORD, STATED)], classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.9.02', phase: 'F.9', title: 'Sixty-day structured review', ref: P('F.9'), dueDay: 60,
    steps: [step(A.SUPERVISOR, X.RECORD, STATED)], classifications: [], classificationNote: NO_F2_ROW },
  { id: 'F.9.03', phase: 'F.9', title: 'Ninety-day structured review', ref: P('F.9'), dueDay: 90,
    steps: [step(A.SUPERVISOR, X.RECORD, STATED)], classifications: [], classificationNote: NO_F2_ROW }
].map(Object.freeze));

const RECURRING = Object.freeze([
  { id: 'F.9.R1', interval: 'Each pay period', days: 14, owner: [A.PAYROLL_FINANCE_OFFICER],
    requirement: 'Time records submitted and approved; variable compensation reviewed with the employee where applicable',
    classification: null, classificationNote: 'Playbook F.9 carries no classification for this row.' },
  { id: 'F.9.R2', interval: 'Every thirty days', days: 30, owner: [A.CREDENTIALING_OWNER], when: { federallyReimbursed: true },
    requirement: 'Exclusion verification',
    classification: cls('Recommended practice', 'Exclusion screening', F2) },
  { id: 'F.9.R3', interval: 'Annually', days: 365, owner: [A.EXECUTIVE_DIRECTOR, A.SUPERVISOR],
    requirement: 'Policy re-acknowledgment and performance review',
    classification: null, classificationNote: 'Playbook F.9 carries no classification for this row.' }
].map(Object.freeze));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, SERVICE_LINES: [], DETERMINATIONS: [], RECURRING };
