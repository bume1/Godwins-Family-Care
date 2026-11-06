// ============================================================================
// CLINICIAN ONBOARDING, CREDENTIALING AND PRIVILEGING
// Per docs/GFC_Clinical_Onboarding_Playbook_v1.md (owner-authored, 2026-11)
// ============================================================================
// THE ONE RULE THAT DECIDES THE WHOLE SHAPE OF THIS MODULE, from the playbook:
//
//   "The wizard never stores a 'playbook per person.' It stores the person's
//    inputs and builds the checklist from the item library every time those
//    inputs change."
//
// So there is no stored checklist anywhere. A person's record holds FOUR INPUTS
// and the STATE of individual items. The checklist is DERIVED on every read, the
// same rule the caregiver document checklist and the client enrollment checklist
// already follow. Tick a new lane and that lane's items appear; untick it and its
// OPEN items disappear while its COMPLETED ones stay in the record, because what
// somebody actually did is a fact and un-ticking a box does not undo it.
//
// A GATE IS DERIVED THE SAME WAY, and deliberately has no second list of its own
// requirements. A gate's requirements ARE every applicable item that names it.
// Writing them out twice is how the gate and the items start disagreeing about
// what is outstanding, which is the failure this repo has paid for repeatedly.
//
// WHAT THIS MODULE DOES NOT DO, and must never be made to do: verify anything.
// There is no connection to Nursys, NPPES, NPDB, OIG, SAM, CAQH, PECOS, the DEA
// or any board, and building something that implies one would be worse than
// useless. Every verified item stores WHO checked it, against WHICH source, on
// WHAT date, with the dated proof attached. A `verifiedAt` older than the item's
// own cadence is what reopens it. The app records and reminds; a person verifies.
// That is the fax-requisition rule (the app generates, a person transmits) applied
// to credentialing. Build-enforced in test/clinician_onboarding.test.js.
//
// RESERVED ID PREFIXES (playbook 1.3): adding a role must never renumber an
// existing item, so the live and reserved prefixes are declared and guarded.
//
// Pure functions over plain records — no I/O, no request context.
// ============================================================================

'use strict';

// ---- THE FOUR INPUTS (playbook 1.1) ---------------------------------------
// One person can hold more than one role (a physician is often both the
// supervising physician and the medical director), so ROLE is a list.
const ROLES = Object.freeze({
  NP: 'NP',
  MD_DELEGATING: 'MD_DELEGATING',
  MD_DIRECTOR: 'MD_DIRECTOR'
});
const ALL_ROLES = Object.freeze(Object.values(ROLES));
const ROLE_LABELS = Object.freeze({
  NP: 'Nurse practitioner',
  MD_DELEGATING: 'Supervising physician',
  MD_DIRECTOR: 'Medical director'
});

const RELATIONSHIPS = Object.freeze({ W2: 'W2', C1099: '1099', HYBRID: 'HYBRID' });
const ALL_RELATIONSHIPS = Object.freeze(Object.values(RELATIONSHIPS));
const RELATIONSHIP_LABELS = Object.freeze({
  W2: 'Employee (W2)',
  '1099': 'Contractor (1099)',
  HYBRID: 'Both — employee for clinical care, contractor for exams'
});

// Lanes are NPs only. A physician has no lane; no lane ticked generates no
// lane items at all rather than defaulting to one.
const LANES = Object.freeze({ CLINICAL: 'CLINICAL', EXAMS: 'EXAMS' });
const ALL_LANES = Object.freeze(Object.values(LANES));
const LANE_LABELS = Object.freeze({ CLINICAL: 'Patient visits', EXAMS: 'Exams' });

