// ============================================================================
// CLINICIAN TRAINING MODULES — Training Library GFC-CLIN-TRN v1.2, Chapter C
// ============================================================================
// One record per module in the Library's §3 module map, in its schema (§2).
// Module identifiers are NEVER renumbered; a module whose procedure changes
// gets a version bump, which re-checks anyone who already completed it.
//
// The record holds REFERENCES. Instruction, check questions and answers are
// read from the Library (for module-specific checks, e.g. TRN-008) or from
// the SOP the module teaches (SOP Set 1, "Check questions"), never copied in.
//
// MANUAL REFERENCES. The Library lists manual sections for TRN-008, 205, 206,
// 207 and 208 only. For modules the SOP Set 1 table maps to a procedure, the
// manual sections come from that table and are marked `derivedFromSop`. A
// module with neither carries PROPOSED references (from SOP Set 2's planned
// table, or drafted for the Clinical Director) and reads PENDING until they
// are confirmed, rather than quietly clearing.
//
// SOURCE CLASS. Taken from the Library where the Library states one. Where it
// does not, `sourceClass` is null; it is never assigned here.
// ============================================================================

'use strict';

const { ref } = require('./sources');
const V = require('./vocabulary');

const L = (section) => ref('TRAINING_LIBRARY', section);
const M = (section) => ref('CLINICAL_MANUAL', section);

// Host roles (Library §2: role names only, mapped to people in settings).
const HOSTS = Object.freeze({
  EXECUTIVE_DIRECTOR: 'EXECUTIVE_DIRECTOR',
  CLINICAL_DIRECTOR: 'CLINICAL_DIRECTOR',
  CLINICAL_OPS_COORDINATOR: 'CLINICAL_OPS_COORDINATOR',
  SELF_PACED: 'SELF_PACED',
  SYSTEM: 'SYSTEM'
});

// SOP Set 1 v1.2, the procedure-to-manual table. Two SOP headings list more
// than the table does; where they differ the heading's list is used, because
// it is the procedure's own statement of its authority.
const SOP_MANUAL_REFS = Object.freeze({
  'SOP-SYS-01': ['3', '10.7-10.10', '21'],
  'SOP-ESC-01': ['2.5', '2.8', '18'],
  'SOP-VIS-01': ['8', '16', '17'],
  'SOP-DOC-01': ['8.5', '9', '10.9'],
  'SOP-ORD-01': ['11.1-11.4'],
  'SOP-ORD-02': ['11.5-11.7'],
  'SOP-RX-01': ['2.5', '12'],      // table: 12; heading: 2.5, 12
  'SOP-EXM-01': ['14', '23.5']
});

// SOP Set 1 v1.2, "Set 2 · Planned": procedures scheduled but not yet
// written, with the manual sections each will be built from. A module these
// map to has a PROPOSED manual reference and a procedure still to write.
const SOP_PLANNED = Object.freeze({
  'SOP-PAT-01': { manual: ['6'], module: 'TRN-201' },
  'SOP-TH-01': { manual: ['7.3'], module: 'TRN-218' },
  'SOP-BH-01': { manual: ['15'], module: 'TRN-211' },
  'SOP-BH-02': { manual: ['15', '8.5'], module: 'TRN-212' },
  'SOP-CM-01': { manual: ['13'], module: 'TRN-213' },
  'SOP-TOC-01': { manual: ['20.3'], module: 'TRN-214' },
  'SOP-BIL-01': { manual: ['23'], module: 'TRN-215' },
  'SOP-RPT-01': { manual: ['19'], module: 'TRN-216' },
  'SOP-INC-01': { manual: ['24'], module: 'TRN-217' },
  'SOP-EMR-01': { manual: ['18.1'], module: 'TRN-210' }
});

// DRAFT manual references for modules the Library and both SOP tables leave
// unmapped (owner, 2026-11-08: draft them for the Clinical Director). These
// are OUR reading of the manual's contents and do not drive the version flag
// until confirmed; the module reads PENDING until then. An empty list means
// the module is a review meeting that teaches no manual content, which the
// Clinical Director confirms the same way.
const DRAFT_MANUAL_REFS = Object.freeze({
  'TRN-102': ['14'], 'TRN-103': ['14'], 'TRN-106': ['14.5'],
  'TRN-001': ['1', '2.1-2.4'], 'TRN-002': ['2'], 'TRN-004': ['3'], 'TRN-007': ['8'],
  'TRN-204': ['16.3-16.5'], 'TRN-219': ['8', '27.2'], 'TRN-220': ['11.3', '27.4'],
  'TRN-301': ['2.5', '4'], 'TRN-302': ['27.2'], 'TRN-303': ['9', '24.4'], 'TRN-304': ['27.2'],
  'TRN-401': [], 'TRN-402': [], 'TRN-403': [], 'TRN-404': [], 'TRN-405': []
});

