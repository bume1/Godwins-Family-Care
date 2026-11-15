// ============================================================================
// CHAPTER A · CAREGIVER, EMPLOYED — Onboarding Playbook v3.0, Chapter A
// ============================================================================
// Caregivers already have an onboarding: the WELCOME PACKET (profile, the
// 23-item document checklist, the forms signed in the app, and the office's
// fingerprinting / orientation / app training / skills check). Owner rule:
// nothing is recreated. So Chapter A does not ask for any document the packet
// already collects. Each Playbook item names the packet entries that prove it
// (`packet: [kind, ...]`), and its status is READ from the packet's own
// derived checklist (welcomePacketRepository.buildChecklist). An item is done
// when those entries are done AND any step the packet does not cover is
// recorded: the W-4, the exclusion screening, the qualifying route, the
// records-check determination, the reference calls, the mentor, the reviews.
//
// A packet entry the packet itself marks not required (a licence for someone
// who will not drive, the optional immunization record) does not hold an item
// open.
//
// Classifications are copied from the A.2 table and cite it.
//
// `when` adds two keys:
//   caregiverClass   COMPANION · PCA · NURSING (A.6 qualifying route)
//   fortyHourRoute   a PCA qualifying through GFC's forty-hour program
// ============================================================================

'use strict';

const { ref, SOURCES, PAY_GUIDE } = require('./sources');
const V = require('./vocabulary');
const { ACTORS: A, ACTIONS: X, classification: cls } = V;
const { ACKNOWLEDGMENTS: C_ACKS } = require('./chapterC');

const P = (section) => ref('PLAYBOOK', section);
const A2 = P('A.2');
const step = (actor, action, actorBasis) => Object.freeze({ actor, action, actorBasis });
const STATED = 'STATED';
const INFERRED = 'INFERRED';
const NO_A2_ROW = 'Playbook A.2 carries no row for this item.';

const CHAPTER = Object.freeze({
  id: 'A',
  title: 'Caregiver, Employed',
  ref: P('A'),
  relationship: 'W2',
  appliesTo: 'Companion or sitter, personal care assistant, and licensed nursing under the private home care license',
  // Her own side of onboarding is the welcome packet in the caregiver app.
  usesWelcomePacket: true
});

const PHASES = Object.freeze([
  { id: 'A.4', label: 'Pre-Hire Screening', plainWhen: 'Before your offer',
    title: 'Phase 1 · Pre-Hire Screening', when: 'Before an offer is extended', ref: P('A.4') },
  { id: 'A.5', label: 'Offer & Employment Paperwork', plainWhen: 'When you accept the offer',
    title: 'Phase 2 · Offer and Employment Documentation', when: 'At offer', ref: P('A.5') },
  { id: 'A.6', label: 'Clearance & Qualification', plainWhen: 'Before you are assigned a client',
    title: 'Phase 3 · Clearance and Qualification', when: 'Before assignment to a client', ref: P('A.6') },
  { id: 'A.7', label: 'Orientation & Skills Check', plainWhen: 'Before you work on your own',
    title: 'Phase 4 · Orientation and Competency Evaluation', when: 'Before unsupervised assignment', ref: P('A.7') },
  { id: 'A.8', label: 'First Shifts', plainWhen: 'Your mentor and first-week check-in',
    title: 'Phase 5 · Supervised Assignment', when: 'Initial shifts', ref: P('A.8') },
  { id: 'A.9', label: 'First 90 Days', plainWhen: 'Your 30, 60 and 90 day reviews',
    title: 'Phase 6 · Structured Review Schedule', when: 'Days thirty, sixty and ninety', ref: P('A.9') }
].map((p, n) => Object.freeze(Object.assign({}, p, { number: n + 1 }))));

