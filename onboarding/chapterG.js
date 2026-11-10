// ============================================================================
// CHAPTER G · COMMUNITY CARE LIAISON — Onboarding Playbook v3.0, Chapter G
// ============================================================================
// A remote, employed (W-2) business development role. G's opening line:
// "Chapter F governs screening, documentation, and work-state registration;
// this chapter covers what is specific to the role." So:
//
//   * F.4, F.5 and F.6 are Chapter F's own items, unchanged (the same objects).
//   * G.2 replaces F.7: systems provisioning is the G.2 table, row by row,
//     plus the collateral it lists and the Liaison Playbook issued with it.
//   * G.3: six to twelve pre-approved hours, availability two weeks ahead.
//   * G.4 replaces F.9's generic reviews with its own three review points,
//     verified by the supervisor; the Executive Director delivers training.
//   * G.5: the F.8 variable-compensation conditions apply IN FULL, so the
//     counsel-review item is always on (F gates it on `variableComp`).
//   * G.6: the escalation table, acknowledged.
//
// The liaison does not deliver care, assess or give clinical guidance (G.1).
// Nothing here gives the role a clinical step.
// ============================================================================

'use strict';

const { ref, SOURCES } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X } = V;
const F = require('./chapterF');

const P = (section) => ref('PLAYBOOK', section);
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_CLASS = 'Chapter G carries no classification table.';
const fItem = (id) => F.ITEMS.find(x => x.id === id);

const CHAPTER = Object.freeze({
  id: 'G',
  title: 'Community Care Liaison',
  ref: P('G'),
  relationship: 'W2',
  appliesTo: 'Remote business development employee: referral relationships and initial family consultations'
});

const PHASES = Object.freeze([
  F.PHASES.find(p => p.id === 'F.4'),
  F.PHASES.find(p => p.id === 'F.5'),
  F.PHASES.find(p => p.id === 'F.6'),
  { id: 'G.2', label: 'Systems & Materials', plainWhen: 'Before your first prospect call',
    title: 'Systems Provisioning', when: 'At provisioning', ref: P('G.2') },
  { id: 'G.4', label: 'First 90 Days', plainWhen: 'Your 30, 60 and 90 day review points',
    title: 'Training Delivery and Review Points', when: 'Days thirty, sixty and ninety', ref: P('G.4') }
].map((p, n) => Object.freeze(Object.assign({}, p, { number: n + 1 }))));

// G.7: the Chapter F set, the employment agreement and compensation schedule,
// the Liaison Playbook and the Training Plan. No canonical Training Plan is in
// Drive yet, so the office files the copy for the hire.
const ACKNOWLEDGMENTS = Object.freeze(F.ACKNOWLEDGMENTS.concat([
  Object.freeze({ id: 'LIAISON_PLAYBOOK', title: 'Community Care Liaison Playbook', version: '2.5',
    source: 'LIAISON_PLAYBOOK', ref: P('G.7'), driveFileIds: [SOURCES.LIAISON_PLAYBOOK.driveFileId] }),
  Object.freeze({ id: 'LIAISON_TRAINING_PLAN', title: 'Community Care Liaison Training Plan', version: 'Current',
    ref: P('G.7'), driveFileIds: [] })
]));