const H = HOSTS;
const S = V.SIGNOFF;

// Fields in the order of Library §2. `manualRefs` are exactly what the
// Library lists; `sopRefs` likewise.
const MODULES_RAW = [
  // §3.1 Credentialing and Compliance Activation, exams lane (C.6)
  { id: 'TRN-102', title: 'Veterans disability examination training', phase: 'C.6', stage: 'EXAMS', lanes: ['EXAMS'], format: 'EXTERNAL', minutes: 1200, host: H.SELF_PACED, signoff: S.CERTIFICATE, requiredFor: ['determination:IME'] },
  { id: 'TRN-103', title: "Contracting organization's required training", phase: 'C.6', stage: 'EXAMS', lanes: ['EXAMS'], format: 'EXTERNAL', minutes: null, host: H.SELF_PACED, signoff: S.CERTIFICATE, requiredFor: ['determination:IME'] },
  { id: 'TRN-104', title: 'GFC examination workflow: scheduling, check-in, templates, report turnaround, quality review, restricted access', phase: 'C.6', stage: 'EXAMS', lanes: ['EXAMS'], format: 'LIVE', minutes: 120, host: H.EXECUTIVE_DIRECTOR, signoff: S.OBSERVED, requiredFor: ['determination:IME'], sopRefs: ['SOP-EXM-01'] },
  { id: 'TRN-105', title: 'Emergent findings during an examination', phase: 'C.6', stage: 'EXAMS', lanes: ['EXAMS'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['determination:IME'], sopRefs: ['SOP-EXM-01'] },
  // TRN-106 is required for "Focused review", which is not one of §2.3's
  // three value forms. Kept as the Library states it and reported as a gap.
  { id: 'TRN-106', title: 'First examination reports reviewed, first five', phase: 'C.6', stage: 'EXAMS', lanes: ['EXAMS'], format: 'OBSERVED', minutes: null, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: [], requiredForUnparsed: 'Focused review' },

  // §3.2 Systems Access and Clinical Orientation, orientation stage (C.7)
  { id: 'TRN-001', title: 'GFC: the organization, the service lines, and who holds which responsibility', phase: 'C.7', stage: 'WELCOME', format: 'VIDEO', minutes: 15, host: H.EXECUTIVE_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.7'] },
  { id: 'TRN-002', title: 'Role card: assigned responsibilities, boundaries of the role, escalation contacts, and the expected weekly pattern', phase: 'C.7', stage: 'WELCOME', format: 'READ', minutes: 10, host: H.EXECUTIVE_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.7'] },
  { id: 'TRN-003', title: 'Systems: the GFC app, electronic prescribing, faxing, Google Workspace, telephone lines, and team chat standards', phase: 'C.7', stage: 'WELCOME', format: 'VIDEO', minutes: 15, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.ATTEST, requiredFor: ['phase:C.7'], sopRefs: ['SOP-SYS-01'] },
  { id: 'TRN-004', title: 'The GFC app: signing in, onboarding, hours and pay, scheduling and availability', phase: 'C.7', stage: 'WELCOME', format: 'IN_APP', minutes: 10, host: H.SYSTEM, signoff: S.NONE, requiredFor: ['phase:C.7'] },
  { id: 'TRN-005', title: 'Privacy and security in the residence and in GFC systems', phase: 'C.7', stage: 'WELCOME', format: 'VIDEO', minutes: 15, host: H.EXECUTIVE_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.7'], sopRefs: ['SOP-SYS-01'] },
  { id: 'TRN-006', title: 'Clinical Policies and Procedures Manual: read, attest, and apply to scenarios', phase: 'C.7', stage: 'WELCOME', format: 'READ', minutes: 60, host: H.CLINICAL_DIRECTOR, signoff: S.COUNTERSIGN, requiredFor: ['phase:C.8'], wholeManual: true },
  { id: 'TRN-007', title: 'Home-based clinical care procedure', phase: 'C.7', stage: 'WELCOME', format: 'READ', minutes: 20, host: H.CLINICAL_DIRECTOR, signoff: S.COUNTERSIGN, requiredFor: ['phase:C.7'] },
  { id: 'TRN-008', title: 'Artificial intelligence: what is permitted, what is not, and how it is attested', phase: 'C.7', stage: 'WELCOME', format: 'VIDEO', minutes: 12, host: H.EXECUTIVE_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.7'],
    manualRefs: ['10.7', '10.8', '10.9', '10.10'], sopRefs: ['SOP-SYS-01'], unlocksAfter: ['TRN-003', 'TRN-005'],
    sourceClass: { libraryStates: 'REGULATORY', classes: ['REGULATORY'] }, checksFrom: L('TRN-008') },

  // Owner additions, 2026-11-10 (Training Material Tracker). A module with an
  // `audience` reaches only those account types, in each one's own training
  // phase (libraryTrainings.TRAINING_PHASE), and is required there.
  { id: 'TRN-009', title: 'KaiCare Ai: the care management platform and what GFC logs there', phase: 'C.7', stage: 'WELCOME', format: 'VIDEO', minutes: 12, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.ATTEST, requiredFor: [],
    manualRefs: ['3.4', '13.3', '13.7'], audience: ['provider', 'rn', 'lcsw', 'lmsw', 'coordinator'] },
  { id: 'TRN-501', title: 'Accepting shifts and clocking in', phase: 'A.7', stage: 'CAREGIVER', format: 'VIDEO', minutes: null, host: H.SELF_PACED, signoff: S.ATTEST, requiredFor: [], audience: ['caregiver'] },
  { id: 'TRN-502', title: 'Submitting the visit report and clocking out', phase: 'A.7', stage: 'CAREGIVER', format: 'VIDEO', minutes: null, host: H.SELF_PACED, signoff: S.ATTEST, requiredFor: [], audience: ['caregiver'] },
  { id: 'TRN-503', title: 'Onboarding documents for home care staff', phase: 'A.7', stage: 'CAREGIVER', format: 'VIDEO', minutes: null, host: H.SELF_PACED, signoff: S.ATTEST, requiredFor: [], audience: ['caregiver'] },

  // §3.3 Systems Access and Clinical Orientation, clinical preparation stage (C.7)
  { id: 'TRN-201', title: 'Referral to first visit: acceptance, intake, consents, and the first-visit standard', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 15, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'] },
  { id: 'TRN-202', title: 'Visit day: itinerary, check-in and check-out, field safety, and leaving a visit', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 15, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'], sopRefs: ['SOP-VIS-01'] },
  { id: 'TRN-203', title: 'Infection prevention and bag technique', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO + OBSERVED', minutes: 20, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: ['phase:C.8'], sopRefs: ['SOP-VIS-01'] },
  { id: 'TRN-204', title: 'Bloodborne pathogens', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'EXTERNAL', minutes: 60, host: H.SELF_PACED, signoff: S.CERTIFICATE, requiredFor: ['phase:C.8'] },
  { id: 'TRN-205', title: 'Documentation: note types, required sections, signature standard, corrections, and attestation of assisted content', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 18, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'],
    manualRefs: ['8.5', '9', '10.9'], sopRefs: ['SOP-DOC-01'],
    sourceClass: { libraryStates: 'INTERNAL_POLICY for the signature interval, REGULATORY for record integrity', classes: ['INTERNAL_POLICY', 'REGULATORY'] },
    checksFrom: L('TRN-205') },
  { id: 'TRN-206', title: 'Orders and results: order entry, faxed requisitions, the results inbox, loop closure, and critical values', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 15, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'],
    manualRefs: ['11.1-11.7'], sopRefs: ['SOP-ORD-01', 'SOP-ORD-02'],
    sourceClass: { libraryStates: 'REGULATORY', classes: ['REGULATORY'] }, checksFrom: L('TRN-206') },
  { id: 'TRN-207', title: 'Prescribing and refills: scope, electronic prescribing, and refill standards', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 15, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'],
    manualRefs: ['12.1', '12.2', '12.4'], sopRefs: ['SOP-RX-01'],
    // "Mixed. See below": the Library splits the statutory refill ceiling
    // from GFC's three-month policy. The components cite the Manual's §1.6.
    sourceClass: { libraryStates: 'Mixed', components: [
      V.classification('Statutory and regulatory', 'Refills limited to twelve months from the original order', M('1.6')),
      V.classification('Internal policy', 'Refills limited to three months from the original order', M('1.6'))
    ] }, checksFrom: L('TRN-207') },
  { id: 'TRN-208', title: 'Controlled substances: monitoring program, the Schedule II boundary, and treatment agreements', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 14, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['determination:PRIVATE_PAY', 'determination:BEHAVIORAL'],
    manualRefs: ['12.3', '10.7'], sopRefs: ['SOP-RX-01'],
    sourceClass: { libraryStates: 'Mixed', components: [
      V.classification('Statutory and regulatory', 'Prohibition on APRN prescribing of Schedule I and II, subject to the emergency exception', M('1.6')),
      V.classification('Internal policy', 'Routing of Schedule II matters to the supervising physician rather than relying on the emergency exception', M('1.6'))
    ] }, checksFrom: L('TRN-208') },
  { id: 'TRN-209', title: 'Escalation: physician consultation, the urgent clinical line, and change in condition', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'], sopRefs: ['SOP-ESC-01'] },
  { id: 'TRN-210', title: 'Medical emergencies in the residence', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'] },
  { id: 'TRN-211', title: 'Psychiatric risk assessment, safety planning, and crisis response', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], credentials: ['PMHNP'], format: 'VIDEO', minutes: 20, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['determination:BEHAVIORAL'] },
  { id: 'TRN-212', title: 'Psychiatric visit workflow and note set', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], credentials: ['PMHNP'], format: 'VIDEO', minutes: 15, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['determination:BEHAVIORAL'] },
  { id: 'TRN-213', title: 'Continuous Care Management Program: consent, assigned responsibilities, and time logging', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 15, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'] },
  { id: 'TRN-214', title: 'Transitions of care: discharge follow-up and medication reconciliation', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'] },
  { id: 'TRN-215', title: 'Coding and billing integrity', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 15, host: H.EXECUTIVE_DIRECTOR, signoff: S.ATTEST, requiredFor: ['determination:INSURED'] },
  { id: 'TRN-216', title: 'Mandatory reporting', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'] },
  { id: 'TRN-217', title: 'Incidents and near misses', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['phase:C.8'] },
  { id: 'TRN-218', title: 'Telehealth visits', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'VIDEO', minutes: 10, host: H.CLINICAL_DIRECTOR, signoff: S.ATTEST, requiredFor: ['privilege:TELEHEALTH'] },
  { id: 'TRN-219', title: 'Shadow home visits, two to three visits, observation only', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'SHADOW', minutes: null, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: ['phase:C.8'] },
  { id: 'TRN-220', title: 'Point-of-care testing and home equipment competency', phase: 'C.7', stage: 'CLINICAL_PREP', lanes: ['CLINICAL'], format: 'OBSERVED', minutes: 30, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: ['phase:C.8'] },

  // §3.4 Readiness Determination (C.8)
  { id: 'TRN-301', title: 'Live clinical session: protocol judgment applied to an actual chart', phase: 'C.8', stage: 'GO_LIVE', lanes: ['CLINICAL'], format: 'LIVE', minutes: 120, host: H.EXECUTIVE_DIRECTOR, coHost: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: [] }, // ED hosts, CD leads
  { id: 'TRN-302', title: 'Paired first visits with same-day debriefing', phase: 'C.8', stage: 'GO_LIVE', lanes: ['CLINICAL'], format: 'OBSERVED', minutes: null, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: [] },
  { id: 'TRN-303', title: 'Record review on every early encounter, first 30 days or first 10 per new privilege', phase: 'C.8', stage: 'GO_LIVE', lanes: ['CLINICAL'], format: 'OBSERVED', minutes: null, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: [] },
  { id: 'TRN-304', title: 'Workflow sign-offs: each hands-on workflow marked independent', phase: 'C.8', stage: 'GO_LIVE', lanes: ['CLINICAL'], format: 'OBSERVED', minutes: null, host: H.CLINICAL_DIRECTOR, signoff: S.OBSERVED, requiredFor: [] },

  // §3.5 Supervised Practice and Ongoing Monitoring (C.9)
  { id: 'TRN-401', title: 'First-week review', phase: 'C.9', stage: 'FIRST_90', format: 'LIVE', minutes: null, host: H.EXECUTIVE_DIRECTOR, signoff: S.NONE, requiredFor: [], dueDay: 5 },
  { id: 'TRN-402', title: 'Review every two weeks, 30 minutes', phase: 'C.9', stage: 'FIRST_90', format: 'LIVE', minutes: 30, host: H.CLINICAL_OPS_COORDINATOR, signoff: S.NONE, requiredFor: [], everyDays: 14, untilDay: 90 },
  { id: 'TRN-403', title: 'Thirty-day review: operational friction and unresolved questions', phase: 'C.9', stage: 'FIRST_90', format: 'LIVE', minutes: null, host: H.EXECUTIVE_DIRECTOR, signoff: S.NONE, requiredFor: [], dueDay: 30 },
  { id: 'TRN-404', title: 'Sixty-day review: coaching', phase: 'C.9', stage: 'FIRST_90', format: 'LIVE', minutes: null, host: H.CLINICAL_DIRECTOR, signoff: S.NONE, requiredFor: [], dueDay: 60 },
  { id: 'TRN-405', title: 'Ninety-day review: performance and scope', phase: 'C.9', stage: 'FIRST_90', format: 'LIVE', minutes: null, host: H.CLINICAL_DIRECTOR, coHost: H.EXECUTIVE_DIRECTOR, signoff: S.NONE, requiredFor: [], dueDay: 90 }
  // TRN-406 (spaced re-assessment) is the system's retention schedule, not a
  // module somebody completes; it is the `spacedRecheck` field on every module.
];

const DEFAULT_SPACED_RECHECK = Object.freeze([3, 10, 30, 90]);

function buildModule(m) {
  const sopRefs = Object.freeze((m.sopRefs || []).slice());
  for (const s of sopRefs) {
    if (!SOP_MANUAL_REFS[s]) throw new Error(`${m.id}: unknown SOP ${s}`);
  }
  let manualRefs = m.manualRefs ? m.manualRefs.slice() : [];
  let manualRefsBasis = m.manualRefs ? 'LIBRARY' : null;
  if (!manualRefs.length && sopRefs.length) {
    manualRefs = Array.from(new Set(sopRefs.flatMap(s => SOP_MANUAL_REFS[s])));
    manualRefsBasis = 'DERIVED_FROM_SOP';
  }
  // TRN-006 teaches the whole manual. Owner decision 2026-11-08: it flags on
  // EVERY manual reissue, whatever changed.
  const flagsOnAnyManualChange = !!m.wholeManual;
  if (m.wholeManual) manualRefsBasis = 'WHOLE_MANUAL';
  let proposedManualRefs = null; let proposedBasis = null; let plannedSop = null;
  if (!manualRefs.length && !m.wholeManual) {
    const planned = Object.entries(SOP_PLANNED).find(([, p]) => p.module === m.id);
    if (planned) {
      plannedSop = planned[0];
      proposedManualRefs = planned[1].manual.slice();
      proposedBasis = 'SOP_SET2_PLANNED';
    } else if (DRAFT_MANUAL_REFS[m.id]) {
      proposedManualRefs = DRAFT_MANUAL_REFS[m.id].slice();
      proposedBasis = 'DRAFT_FOR_CLINICAL_DIRECTOR';
    }
  }
  return Object.freeze({
    id: m.id,
    title: m.title,
    chapter: 'C',
    phase: m.phase,
    stage: m.stage || null,
    roles: Object.freeze(m.audience ? m.audience.slice() : ['NP']),
    // Account types it reaches (2026-11-10); null = the chapter curriculum decides.
    audience: m.audience ? Object.freeze(m.audience.slice()) : null,
    lanes: Object.freeze((m.lanes || []).slice()),
    credentials: Object.freeze((m.credentials || []).slice()),
    format: m.format,
    minutes: m.minutes == null ? null : m.minutes,
    host: m.host,
    coHost: m.coHost || null,
    sopRefs,
    manualRefs: Object.freeze(manualRefs),
    manualRefsBasis,
    flagsOnAnyManualChange,
    proposedManualRefs: proposedManualRefs && Object.freeze(proposedManualRefs),
    proposedBasis,
    plannedSop,
    sourceClass: m.sourceClass ? Object.freeze(m.sourceClass) : null,
    checksFrom: m.checksFrom || null,
    spacedRecheck: DEFAULT_SPACED_RECHECK,
    signoff: m.signoff,
    unlocksAfter: Object.freeze((m.unlocksAfter || []).slice()),
    requiredFor: Object.freeze(m.requiredFor.map(V.parseRequiredFor)),
    requiredForUnparsed: m.requiredForUnparsed || null,
    dueDay: m.dueDay || null,
    everyDays: m.everyDays || null,
    untilDay: m.untilDay || null,
    version: '1',
    libraryRef: L(m.id)
  });
}

const MODULES = Object.freeze(MODULES_RAW.map(buildModule));
const findModule = (id) => MODULES.find(m => m.id === id) || null;

module.exports = { HOSTS, SOP_MANUAL_REFS, SOP_PLANNED, DRAFT_MANUAL_REFS, MODULES, DEFAULT_SPACED_RECHECK, findModule };