const ADDONS = Object.freeze({
  FNP: 'FNP', PMHNP: 'PMHNP', PRESCRIBES: 'PRESCRIBES', CONTROLLED: 'CONTROLLED',
  TELEHEALTH: 'TELEHEALTH', INSURED_BILLING: 'INSURED_BILLING',
  STATE_NC: 'STATE_NC', STATE_AL: 'STATE_AL'
});
const ALL_ADDONS = Object.freeze(Object.values(ADDONS));
const ADDON_LABELS = Object.freeze({
  FNP: 'Family NP certification',
  PMHNP: 'Psych NP certification',
  PRESCRIBES: 'Prescribes medication',
  CONTROLLED: 'Prescribes controlled medication',
  TELEHEALTH: 'Sees patients by video',
  INSURED_BILLING: 'Bills insurance',
  STATE_NC: 'Also practices in North Carolina',
  STATE_AL: 'Also practices in Alabama'
});

// ---- FAMILIES (playbook 1.3) ----------------------------------------------
// The family decides which core block applies and which gates exist, so an
// executive assistant never sees a Board or protocol gate. Only the licensed
// clinical family has items today; the other two are declared so a later
// session drops them in rather than reshaping this.
const FAMILIES = Object.freeze({
  LICENSED_CLINICAL: 'LICENSED_CLINICAL',
  CLINICAL_SUPPORT: 'CLINICAL_SUPPORT',
  ADMINISTRATIVE: 'ADMINISTRATIVE'
});
const FAMILY_OF_ROLE = Object.freeze({
  NP: FAMILIES.LICENSED_CLINICAL,
  MD_DELEGATING: FAMILIES.LICENSED_CLINICAL,
  MD_DIRECTOR: FAMILIES.LICENSED_CLINICAL
});
// Roles named in the playbook with no block yet. A record carrying one of these
// reads "Track not yet defined" and the wizard does not error.
const RESERVED_ROLES = Object.freeze(['RN', 'LMSW', 'CCC', 'CCA', 'CCL', 'EA']);

// ---- ID PREFIXES (playbook 1.3) -------------------------------------------
const LIVE_PREFIXES = Object.freeze(['CORE', 'CLIN', 'NP', 'FNP', 'PMH', 'MD', 'DIR',
  'W2', 'C99', 'HYB', 'LCL', 'EXM', 'PRV', 'RX', 'CS', 'TH', 'INS', 'NC', 'AL', 'ONG']);
const RESERVED_PREFIXES = Object.freeze(['RN', 'SW', 'CCC', 'CCA', 'CCL', 'EA', 'SUP', 'ADM']);

// ---- OWNERS (playbook 1.4) ------------------------------------------------
// The playbook never names staff. An item carries an owner PILL and, for GFC
// work, an internal owner ROLE which settings maps to a person.
const OWNERS = Object.freeze({
  CLINICIAN: 'clinician', GFC: 'gfc', OUTSIDE: 'outside',
  SELF_PACED: 'selfPaced', SYSTEM: 'system'
});
const OWNER_LABELS = Object.freeze({
  clinician: 'You', gfc: 'GFC', outside: 'Outside', selfPaced: 'Self-paced', system: 'Automatic'
});
const OWNER_ROLES = Object.freeze({
  CREDENTIALING_OWNER: 'CREDENTIALING_OWNER',
  CLINICAL_DIRECTOR: 'CLINICAL_DIRECTOR',
  EXECUTIVE_DIRECTOR: 'EXECUTIVE_DIRECTOR',
  SUPERVISING_PHYSICIAN: 'SUPERVISING_PHYSICIAN'
});
const OWNER_ROLE_LABELS = Object.freeze({
  CREDENTIALING_OWNER: 'Credentialing Owner',
  CLINICAL_DIRECTOR: 'Clinical Director',
  EXECUTIVE_DIRECTOR: 'Executive Director',
  SUPERVISING_PHYSICIAN: 'Supervising Physician'
});

// ---- WHAT A PERSON DOES WITH AN ITEM --------------------------------------
const ACTIONS = Object.freeze({
  UPLOAD: 'UPLOAD',                       // attach a file as proof
  SIGN: 'SIGN',                           // sign in the app, against a document version
  ACKNOWLEDGE: 'ACKNOWLEDGE',             // read and acknowledge
  ATTEST_WITH_CHECKS: 'ATTEST_WITH_CHECKS', // read, answer scenario questions, attest
  RECORD: 'RECORD',                       // the office records a fact (a note, a count)
  VERIFY: 'VERIFY',                       // the office checks a primary source and dates it
  EXTERNAL: 'EXTERNAL',                   // done on somebody else's system, certificate uploaded
  CONFIGURE: 'CONFIGURE'                  // the office switches something on and tests it
});