// A.13. The Handbook, Code of Conduct and HIPAA acknowledgment arrive through
// the packet (items 17-19), so only the three it does not carry are
// acknowledged here.
const shared = (id) => C_ACKS.find(a => a.id === id);
const ACKNOWLEDGMENTS = Object.freeze([
  shared('FIELD_ADDENDUM'),
  Object.freeze({ id: 'PHC_MANUAL', title: 'Private Home Care Policies and Procedures', version: '3.1',
    source: 'PHC_MANUAL', ref: P('A.13'), playbookStates: '3.0',
    versionSetBy: 'The canonical copy in Policies / Current is 3.1 (2026-11-08); owner to confirm',
    driveFileIds: [SOURCES.PHC_MANUAL.driveFileId] }),
  shared('JOB_DESCRIPTION')
]);

const ITEMS = Object.freeze([
  // ---- A.4 · Pre-Hire Screening --------------------------------------------
  { id: 'A.4.01', phase: 'A.4', title: 'Application and structured interview', ref: P('A.4'),
    // The application is her welcome packet profile; its signature authorizes
    // the background investigation (A.4), so that is not collected twice.
    packet: ['background_check_auth'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.RECORD, INFERRED)],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.4.02', phase: 'A.4', title: 'Reference verification', ref: P('A.4'),
    elements: ['Two references contacted directly, including the most recent direct supervisor', 'Date, person contacted and substance of each call'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.VERIFY, INFERRED)],
    classifications: [cls('Internal policy', 'Reference verification before offer', A2)] },
  { id: 'A.4.03', phase: 'A.4', title: 'Employment history verification', ref: P('A.4'),
    steps: [step(A.EXECUTIVE_DIRECTOR, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_A2_ROW },

  // ---- A.5 · Offer and Employment Documentation ----------------------------
  { id: 'A.5.01', phase: 'A.5', title: 'Offer letter and employment agreement', ref: P('A.5'),
    packet: ['offer_letter'],
    steps: [step(A.EXECUTIVE_DIRECTOR, X.EXECUTE, STATED)],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.5.02', guide: PAY_GUIDE, link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.5', title: 'Employment and tax documentation', ref: P('A.5'),
    packet: ['id_document', 'ssn_card', 'work_authorization', 'direct_deposit', 'emergency_contact'],
    // Form I-9 within three business days, and the W-4, which the packet does
    // not collect.
    elements: ['Form I-9 completed within three business days of the start date', 'Form W-4'],
    steps: [step(A.PAYROLL_FINANCE_OFFICER, X.VERIFY, STATED)],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.5.03', phase: 'A.5', title: 'Policy acknowledgments', ref: P('A.5'),
    packet: ['employee_handbook', 'privacy_policy', 'code_of_conduct'],
    acknowledges: ['FIELD_ADDENDUM', 'PHC_MANUAL', 'JOB_DESCRIPTION'],
    steps: [step(A.NEW_HIRE, X.ACKNOWLEDGE, STATED)],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.5.04', link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.5', title: 'Consents and attestations', ref: P('A.5'),
    // The registry attestation is the abuse, neglect and exploitation
    // statement Rule 111-8-65-.09(5)(a)1 requires; the drug testing consent is
    // not in the packet.
    packet: ['registry_attestation', 'mandatory_reporter'],
    elements: ['Drug testing consent'],
    steps: [step(A.NEW_HIRE, X.SIGN, INFERRED)],
    classifications: [cls('Regulatory', 'Abuse, neglect, and exploitation attestation', A2)] },

  // ---- A.6 · Clearance and Qualification -----------------------------------
  { id: 'A.6.01', phase: 'A.6', title: 'Criminal records check', ref: P('A.6'),
    packet: ['fingerprinting'],
    elements: ['Records check initiated through GCHEXS', 'Registered and fingerprinted through GAPS', 'Department of Community Health determination received and filed'],
    steps: [step(A.CREDENTIALING_OWNER, X.RECORD, STATED)],
    classifications: [cls('Statutory and regulatory', 'Criminal records check', A2)] },
  { id: 'A.6.02', phase: 'A.6', title: 'Exclusion and sanction screening', ref: P('A.6'),
    elements: ['OIG List of Excluded Individuals and Entities', 'System for Award Management', 'Georgia Medicaid excluded provider list'],
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [cls('Recommended practice', 'Exclusion screening', A2)] },
  { id: 'A.6.03', link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.6', title: 'Tuberculosis screening', ref: P('A.6'),
    packet: ['tb_test'], steps: [],
    classifications: [cls('Regulatory', 'Tuberculosis screening', A2)] },
  { id: 'A.6.04', link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.6', title: 'Drug screening', ref: P('A.6'),
    packet: ['drug_screen'], steps: [],
    classifications: [cls('Internal policy', 'Drug screening', A2)] },
  { id: 'A.6.05', link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.6', title: 'Driving record and insurance', ref: P('A.6'),
    when: { drives: true },
    packet: ['id_document', 'license_insurance'],
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, INFERRED)],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.6.06', link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.6', title: 'Credentials', ref: P('A.6'),
    packet: ['certification', 'cpr_first_aid'],
    elements: [
      { row: 'Companion or sitter: able to read, write and follow instructions; competency in client needs, meals, transportation, housekeeping, home safety, emergencies and infection control', when: { caregiverClass: 'COMPANION' } },
      { row: 'Personal care assistant: one of the four routes, verified (Georgia Nurse Aide Registry or program records)', when: { caregiverClass: 'PCA' } },
      { row: 'Licensed nursing: current Georgia LPN or RN licensure, verified on Nursys and enrolled in e-Notify', when: { caregiverClass: 'NURSING' } }
    ],
    steps: [step(A.CREDENTIALING_OWNER, X.VERIFY, STATED)],
    classifications: [
      cls('Regulatory', 'Personal care assistant qualification', A2),
      cls('Regulatory', 'Nursing licensure', A2)
    ] },
  { id: 'A.6.07', phase: 'A.6', title: 'Forty-hour training program', ref: P('A.6'),
    when: { fortyHourRoute: true },
    // Taken on Care Courses (owner, 2026-11-09): done when every course in
    // the 40-hour collection has its certificate on file.
    courses: 'PCA_40',
    elements: ['Twenty hours before serving any client', 'Twenty more within six months of the start of training', 'Directing nurse named in the training record'],
    steps: [step(A.SUPERVISOR, X.RECORD, INFERRED)],
    classifications: [cls('Regulatory', 'Forty-hour training program', A2)] },
  { id: 'A.6.08', link: { label: 'Open Welcome Packet', url: '/caregiver#onboarding' }, phase: 'A.6', title: 'Physical ability acknowledgment', ref: null,
    addedBy: 'Welcome packet item 12; Playbook v3.0 Chapter A does not list it.',
    packet: ['physical_ability', 'immunization_record'], steps: [],
    classifications: [], classificationNote: NO_A2_ROW },

  // ---- A.7 · Orientation and Competency Evaluation -------------------------
  { id: 'A.7.01', phase: 'A.7', title: 'Orientation', ref: P('A.7'),
    // Eight hours as GFC policy; the rule sets content, not hours.
    packet: ['orientation'], steps: [],
    classifications: [cls('Regulatory', 'Orientation', A2)] },
  // A.12's HIPAA and dementia modules, taken on Care Courses (owner,
  // 2026-11-09): done when both certificates are on file.
  { id: 'A.7.04', phase: 'A.7', title: 'HIPAA, confidentiality and dementia care modules', ref: P('A.12'),
    courses: 'GFC_CORE', steps: [],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.7.02', phase: 'A.7', title: 'Systems training', ref: P('A.7'),
    packet: ['app_training'], steps: [],
    classifications: [], classificationNote: NO_A2_ROW },
  { id: 'A.7.03', phase: 'A.7', title: 'Competency evaluation', ref: P('A.7'),
    // The skills check is the supervisor's personal observation; the written
    // evaluation signed by the supervisor is the record the rule requires.
    packet: ['skills_check'],
    steps: [step(A.SUPERVISOR, X.OBSERVE, STATED)],
    classifications: [cls('Regulatory', 'Competency evaluation', A2)] },

  // ---- A.8 · Supervised Assignment -----------------------------------------
  { id: 'A.8.01', phase: 'A.8', title: 'Mentor pairing', ref: P('A.8'),
    steps: [step(A.SUPERVISOR, X.RECORD, INFERRED)],
    classifications: [cls('Internal policy', 'Mentor pairing and structured review schedule', A2)] },
  { id: 'A.8.02', phase: 'A.8', title: 'First-week supervisor contact and first-visit debriefing', ref: P('A.8'),
    steps: [step(A.SUPERVISOR, X.RECORD, STATED)],
    classifications: [cls('Internal policy', 'Mentor pairing and structured review schedule', A2)] },

  // ---- A.9 · Structured Review Schedule -------------------------------------
  { id: 'A.9.01', phase: 'A.9', title: 'Day thirty: assignment fit, workload and obstacles', ref: P('A.9'), dueDay: 30,
    steps: [step(A.SUPERVISOR, X.RECORD, STATED)], classifications: [cls('Internal policy', 'Mentor pairing and structured review schedule', A2)] },
  { id: 'A.9.02', phase: 'A.9', title: 'Day sixty: coaching on performance and documentation', ref: P('A.9'), dueDay: 60,
    steps: [step(A.SUPERVISOR, X.RECORD, STATED)], classifications: [cls('Internal policy', 'Mentor pairing and structured review schedule', A2)] },
  { id: 'A.9.03', phase: 'A.9', title: 'Day ninety: performance review and continued assignment', ref: P('A.9'), dueDay: 90,
    steps: [step(A.SUPERVISOR, X.RECORD, STATED), step(A.EXECUTIVE_DIRECTOR, X.RECORD, STATED)],
    classifications: [cls('Internal policy', 'Mentor pairing and structured review schedule', A2)] }
].map(it => Object.freeze(Object.assign({ chapter: 'A' }, it))));