const OWN = [
  // ---- G.2 · Systems Provisioning ------------------------------------------
  { id: 'G.2.01', phase: 'G.2', title: 'Google Workspace account and signature block', ref: P('G.2'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)] },
  { id: 'G.2.02', phase: 'G.2', title: 'Main line extension, tested both directions', ref: P('G.2'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)] },
  { id: 'G.2.03', phase: 'G.2', title: 'Sales portal access', ref: P('G.2'),
    elements: ['Call scripts', 'Compensation schedule', 'Targeting map', 'Credentials are not shared; materials stay inside the organization'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED), step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED)] },
  { id: 'G.2.04', phase: 'G.2', title: 'System of record for partners, contacts, pipeline and tasks', ref: P('G.2'),
    // Activity not recorded there cannot count toward variable compensation.
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED), step(A.NEW_HIRE, X.COMPLETE, INFERRED)] },
  { id: 'G.2.05', phase: 'G.2', title: 'Approved collateral issued', ref: P('G.2'),
    elements: ['Facility brochure', 'Continuous Care Program flyer', 'Records release', 'Service differentiation explainer'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.PROVISION, INFERRED)] },
  { id: 'G.2.06', phase: 'G.2', title: 'Liaison Playbook and Training Plan issued', ref: P('G.1'),
    acknowledges: ['LIAISON_PLAYBOOK', 'LIAISON_TRAINING_PLAN'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED)] },
  { id: 'G.3.01', link: { label: 'Open Availability', url: '/my#hours/availability' }, phase: 'G.2', title: 'Availability submitted and approved hours set', ref: P('G.3'),
    elements: ['Six to twelve pre-approved hours a week', 'Availability submitted at least two weeks ahead',
      'Two more approved hours a week for each client placed on service, up to twelve', 'Hours recorded in the app at the time worked'],
    steps: [step(A.NEW_HIRE, X.SUBMIT, INFERRED), step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)] },
  // G.5: F.8 applies in full, so the counsel review is never optional here.
  { id: 'G.5.01', phase: 'G.2', title: 'Compensation schedule, with the plan reviewed by counsel before the first commission', ref: P('G.5'),
    steps: fItem('F.8.01').steps },
  { id: 'G.6.01', phase: 'G.2', title: 'Escalation pathways', ref: P('G.6'),
    elements: ['On-site activity from a booked meeting: Executive Director',
      'Clinical question from a family or facility: Clinical Director (the liaison gives no clinical guidance)',
      'Service concern from an existing account: Executive Director',
      'Suspected privacy or security incident: Executive Director, immediately'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, INFERRED)] },

  // ---- G.4 · Review points (verified by the supervisor) --------------------
  { id: 'G.4.01', phase: 'G.4', title: 'Days one to thirty', ref: P('G.4'), dueDay: 30,
    elements: ['All systems provisioned and tested', 'Documents executed', 'Availability submitted', 'Portal training delivered',
      'Same-day activity recording established', 'Initial meetings scheduled with facility decision-makers'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED), step(A.SUPERVISOR, X.VERIFY, STATED)] },
  { id: 'G.4.02', phase: 'G.4', title: 'Days thirty-one to sixty', ref: P('G.4'), dueDay: 60,
    elements: ['Pipeline training delivered', 'Stages and follow-up tasks managed without prompting',
      'Demonstrations and facility education sessions delivered with the Georgia team', 'Initial family consultations conducted'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED), step(A.SUPERVISOR, X.VERIFY, STATED)] },
  { id: 'G.4.03', phase: 'G.4', title: 'Days sixty-one to ninety', ref: P('G.4'), dueDay: 90,
    elements: ['Prospecting cadence, pipeline stages and activity recording operating without supervision',
      'Accounts correctly attributed', 'Each active account meeting the documented activity standard'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED), step(A.SUPERVISOR, X.VERIFY, STATED)] }
].map(it => Object.freeze(Object.assign({ chapter: 'G', classifications: [], classificationNote: NO_CLASS }, it)));

const ITEMS = Object.freeze(
  F.ITEMS.filter(it => ['F.4', 'F.5', 'F.6'].includes(it.phase)).concat(OWN)
);

// G.4: weekly check-ins on the Liaison Playbook's fixed agenda; F.9's pay
// period and annual rows still apply; G.5 reviews commission each period.
const RECURRING = Object.freeze(F.RECURRING.concat([
  Object.freeze({ id: 'G.4.R1', interval: 'Weekly', days: 7, owner: [A.SUPERVISOR],
    requirement: 'Weekly check-in on the fixed agenda in the Community Care Liaison Playbook',
    classification: null, classificationNote: NO_CLASS }),
  Object.freeze({ id: 'G.5.R1', interval: 'Each pay period', days: 14, owner: [A.PAYROLL_FINANCE_OFFICER],
    requirement: 'Commission calculated from recorded system activity and submitted time, and reviewed with the liaison',
    classification: null, classificationNote: NO_CLASS })
]));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, OWN_ITEMS: OWN, SERVICE_LINES: [], DETERMINATIONS: [], RECURRING };
