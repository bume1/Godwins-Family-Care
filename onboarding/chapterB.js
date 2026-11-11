// ============================================================================
// CHAPTER B · REGISTERED NURSE, EMPLOYED — transcribed from Onboarding Playbook v3.0
// ============================================================================
// A registered nurse employed on the private home care line: assessment, care
// plans, supervisory visits, caregiver competency evaluation and, where
// assigned, direction of the forty-hour PCA training program (B.1). A nurse
// who is also caregiver team lead is onboarded once under this chapter; team
// lead scope is recorded in the job description (B.1).
//
// Same rules as chapterC.js: every row cites its Playbook section, titles are
// the Playbook's own headings, classifications are copied from the B.2 and
// B.8 tables and never assigned by us, and an actor the Playbook does not
// name is marked INFERRED for the owner to confirm. B.3 names the Executive
// Director, the Clinical Director, the credentialing owner and the Payroll and
// Finance Officer.
//
// `when` narrows on the hire's inputs (an absent key does not narrow):
//   supervisoryDelegation  the Clinical Director delegates supervisory
//                          responsibility to the nurse (B.7)
//   directsTraining        the nurse directs the forty-hour PCA program (B.7)
// ============================================================================

'use strict';

const { ref, SOURCES, PAY_GUIDE } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X, classification: cls } = V;
const { ACKNOWLEDGMENTS: C_ACKS } = require('./chapterC');

const P = (section) => ref('PLAYBOOK', section);
const B2 = P('B.2');
const B8 = P('B.8');
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_B2_ROW = 'Playbook B.2 carries no row for this item.';

const CHAPTER = Object.freeze({
  id: 'B',
  title: 'Registered Nurse, Employed',
  ref: P('B'),
  relationship: 'W2',
  appliesTo: 'Registered nurse on the private home care line, including supervisory and team lead responsibilities'
});

const PHASES = Object.freeze([
  { id: 'B.4', number: 1, label: 'Pre-Hire Screening', plainWhen: 'Before your offer',
    title: 'Phase 1 · Pre-Hire Screening', when: 'Before an offer is extended', ref: P('B.4') },
  { id: 'B.5', number: 2, label: 'Offer & Employment Paperwork', plainWhen: 'When you accept the offer',
    title: 'Phase 2 · Offer and Employment Documentation', when: 'At offer', ref: P('B.5') },
  { id: 'B.6', number: 3, label: 'Clearance & Qualification', plainWhen: 'Before you see clients',
    title: 'Phase 3 · Clearance and Qualification', when: 'Before client contact', ref: P('B.6') },
  { id: 'B.7', number: 4, label: 'Orientation & Responsibilities', plainWhen: 'Your orientation and competency check',
    title: 'Phase 4 · Orientation, Competency, and Assigned Responsibilities', when: 'After clearance', ref: P('B.7') }
].map(Object.freeze));

// B.5 and B.10 list the documents. The Private Home Care P&P: B.10 names
// version 3.0; the canonical copy in Policies / Current is version 3.1, which
// is what is acknowledged, the same way clinicians acknowledge the current
// Clinical P&P (2.2) and the admin team the current Administrative P&P (2.3).
// The Playbook's figure is kept so the disagreement stays visible.
const shared = (id) => C_ACKS.find(a => a.id === id);
const ACKNOWLEDGMENTS = Object.freeze([
  shared('EMPLOYEE_HANDBOOK'),
  shared('CODE_OF_CONDUCT'),
  shared('FIELD_ADDENDUM'),
  shared('HIPAA_ACK'),
  Object.freeze({ id: 'PHC_MANUAL', title: 'Private Home Care Policies and Procedures', version: '3.1',
    source: 'PHC_MANUAL', ref: P('B.10'), playbookStates: '3.0',
    versionSetBy: 'The canonical copy in Policies / Current is 3.1 (2026-11-08); owner to confirm',
    driveFileIds: [SOURCES.PHC_MANUAL.driveFileId] }),
  shared('JOB_DESCRIPTION')
]);