// A.10, as written, with the classification column.
const A10 = P('A.10');
const RECURRING = Object.freeze([
  { id: 'A.10.R1', interval: 'Each pay period', days: 14, owner: [A.PAYROLL_FINANCE_OFFICER],
    requirement: 'Time records submitted and approved in the Godwins Family Care application',
    classification: cls('Internal policy', 'Each pay period', A10) },
  { id: 'A.10.R2', interval: 'Every thirty days', days: 30, owner: [A.CREDENTIALING_OWNER],
    requirement: 'Exclusion verification against the OIG list, SAM and the Georgia Medicaid list; license status monitoring for licensed staff',
    classification: cls('Recommended practice', 'Every thirty days', A10) },
  { id: 'A.10.R3', interval: 'Every ninety-two or one hundred twenty-two days', days: null, event: 'PER_RESIDENCE', owner: [A.SUPERVISOR],
    requirement: 'Supervisory visit per residence: 92 days for personal care tasks, 122 for companion or sitter tasks, from initial service',
    classification: cls('Regulatory', 'Every ninety-two or one hundred twenty-two days', A10) },
  // Completed through the Care Courses annual collection; finishing the
  // year's seven certificates records it done (owner, 2026-11-09).
  { id: 'A.10.R4', interval: 'Annually', days: 365, owner: [A.CLINICAL_DIRECTOR], courses: 'ANNUAL_8',
    requirement: 'Minimum eight clock hours of training, beginning after the first year',
    classification: cls('Regulatory', 'Annually', A10) },
  { id: 'A.10.R5', interval: 'Annually', days: 365, owner: [A.CREDENTIALING_OWNER],
    requirement: 'Tuberculosis screening',
    classification: cls('Regulatory', 'Annually', A10) },
  { id: 'A.10.R6', interval: 'Annually', days: 365, owner: [A.EXECUTIVE_DIRECTOR],
    requirement: 'Policy re-acknowledgment, performance review, and license and certification renewal tracking',
    classification: cls('Internal policy', 'Annually', A10) }
].map(Object.freeze));

module.exports = { CHAPTER, PHASES, ACKNOWLEDGMENTS, ITEMS, SERVICE_LINES: [], DETERMINATIONS: [], RECURRING };