// ---- VERIFICATION SOURCES (playbook 1.3: a lookup table, keyed by type) ----
// Keyed so a new licence type (LMSW) adds a row rather than a branch.
const VERIFY_SOURCES = Object.freeze({
  NURSYS: { id: 'NURSYS', label: 'Nursys', url: 'https://www.nursys.com/', licenseTypes: ['RN', 'APRN'] },
  GCMB: { id: 'GCMB', label: 'Georgia Composite Medical Board', url: 'https://gcmb.mylicense.com/verification/', licenseTypes: ['MD', 'DO'] },
  GA_SW_BOARD: { id: 'GA_SW_BOARD', label: 'Georgia social work licensing board', url: null, licenseTypes: ['LMSW', 'LCSW'] },
  NPPES: { id: 'NPPES', label: 'NPPES NPI Registry', url: 'https://npiregistry.cms.hhs.gov/' },
  NPDB: { id: 'NPDB', label: 'NPDB', url: 'https://www.npdb.hrsa.gov/' },
  OIG_LEIE: { id: 'OIG_LEIE', label: 'OIG exclusion list (LEIE)', url: 'https://exclusions.oig.hhs.gov/' },
  SAM: { id: 'SAM', label: 'SAM.gov', url: 'https://sam.gov/' },
  GA_DCH: { id: 'GA_DCH', label: 'Georgia OIG exclusion list', url: null },
  AANP: { id: 'AANP', label: 'AANP certification check', url: null },
  ANCC: { id: 'ANCC', label: 'ANCC certification check', url: null },
  ABMS: { id: 'ABMS', label: 'ABMS Certification Matters', url: null },
  AHA: { id: 'AHA', label: 'AHA eCard lookup', url: null },
  DEA: { id: 'DEA', label: 'DEA registration validation', url: null },
  CARRIER: { id: 'CARRIER', label: 'Malpractice carrier', url: null },
  GAPS: { id: 'GAPS', label: 'Georgia Applicant Processing Service', url: null },
  REGISTRAR: { id: 'REGISTRAR', label: 'School registrar', url: null },
  EMPLOYER: { id: 'EMPLOYER', label: 'Employer contact', url: null },
  CAQH: { id: 'CAQH', label: 'CAQH ProView', url: null },
  PECOS: { id: 'PECOS', label: 'Medicare PECOS', url: null },
  GCMB_PORTAL: { id: 'GCMB_PORTAL', label: 'GCMB online filing portal', url: null },
  NC_BON: { id: 'NC_BON', label: 'North Carolina Board of Nursing', url: null },
  AL_BOARDS: { id: 'AL_BOARDS', label: 'Alabama Board of Nursing and Medical Board', url: null }
});

// ---- CADENCES -------------------------------------------------------------
// `days` is what reopens an item. null means a person decides, never a clock:
// "on change" and "on revision" are events, and inventing a 365-day timer for
// them would chase paperwork nobody owes.
const CADENCES = Object.freeze({
  once: { label: 'Once', days: null },
  on_change: { label: 'When it changes', days: null },
  on_revision: { label: 'When the document is revised', days: null },
  on_expiration: { label: 'When it expires', days: null, usesExpiry: true },
  on_event: { label: 'On any event', days: null },
  continuous: { label: 'Continuous', days: null },
  per_policy: { label: 'Per policy', days: null },
  per_contractor: { label: 'Once per contractor', days: null },
  per_new_np: { label: 'For each new NP', days: null },
  monthly: { label: 'Monthly', days: 30 },
  quarterly: { label: 'Quarterly', days: 90 },
  every_120_days: { label: 'Every 120 days', days: 120 },
  annually: { label: 'Annually', days: 365 },
  every_2_years: { label: 'Every 2 years', days: 730 },
  every_3_years: { label: 'Every 3 years', days: 1095 },
  every_5_years: { label: 'Every 5 years', days: 1825 }
});