const ITEMS = Object.freeze([
  // ---- B.4 · Pre-Hire Screening --------------------------------------------
  { id: 'B.4.01', phase: 'B.4', title: 'Licensure verification before interview', ref: P('B.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [cls('Regulatory', 'Registered nurse licensure', B2)] },
  { id: 'B.4.02', phase: 'B.4', title: 'Reference verification', ref: P('B.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.EXECUTIVE_DIRECTOR, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_B2_ROW },
  { id: 'B.4.03', phase: 'B.4', title: 'Employment history verification', ref: P('B.4'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.EXECUTIVE_DIRECTOR, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_B2_ROW },

  // ---- B.5 · Offer and Employment Documentation ----------------------------
  { id: 'B.5.01', phase: 'B.5', title: 'Offer letter and employment agreement', ref: P('B.5'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, STATED), step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [], classificationNote: NO_B2_ROW },
  { id: 'B.5.02', guide: PAY_GUIDE, link: { label: 'Open Pay Setup', url: '/my#hours/pay' }, phase: 'B.5', title: 'Employment and tax documentation', ref: P('B.5'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, STATED), step(A.PAYROLL_FINANCE_OFFICER, X.VERIFY, STATED)],
    elements: ['Form I-9 within three business days of the start date', 'Form W-4', 'Direct deposit authorization', 'Emergency contact information'],
    classifications: [], classificationNote: NO_B2_ROW },
  { id: 'B.5.03', phase: 'B.5', title: 'Policy acknowledgments', ref: P('B.5'),
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    acknowledges: ['EMPLOYEE_HANDBOOK', 'CODE_OF_CONDUCT', 'FIELD_ADDENDUM', 'HIPAA_ACK', 'PHC_MANUAL', 'JOB_DESCRIPTION'],
    classifications: [], classificationNote: NO_B2_ROW },

  // ---- B.6 · Clearance and Qualification -----------------------------------
  { id: 'B.6.01', phase: 'B.6', title: 'Primary source licensure verification', ref: P('B.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [cls('Regulatory', 'Registered nurse licensure', B2)] },
  { id: 'B.6.02', phase: 'B.6', title: 'Criminal records check', ref: P('B.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, STATED), step(A.NEW_HIRE, X.COMPLETE, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [cls('Statutory and regulatory', 'Criminal records check', B2)] },
  { id: 'B.6.03', phase: 'B.6', title: 'Exclusion and sanction screening', ref: P('B.6'),
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [cls('Recommended practice', 'Exclusion screening', B2)] },
  { id: 'B.6.04', phase: 'B.6', title: 'Tuberculosis screening', ref: P('B.6'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [cls('Regulatory', 'Tuberculosis screening', B2)] },
  { id: 'B.6.05', phase: 'B.6', title: 'Basic life support certification', ref: P('B.6'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [cls('Internal policy', 'Basic life support certification', B2)] },
  { id: 'B.6.06', phase: 'B.6', title: 'Drug screening', ref: P('B.6'),
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.CREDENTIALING_OWNER, X.RECORD, INFERRED)],
    classifications: [cls('Internal policy', 'Drug screening', B2)] },
  { id: 'B.6.07', phase: 'B.6', title: 'Abuse, neglect, and exploitation attestation', ref: P('B.6'),
    steps: [step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [cls('Regulatory', 'Abuse, neglect, and exploitation attestation', B2)] },

  // ---- B.7 · Orientation, Competency, and Assigned Responsibilities --------
  { id: 'B.7.01', phase: 'B.7', title: 'Clinical orientation', ref: P('B.7'),
    steps: [step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED), step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED)],
    classifications: [], classificationNote: NO_B2_ROW },
  { id: 'B.7.02', phase: 'B.7', title: 'Systems training', ref: P('B.7'),
    steps: [step(A.NEW_HIRE, X.COMPLETE, INFERRED), step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_B2_ROW },
  { id: 'B.7.03', phase: 'B.7', title: 'Competency evaluation', ref: P('B.7'),
    steps: [step(A.CLINICAL_DIRECTOR, X.OBSERVE, INFERRED)],
    classifications: [cls('Regulatory', 'Competency evaluation', B2)] },
  { id: 'B.7.04', phase: 'B.7', title: 'Supervisory responsibilities', ref: P('B.7'), when: { supervisoryDelegation: true },
    steps: [step(A.CLINICAL_DIRECTOR, X.RECORD, STATED)],
    classifications: [cls('Regulatory', 'Supervisor qualification', B2)] },
  { id: 'B.7.05', phase: 'B.7', title: 'Direction of the forty-hour training program', ref: P('B.7'), when: { directsTraining: true },
    steps: [step(A.CLINICAL_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [cls('Regulatory', 'Direction of the forty-hour training program', B2)] }
].map(Object.freeze));

// B.8, with its own classification column.
const RECURRING = Object.freeze([
  { id: 'B.8.R1', interval: 'Each pay period', days: 14, owner: [A.PAYROLL_FINANCE_OFFICER],
    requirement: 'Time records submitted and approved in the Godwins Family Care application',
    classification: cls('Internal policy', 'Each pay period', B8) },
  { id: 'B.8.R2', interval: 'Every thirty days', days: 30, owner: [A.CREDENTIALING_OWNER],
    requirement: 'Exclusion verification and license status monitoring through Nursys e-Notify',
    classification: cls('Recommended practice', 'Every thirty days', B8) },
  // Per residence, at the interval its task category sets: counted from each
  // client's initial service, not from the nurse's start date, so it reads
  // "when it happens" here and is tracked on the client.
  { id: 'B.8.R3', interval: 'Every ninety-two or one hundred twenty-two days', days: null, event: 'PER_RESIDENCE',
    owner: [A.CLINICAL_DIRECTOR], when: { supervisoryDelegation: true },
    requirement: 'Supervisory visits at the interval set by the task category in each residence',
    classification: cls('Regulatory', 'Every ninety-two or one hundred twenty-two days', B8) },
  { id: 'B.8.R4', interval: 'Annually', days: 365, owner: [A.CLINICAL_DIRECTOR, A.EXECUTIVE_DIRECTOR],
    requirement: 'Minimum eight clock hours of training after the first year, tuberculosis screening, competency re-evaluation, licensure and certification renewal tracking, policy re-acknowledgment, and performance review',
    classification: cls('Regulatory and internal policy', 'Annually', B8) }
].map(Object.freeze));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, SERVICE_LINES: [], DETERMINATIONS: [], RECURRING };