// ---- GATES (playbook 1.5) -------------------------------------------------
// A gate's ITEM requirements are not listed here. They are every applicable
// item whose `gates` names it, so the gate and the checklist cannot disagree.
// What IS listed is which gates must open first, because that is a fact about
// gates rather than about items.
const GATES = Object.freeze({
  G0: {
    id: 'G0', label: 'ACCESS', title: 'App and EHR access',
    opens: 'Their app and EHR accounts', requiresGates: [], parentGate: false,
    appliesWhen: {}
  },
  G_MD: {
    id: 'G_MD', label: 'PHYSICIAN READY', title: 'Supervising physician ready',
    opens: 'Every NP under this physician', requiresGates: [], parentGate: true,
    appliesWhen: { roles: ['MD_DELEGATING', 'MD_DIRECTOR'] }
  },
  G1: {
    id: 'G1', label: 'EXAMS', title: 'Exams',
    opens: 'The Exam Workspace and accepting cases', requiresGates: ['G0'], parentGate: false,
    appliesWhen: { lanes: ['EXAMS'] }
  },
  G2: {
    id: 'G2', label: 'PATIENT VISITS', title: 'Patient visits',
    opens: 'The Clinical Workspace, scheduling and charting',
    requiresGates: ['G0'], requiresSupervisorGate: 'G_MD', parentGate: false,
    appliesWhen: { lanes: ['CLINICAL'] }
  },
  G3: {
    id: 'G3', label: 'CONTROLLED PRESCRIBING', title: 'Controlled prescribing',
    opens: 'Controlled substance e-prescribing', requiresGates: ['G2'], parentGate: false,
    appliesWhen: { addons: ['CONTROLLED'] }
  },
  G4: {
    id: 'G4', label: 'PSYCH', title: 'Psychiatric care',
    opens: 'Psych templates and psych codes', requiresGates: ['G2'], parentGate: false,
    appliesWhen: { addons: ['PMHNP'] }
  },
  G5: {
    id: 'G5', label: 'BILLING', title: 'Billing a payer',
    opens: 'Claims to one payer only', requiresGates: ['G2'], parentGate: false, perPayer: true,
    appliesWhen: { addons: ['INSURED_BILLING'] }
  },
  ROLE_READY: {
    id: 'ROLE_READY', label: 'ROLE READY', title: 'Role ready',
    opens: 'Reserved for support and administrative roles',
    requiresGates: [], parentGate: false, reserved: true,
    appliesWhen: { never: true }
  }
});
const ALL_GATES = Object.freeze(Object.keys(GATES));
// Which gates a family may ever see. A gate absent here is never evaluated for
// that family, so a future executive assistant is never shown a protocol gate.
const GATES_BY_FAMILY = Object.freeze({
  LICENSED_CLINICAL: Object.freeze(['G0', 'G_MD', 'G1', 'G2', 'G3', 'G4', 'G5']),
  CLINICAL_SUPPORT: Object.freeze(['G0', 'ROLE_READY']),
  ADMINISTRATIVE: Object.freeze(['G0', 'ROLE_READY'])
});

module.exports = {
  ROLES, ALL_ROLES, ROLE_LABELS,
  RELATIONSHIPS, ALL_RELATIONSHIPS, RELATIONSHIP_LABELS,
  LANES, ALL_LANES, LANE_LABELS,
  ADDONS, ALL_ADDONS, ADDON_LABELS,
  FAMILIES, FAMILY_OF_ROLE, RESERVED_ROLES,
  LIVE_PREFIXES, RESERVED_PREFIXES,
  OWNERS, OWNER_LABELS, OWNER_ROLES, OWNER_ROLE_LABELS,
  ACTIONS, VERIFY_SOURCES, CADENCES,
  GATES, ALL_GATES, GATES_BY_FAMILY
};
