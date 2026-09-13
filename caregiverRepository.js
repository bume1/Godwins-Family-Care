// ============================================================================
// Caregiver workspace — pure helpers (Session 6)
// Spec: docs/GFC_Caregiver_Workspace_Spec_v1.md (normative)
//       docs/GFC_Caregiver_Profile_Schema_v1.md (licenseLevel, competencies)
//
// Everything in this file is a PURE function over plain data. No db, no express,
// no I/O. That is deliberate: the tier-branching rule is a patient-safety rule
// ("a PCA form never surfaces a skilled task"), so it has to be directly
// testable without standing up the app — the same reason consentRegistry.js
// holds the consent vocabulary rather than server.js.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
// ---------------------------------------
// `visitLogSchemaFor()` is the single source of truth for what a given
// caregiver may document. The form renders from it and the API validates
// against it. A field the schema does not contain is ABSENT from the stored
// payload, not merely hidden in the UI — `sanitizeVisitLogSubmission()` drops
// anything the schema did not offer. Hiding a field client-side is a styling
// choice; dropping it server-side is the control.
// ============================================================================

// ---- License levels (same enum as the matching schema, spec §2) ----
const LICENSE_LEVELS = Object.freeze(['sitter', 'pca', 'cna', 'lpn']);

const LICENSE_LABELS = Object.freeze({
  sitter: 'Sitter / Companion',
  pca: 'PCA',
  cna: 'CNA',
  lpn: 'LPN'
});

// Scope is cumulative up the ladder: a CNA may do everything a PCA may, an LPN
// everything a CNA may. Rank is how the catalog expresses "PCA and above".
const LEVEL_RANK = Object.freeze({ sitter: 0, pca: 1, cna: 2, lpn: 3 });

const normalizeLevel = (v) => {
  const level = String(v || '').trim().toLowerCase();
  return LICENSE_LEVELS.includes(level) ? level : null;
};

// ---- Competencies (profile schema §1 `skilledCompetencies`) ----
// The schema's enum plus three delegated-task keys spec §3c requires and the
// profile schema does not yet carry (vitals, intake/output, positioning).
// A competency counts ONLY when `verified` is true and any expiry is in the
// future — profile schema §4: an unverified or expired credential is treated
// as NOT PRESENT, it does not merely lower a score. Fails safe.
const COMPETENCIES = Object.freeze([
  'vital_signs', 'blood_glucose', 'intake_output', 'positioning',
  'wound_care', 'catheter', 'ostomy', 'trach', 'g_tube', 'injections',
  'oxygen', 'med_administration', 'suctioning', 'specimen_collection'
]);

const COMPETENCY_LABELS = Object.freeze({
  vital_signs: 'Vital signs', blood_glucose: 'Blood glucose',
  intake_output: 'Intake & output', positioning: 'Positioning / turn schedule',
  wound_care: 'Wound care', catheter: 'Catheter care', ostomy: 'Ostomy care',
  trach: 'Tracheostomy care', g_tube: 'Feeding tube care', injections: 'Injections / IV',
  oxygen: 'Oxygen', med_administration: 'Medication administration',
  suctioning: 'Suctioning', specimen_collection: 'Specimen collection'
});

// Reads a caregiver user record and returns the set of competencies that
// actually count today. Accepts both the profile-schema shape
// ([{task, verified, expiry}]) and a plain string array (admin shorthand);
// a bare string is treated as UNVERIFIED and therefore does not count.
function verifiedCompetencies(caregiver, now = new Date()) {
  const raw = (caregiver && caregiver.skilledCompetencies) || [];
  if (!Array.isArray(raw)) return [];
  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;      // bare string → unverified
    const task = String(entry.task || '').trim().toLowerCase();
    if (!COMPETENCIES.includes(task)) continue;
    if (entry.verified !== true) continue;                  // fails safe
    if (entry.expiry) {
      const exp = new Date(entry.expiry).getTime();
      if (!isNaN(exp) && exp < ts) continue;                // expired → not present
    }
    if (!out.includes(task)) out.push(task);
  }
  return out;
}

// ---- Pay rate (owner request, 2026-09-13) ------------------------------------
// What we PAY a caregiver. This is a different number from `client.rateAgreement`
// — what the CLIENT pays — and the difference between them is the margin, so the
// two must never be read from one field. Lives here with the rest of the
// caregiver vocabulary rather than in config, same as the licence enum.
//
// Three levels, most specific first:
//   1. the rate posted ON THE SHIFT (an admin set it when releasing the shift)
//   2. a per-client rate for this caregiver (a harder client pays more)
//   3. the caregiver's base rate
// A rate that is set nowhere resolves to null and SAYS so. It never falls back
// to zero: zero is a rate somebody chose, null is a rate nobody has set, and a
// payroll run must be able to tell those apart.
//
// Stored as plain dollars rounded to cents, matching `client.rateAgreement`
// rather than introducing a second money convention in the same codebase.

const MAX_PAY_RATE = 500; // a sanity ceiling, not a policy — catches a typo'd 3200

// Returns a number in dollars, or null when the value is absent or unusable.
// An unparseable rate is null, never 0 — see above.
function normalizePayRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!isFinite(n) || n < 0 || n > MAX_PAY_RATE) return null;
  return Math.round(n * 100) / 100;
}

// Per-client overrides, keyed by client ID. Deliberately NOT by name: the
// vendor picker stores assignedClients by name, and a client who gets renamed
// would silently drop back to the base rate — a quiet pay cut nobody would see.
function normalizeClientPayRates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [clientId, rate] of Object.entries(value)) {
    const id = String(clientId || '').trim();
    if (!id) continue;
    const n = normalizePayRate(rate);
    if (n !== null) out[id] = n;   // an unusable override is dropped, not stored as 0
  }
  return out;
}

// The whole resolution, in one place, so the admin screen, the shift post and
// any later payroll read cannot disagree about what someone is paid.
// `source` is returned because "it came from the shift" and "it came from the
// base rate" are different facts an admin needs when a number looks wrong.
function resolvePayRate(caregiver, clientId = null, shift = null) {
  const posted = normalizePayRate(shift && (shift.pay_rate !== undefined ? shift.pay_rate : shift.payRate));
  if (posted !== null) return { rate: posted, source: 'shift' };

  const perClient = normalizeClientPayRates(caregiver && caregiver.clientPayRates);
  const id = String(clientId || '').trim();
  if (id && perClient[id] !== undefined) return { rate: perClient[id], source: 'client' };

  const base = normalizePayRate(caregiver && caregiver.payRate);
  if (base !== null) return { rate: base, source: 'base' };

  return { rate: null, source: 'unset' };
}

// ---- Task catalog (spec §3a, transferred from docs/source-forms/gfc-visit-log.html) ----
// `legacy` is the legacy daily-note field name, preserved so a paper/legacy
// record maps onto the same item. `minLevel` is the lowest license level the
// item may appear for. `competency` means the item ALSO requires that verified
// competency — at CNA level, where the task is delegated. An LPN performs these
// under their own license, so `byLicense` lists the levels that skip the
// competency check.
const TASK_GROUPS = Object.freeze([
  {
    id: 'presence', label: 'Presence & safety', minLevel: 'sitter',
    items: [
      { id: 'presence_confirmed', legacy: null, label: 'Presence confirmed — client safe', minLevel: 'sitter' },
      { id: 'safety_monitor', legacy: 'd_safety', label: 'Monitor safety / fall / accident', minLevel: 'sitter' }
    ]
  },
  {
    id: 'companionship', label: 'Companionship & activity', minLevel: 'sitter',
    items: [
      { id: 'companion', legacy: 'd_companion', label: 'Reading to and companionship', minLevel: 'sitter' },
      { id: 'walking', legacy: 'd_walking', label: 'Assist with walking / physical activities', minLevel: 'sitter' },
      { id: 'escort', legacy: 'd_escort', label: 'Escort / errand to medical appt', minLevel: 'pca' }
    ]
  },
  {
    id: 'personal_care', label: 'Personal care & ADLs', minLevel: 'pca',
    items: [
      { id: 'bath', legacy: 'd_bath', label: 'Bath / tub / shower / wash', minLevel: 'pca' },
      { id: 'toileting', legacy: 'd_toileting', label: 'Toileting', minLevel: 'pca' },
      { id: 'hair', legacy: 'd_hair', label: 'Hair care / shampooing', minLevel: 'pca' },
      { id: 'skin', legacy: 'd_skin', label: 'Skin care / observe skin', minLevel: 'pca' },
      { id: 'shaving', legacy: 'd_shaving', label: 'Shaving', minLevel: 'pca' },
      { id: 'teeth', legacy: 'd_teeth', label: 'Brush teeth', minLevel: 'pca' },
      { id: 'nails', legacy: 'd_nails', label: 'Nails', minLevel: 'pca' },
      { id: 'foot', legacy: 'd_foot', label: 'Foot care / tepid water soak', minLevel: 'pca' },
      { id: 'lotion', legacy: 'd_lotion', label: 'Lotion rubs — back / leg', minLevel: 'pca' },
      { id: 'dressing', legacy: 'd_dressing', label: 'Assist with dressing', minLevel: 'pca' },
      { id: 'bedpan', legacy: 'd_bedpan', label: 'Assist with bedpan / commode / urinal / diaper', minLevel: 'pca' },
      { id: 'peri', legacy: 'd_peri', label: 'Peri care', minLevel: 'pca' }
    ]
  },
  {
    id: 'mobility', label: 'Mobility & transfers', minLevel: 'pca',
    items: [
      { id: 'wheelchair', legacy: 'd_wheelchair', label: 'Assist with wheelchair', minLevel: 'pca' },
      { id: 'transfers', legacy: 'd_transfers', label: 'Assist with transfers', minLevel: 'pca' },
      { id: 'turn', legacy: 'd_turn', label: 'Turn and reposition', minLevel: 'pca' },
      { id: 'drainage', legacy: 'd_drainage', label: 'Empty drainage bag', minLevel: 'pca' },
      { id: 'pressure', legacy: 'd_pressure', label: 'Check pressure areas', minLevel: 'pca' }
    ]
  },
  {
    id: 'household', label: 'Household & IADLs', minLevel: 'pca',
    items: [
      { id: 'sweep', legacy: 'd_sweep', label: 'Sweep / dust / tidy / vacuum patient room', minLevel: 'pca' },
      { id: 'bathroom', legacy: 'd_bathroom', label: 'Clean patient bathroom', minLevel: 'pca' },
      { id: 'dishes', legacy: 'd_dishes', label: 'Wash / clean patient dishes', minLevel: 'pca' },
      { id: 'laundry', legacy: 'd_laundry', label: 'Assist with patient laundry', minLevel: 'pca' },
      { id: 'linens', legacy: 'd_linens', label: 'Change linens', minLevel: 'pca' },
      { id: 'kitchen', legacy: 'd_kitchen', label: 'Assist in cleaning kitchen equipment', minLevel: 'pca' },
      { id: 'grocery', legacy: 'd_grocery', label: 'Grocery shopping', minLevel: 'pca' }
    ]
  },
  {
    id: 'meals', label: 'Meals & nutrition', minLevel: 'sitter',
    items: [
      // Sitters observe and offer; they do not prepare or feed (spec §3b).
      { id: 'fluid', legacy: 'd_fluid', label: 'Offer fluid', minLevel: 'sitter' },
      { id: 'record_intake', legacy: 'd_record', label: 'Observe and record meal / fluid intake', minLevel: 'sitter' },
      { id: 'cook', legacy: 'd_cook', label: 'Cook meals', minLevel: 'pca' },
      { id: 'feed', legacy: 'd_feed', label: 'Set up meal / feed patient', minLevel: 'pca' },
      { id: 'diet', legacy: 'd_diet', label: 'Encourage / support diet as ordered', minLevel: 'pca' }
    ]
  },
  {
    id: 'medication', label: 'Medication support', minLevel: 'pca',
    // REMINDER ONLY below LPN. There is deliberately no "administered" item at
    // PCA or CNA level anywhere in this catalog — spec §3a. Administration
    // appears once, in the LPN skilled block, and only with the competency.
    items: [
      { id: 'pickup_rx', legacy: 'd_pickup', label: 'Pick up prescriptions', minLevel: 'pca' },
      { id: 'med_remind', legacy: 'd_medremind', label: 'Observe / remind client to take medication', minLevel: 'pca' }
    ]
  },
  {
    id: 'delegated', label: 'Vitals & delegated tasks', minLevel: 'cna',
    // CNA scope, each item additionally gated on a VERIFIED competency
    // (spec §3c). An LPN performs these under their own license.
    items: [
      { id: 'temperature', legacy: 'd_temp', label: 'Check temperature', minLevel: 'cna', competency: 'vital_signs', byLicense: ['lpn'] },
      { id: 'blood_pressure', legacy: 'd_bp', label: 'Check blood pressure', minLevel: 'cna', competency: 'vital_signs', byLicense: ['lpn'] },
      { id: 'vitals', legacy: 'd_vitals', label: 'Vital signs monitoring', minLevel: 'cna', competency: 'vital_signs', byLicense: ['lpn'] },
      { id: 'blood_sugar', legacy: 'd_sugar', label: 'Blood sugar management', minLevel: 'cna', competency: 'blood_glucose', byLicense: ['lpn'] },
      { id: 'intake_output', legacy: null, label: 'Record intake & output', minLevel: 'cna', competency: 'intake_output', byLicense: ['lpn'] },
      { id: 'turn_schedule', legacy: null, label: 'Positioning / turn schedule', minLevel: 'cna', competency: 'positioning', byLicense: ['lpn'] }
    ]
  },
  {
    id: 'skilled', label: 'Skilled nursing', minLevel: 'lpn',
    // LPN ONLY (spec §3a "Excluded — LPN skilled note only"), each item still
    // gated on the verified competency for that task.
    items: [
      { id: 'wound', legacy: 'd_wound', label: 'Wash and redress wound', minLevel: 'lpn', competency: 'wound_care' },
      { id: 'catheter', legacy: 'd_catheter', label: 'Catheter care', minLevel: 'lpn', competency: 'catheter' },
      { id: 'ostomy', legacy: 'd_ostomy', label: 'Ostomy care', minLevel: 'lpn', competency: 'ostomy' },
      { id: 'injection', legacy: 'd_injection', label: 'Injection and IV therapy', minLevel: 'lpn', competency: 'injections' },
      { id: 'feedtube', legacy: 'd_feedtube', label: 'Feeding tube care', minLevel: 'lpn', competency: 'g_tube' },
      { id: 'specimen', legacy: 'd_specimen', label: 'Specimen collection', minLevel: 'lpn', competency: 'specimen_collection' },
      { id: 'med_administer', legacy: null, label: 'Medication administration', minLevel: 'lpn', competency: 'med_administration' },
      { id: 'trach', legacy: null, label: 'Tracheostomy care', minLevel: 'lpn', competency: 'trach' },
      { id: 'suctioning', legacy: null, label: 'Suctioning', minLevel: 'lpn', competency: 'suctioning' },
      { id: 'oxygen', legacy: null, label: 'Oxygen', minLevel: 'lpn', competency: 'oxygen' },
      { id: 'postop', legacy: 'd_postop', label: 'Post operation status / care', minLevel: 'lpn' },
      { id: 'teach', legacy: 'd_teach', label: 'Teach / train client on equipment', minLevel: 'lpn' }
    ]
  }
]);

// Every task id that is skilled-or-delegated. Used by the build-enforced test
// that asserts none of these can appear in a Sitter or PCA payload.
const RESTRICTED_TASK_IDS = Object.freeze(
  TASK_GROUPS.filter(g => g.id === 'skilled' || g.id === 'delegated')
    .reduce((acc, g) => acc.concat(g.items.map(i => i.id)), [])
);
const SKILLED_TASK_IDS = Object.freeze(
  (TASK_GROUPS.find(g => g.id === 'skilled') || { items: [] }).items.map(i => i.id)
);

// ---- Standing / special instructions (spec §3a) ----
const STANDING_INSTRUCTIONS = Object.freeze([
  { id: 'encourage_activity', label: 'Encourage physical activity' },
  { id: 'encourage_interaction', label: 'Encourage interaction with others' },
  { id: 'encourage_ers', label: 'Encourage to wear ERS' },
  { id: 'encourage_rest', label: 'Encourage rest' },
  { id: 'watchful_supervision', label: 'Watchful supervision at all times' },
  { id: 'bowel_bladder', label: 'Reminders for bowel / bladder' },
  { id: 'report_abuse', label: 'Report abusive / neglectful behavior' },
  { id: 'report_falls', label: 'Report all falls' },
  { id: 'socialize', label: 'Socialize and discuss current events' },
  { id: 'report_changes', label: 'Report changes in condition / behavior' },
  { id: 'report_health', label: 'Report health changes / ER visits' },
  { id: 'encourage_relaxation', label: 'Encourage relaxation for pain relief' },
  { id: 'encourage_elevation', label: 'Encourage elevation of limbs' },
  { id: 'items_within_reach', label: 'Place items within reach before leaving' },
  { id: 'fluid_within_reach', label: 'Keep fluid / food within reach' },
  { id: 'dme_cue', label: 'Encourage / cue for DME use' }
]);

// ---- Patient condition observed (spec §3a, multi-select) ----
const PATIENT_CONDITIONS = Object.freeze([
  { id: 'alert', label: 'Alert' }, { id: 'quiet', label: 'Quiet' },
  { id: 'sleepy', label: 'Sleepy' }, { id: 'talkative', label: 'Talkative' },
  { id: 'happy', label: 'Happy' }, { id: 'angry', label: 'Angry' },
  { id: 'grieving', label: 'Grieving' }, { id: 'depressed', label: 'Depressed' },
  { id: 'pain', label: 'Pain' }, { id: 'hungry', label: 'Hungry' },
  { id: 'sick', label: 'Sick' }, { id: 'clean', label: 'Clean' }
]);

// ---- Safety concerns (spec §3a, multi-select) ----
// `incident: true` means checking it SPAWNS A SEPARATE INCIDENT REPORT, not a
// checkbox on the visit log. A fall and an abuse/neglect observation are
// reportable events in their own right; burying either inside a daily note is
// how they get missed.
const SAFETY_CONCERNS = Object.freeze([
  { id: 'meal_consumption', label: 'Meal consumption' },
  { id: 'safety_in_home', label: 'Safety in the home' },
  { id: 'poor_physical_condition', label: 'Poor physical condition' },
  { id: 'falls', label: 'Falls', incident: true },
  { id: 'emotional_condition', label: 'Emotional condition' },
  { id: 'slowness_weakness', label: 'Slowness / weakness' },
  { id: 'frequent_illness', label: 'Frequent illness' },
  { id: 'abuse_neglect', label: 'Abuse / neglect', incident: true },
  { id: 'weight_loss', label: 'Weight loss' }
]);

const INCIDENT_SAFETY_CONCERNS = Object.freeze(
  SAFETY_CONCERNS.filter(c => c.incident).map(c => c.id)
);

// ---- Structured measurement fields (CNA/LPN, competency-gated) ----
// These are the numeric fields that ride alongside the delegated task
// checkboxes. Same gate: the competency, or the LPN's own license.
const MEASUREMENT_FIELDS = Object.freeze([
  { id: 'temperatureF', label: 'Temperature (°F)', unit: '°F', competency: 'vital_signs', byLicense: ['lpn'] },
  { id: 'bloodPressure', label: 'Blood pressure', unit: 'mmHg', competency: 'vital_signs', byLicense: ['lpn'] },
  { id: 'pulse', label: 'Pulse', unit: 'bpm', competency: 'vital_signs', byLicense: ['lpn'] },
  { id: 'respirations', label: 'Respirations', unit: '/min', competency: 'vital_signs', byLicense: ['lpn'] },
  { id: 'oxygenSaturation', label: 'O₂ saturation', unit: '%', competency: 'vital_signs', byLicense: ['lpn'] },
  { id: 'weightLbs', label: 'Weight (lb)', unit: 'lb', competency: 'vital_signs', byLicense: ['lpn'] },
  { id: 'bloodGlucose', label: 'Blood glucose', unit: 'mg/dL', competency: 'blood_glucose', byLicense: ['lpn'] },
  { id: 'intakeMl', label: 'Intake', unit: 'mL', competency: 'intake_output', byLicense: ['lpn'] },
  { id: 'outputMl', label: 'Output', unit: 'mL', competency: 'intake_output', byLicense: ['lpn'] }
]);

// ---- Free-text / narrative sections ----
// `minLevel` again; the LPN narrative block is spec §3's skilled visit note.
const NARRATIVE_FIELDS = Object.freeze([
  { id: 'tasksNotPerformed', legacy: 'tasksNotPerformed', label: 'Tasks not performed — and why', minLevel: 'sitter' },
  { id: 'safetyConcernDetails', legacy: 'safetyConcernDetails', label: 'Safety concern detail', minLevel: 'sitter' },
  { id: 'recommendedChanges', legacy: 'recommendedChanges', label: 'Recommended changes to the care plan', minLevel: 'sitter' },
  { id: 'additionalNotes', legacy: 'additionalNotes', label: 'Additional notes', minLevel: 'sitter' },
  { id: 'clinicalObservations', legacy: null, label: 'Clinical observations', minLevel: 'lpn' },
  { id: 'responseToTreatment', legacy: null, label: 'Response to treatment', minLevel: 'lpn' }
]);

const SATISFACTION_VALUES = Object.freeze(['satisfied', 'not_satisfied']);

// ---- Visit log status ----
// An LPN skilled note lands as `pending_review` and routes to the clinician
// inbox; everything else is `submitted`. Neither is ever edited (see below).
const VISIT_LOG_STATUSES = Object.freeze(['submitted', 'pending_review', 'reviewed']);

// ============================================================================
// visitLogSchemaFor — THE tier-branching rule
// ============================================================================
// Returns exactly the fields this caregiver may document, given their license
// level and their VERIFIED competencies. Nothing else in the app decides this.
//
// `client` is optional. When the client carries an authorized care plan, the
// task checklist is narrowed to the tasks that plan authorizes (spec §3a:
// "generated from the client's authorized care plan") — a caregiver is never
// offered a task this client is not authorized to receive. When no plan is on
// file the full level-appropriate catalog shows, because a missing plan must
// not silently blank the form.
function visitLogSchemaFor(caregiver, client = null, now = new Date()) {
  const level = normalizeLevel(caregiver && caregiver.licenseLevel);
  if (!level) {
    return { level: null, valid: false, reason: 'NO_LICENSE_LEVEL', taskGroups: [], measurements: [], narratives: [] };
  }
  const rank = LEVEL_RANK[level];
  const competencies = verifiedCompetencies(caregiver, now);
  const authorized = authorizedTaskIds(client);

  // OWNER RULE, 2026-09-13: for a COMPETENCY-GATED item the verified competency
  // is the whole gate — the licence level is no longer a ceiling over it. The
  // work is performed under licensed oversight, and a caregiver who did the
  // task has to be able to document it; a task done and not recorded is worse
  // than one recorded by someone below the old line.
  //
  // It also closes a silent failure. Before this, ticking `injections` for a
  // PCA stored the competency, showed it in the admin form, and changed
  // nothing — an administrator believed they had enabled something and had
  // not. A sign-off that does nothing is the same class of trap as a 200 that
  // writes nothing.
  //
  // What did NOT change, deliberately:
  //  - An item with NO competency keeps its minLevel. A Sitter still is not
  //    offered bathing or cooking; that is scope of role, not a credential, and
  //    there is no sign-off that unlocks it. `postop` and `teach` stay LPN-only
  //    for the same reason.
  //  - Unverified or expired still counts as NOT PRESENT (verifiedCompetencies).
  //    The gate moved; it did not loosen.
  //  - The care plan still narrows, and never widens.
  const allows = (item) => {
    if (item.competency) {
      const byLicense = Array.isArray(item.byLicense) && item.byLicense.includes(level);
      if (!byLicense && !competencies.includes(item.competency)) return false;
    } else if (LEVEL_RANK[item.minLevel] > rank) {
      return false;
    }
    if (authorized && !authorized.has(item.id) && item.id !== 'presence_confirmed') return false;
    return true;
  };

  const taskGroups = TASK_GROUPS
    .map(g => ({ id: g.id, label: g.label, items: g.items.filter(allows).map(i => ({ id: i.id, label: i.label, legacy: i.legacy })) }))
    .filter(g => g.items.length > 0);

  // Same rule: every measurement field is competency-gated, so the competency
  // decides. The CNA floor is gone — a PCA signed off on vital signs records a
  // blood pressure, which is the point of signing them off.
  const measurements = MEASUREMENT_FIELDS.filter(f => {
    const byLicense = Array.isArray(f.byLicense) && f.byLicense.includes(level);
    return byLicense || competencies.includes(f.competency);
  }).map(f => ({ id: f.id, label: f.label, unit: f.unit }));

  const narratives = NARRATIVE_FIELDS.filter(f => LEVEL_RANK[f.minLevel] <= rank)
    .map(f => ({ id: f.id, label: f.label }));

  return {
    level,
    levelLabel: LICENSE_LABELS[level],
    valid: true,
    competencies,
    taskGroups,
    measurements,
    narratives,
    standingInstructions: standingInstructionsFor(client),
    patientConditions: PATIENT_CONDITIONS.slice(),
    safetyConcerns: SAFETY_CONCERNS.map(c => ({ id: c.id, label: c.label, incident: !!c.incident })),
    satisfactionValues: SATISFACTION_VALUES.slice(),
    // An LPN note is a skilled visit note: it lands as Pending Review and goes
    // to the clinician inbox. It does NOT write to OpenEMR in this session.
    // A note is skilled because of WHAT IS IN IT, not who wrote it. Once a
    // competency can be held below LPN (owner rule 2026-09-13), a skilled task
    // documented by a PCA must reach a clinician exactly as an LPN's does —
    // that review IS the licensed oversight the rule relies on. Decided per
    // submission in `skilledContentPresent()`, because a schema that merely
    // OFFERS a skilled task would send every routine ADL log to the inbox.
    submitStatus: level === 'lpn' ? 'pending_review' : 'submitted',
    skilledNote: level === 'lpn',
    // Skilled task ids this caregiver may document at all — the route checks
    // what they actually ticked against this.
    skilledTaskIdsOffered: (taskGroups.find(g => g.id === 'skilled') || { items: [] }).items.map(i => i.id)
  };
}

// The set of task ids the client's care plan authorizes, or null when there is
// no usable plan (→ no narrowing). Reads the 4.1 care-plan shape
// (`client.carePlan.tasks`), accepting either task ids or free-text labels.
function authorizedTaskIds(client) {
  const plan = client && client.carePlan && typeof client.carePlan === 'object' ? client.carePlan : null;
  const rows = plan && Array.isArray(plan.tasks) ? plan.tasks : null;
  if (!rows || rows.length === 0) return null;
  const byId = new Map();
  const byLabel = new Map();
  for (const g of TASK_GROUPS) {
    for (const i of g.items) {
      byId.set(i.id, i.id);
      byLabel.set(i.label.toLowerCase(), i.id);
      if (i.legacy) byId.set(i.legacy, i.id);
    }
  }
  const out = new Set();
  for (const row of rows) {
    const raw = typeof row === 'string' ? row : (row && (row.taskId || row.id || row.task || row.label || row.name));
    if (!raw) continue;
    const key = String(raw).trim();
    const hit = byId.get(key) || byLabel.get(key.toLowerCase());
    if (hit) out.add(hit);
  }
  // A plan we could not map to a single known task tells us nothing useful;
  // narrowing to an empty set would blank the form, so we do not narrow.
  return out.size > 0 ? out : null;
}

// Standing instructions the client's plan has active, or the full list when the
// plan carries none (the caregiver acknowledges what applies).
function standingInstructionsFor(client) {
  const plan = client && client.carePlan && typeof client.carePlan === 'object' ? client.carePlan : null;
  const active = plan && Array.isArray(plan.standingInstructions) ? plan.standingInstructions : null;
  if (!active || active.length === 0) return STANDING_INSTRUCTIONS.slice();
  const wanted = new Set(active.map(v => String(typeof v === 'string' ? v : (v.id || v.label || '')).trim().toLowerCase()));
  const hits = STANDING_INSTRUCTIONS.filter(s => wanted.has(s.id) || wanted.has(s.label.toLowerCase()));
  return hits.length > 0 ? hits : STANDING_INSTRUCTIONS.slice();
}

// True when the sanitized submission records a skilled task as DONE. Such a
// note routes to the clinician inbox whatever the author's licence level: the
// task was performed under licensed oversight, so the licensed person has to
// see it. Reads the sanitized payload, never the raw body — a task the schema
// dropped is not in here to be counted.
function skilledContentPresent(clean) {
  const tasks = (clean && clean.tasks) || {};
  return SKILLED_TASK_IDS.some(id => tasks[id] && tasks[id].done === true);
}

// ============================================================================
// sanitizeVisitLogSubmission — the control, not the styling
// ============================================================================
// Takes what the client sent and returns ONLY what the schema offered. A
// skilled task id posted by a PCA's browser (or by curl) does not land in the
// stored record at all — it is absent, so no later reader can mistake it for
// something that happened. Rejected keys are reported so the caller can audit
// the attempt rather than silently swallowing it.
function sanitizeVisitLogSubmission(schema, raw) {
  const body = raw && typeof raw === 'object' ? raw : {};
  const rejected = [];

  const allowedTasks = new Set();
  for (const g of schema.taskGroups || []) for (const i of g.items) allowedTasks.add(i.id);
  const allowedMeasurements = new Set((schema.measurements || []).map(f => f.id));
  const allowedNarratives = new Set((schema.narratives || []).map(f => f.id));
  const allowedStanding = new Set((schema.standingInstructions || []).map(s => s.id));
  const allowedConditions = new Set((schema.patientConditions || []).map(c => c.id));
  const allowedSafety = new Set((schema.safetyConcerns || []).map(c => c.id));

  // Tasks: { taskId: { done: bool, note: string } } or an array of ids.
  const tasks = {};
  const rawTasks = body.tasks;
  if (Array.isArray(rawTasks)) {
    for (const id of rawTasks) {
      const key = String(id || '');
      if (allowedTasks.has(key)) tasks[key] = { done: true, note: '' };
      else if (key) rejected.push(`tasks.${key}`);
    }
  } else if (rawTasks && typeof rawTasks === 'object') {
    for (const [key, val] of Object.entries(rawTasks)) {
      if (!allowedTasks.has(key)) { rejected.push(`tasks.${key}`); continue; }
      const done = val === true || (val && val.done === true);
      if (!done && !(val && val.note)) continue;
      tasks[key] = { done: !!done, note: trimText(val && val.note, 500) };
    }
  }

  const measurements = {};
  const rawMeasurements = body.measurements && typeof body.measurements === 'object' ? body.measurements : {};
  for (const [key, val] of Object.entries(rawMeasurements)) {
    if (!allowedMeasurements.has(key)) { rejected.push(`measurements.${key}`); continue; }
    const text = trimText(val, 40);
    if (text) measurements[key] = text;
  }

  const narratives = {};
  const rawNarratives = body.narratives && typeof body.narratives === 'object' ? body.narratives : {};
  for (const [key, val] of Object.entries(rawNarratives)) {
    if (!allowedNarratives.has(key)) { rejected.push(`narratives.${key}`); continue; }
    const text = trimText(val, 4000);
    if (text) narratives[key] = text;
  }

  const pickIds = (input, allowed, label) => {
    const out = [];
    for (const v of Array.isArray(input) ? input : []) {
      const key = String(v || '');
      if (allowed.has(key)) { if (!out.includes(key)) out.push(key); }
      else if (key) rejected.push(`${label}.${key}`);
    }
    return out;
  };

  const satisfaction = SATISFACTION_VALUES.includes(body.satisfaction) ? body.satisfaction : null;

  return {
    clean: {
      tasks,
      measurements,
      narratives,
      standingInstructionsAcknowledged: pickIds(body.standingInstructionsAcknowledged, allowedStanding, 'standingInstructions'),
      patientCondition: pickIds(body.patientCondition, allowedConditions, 'patientCondition'),
      safetyConcerns: pickIds(body.safetyConcerns, allowedSafety, 'safetyConcerns'),
      satisfaction,
      visitType: trimText(body.visitType, 80) || 'Visit'
    },
    rejected
  };
}

const trimText = (v, max) => {
  if (v === null || v === undefined) return '';
  return String(v).trim().slice(0, max);
};

// ============================================================================
// Escalation (spec §4)
// ============================================================================
// The caregiver picks ONE thing — the concern type. Severity is derived, and
// routing is derived from the patient's care team. A caregiver should never
// have to know who to notify; that is the whole point of the feature.
const CONCERN_TYPES = Object.freeze(['clinical', 'behavioral', 'safety_urgent']);

const CONCERN_META = Object.freeze({
  clinical: { label: 'Clinical', severity: 'standard', channels: ['in_app', 'push'], requiresDescription: false },
  behavioral: { label: 'Behavioral', severity: 'standard', channels: ['in_app', 'push'], requiresDescription: false },
  safety_urgent: { label: 'Safety — urgent', severity: 'urgent', channels: ['in_app', 'push', 'sms'], requiresDescription: true }
});

const normalizeConcernType = (v) => {
  const t = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CONCERN_TYPES.includes(t) ? t : null;
};

const severityForConcernType = (t) => {
  const type = normalizeConcernType(t);
  return type ? CONCERN_META[type].severity : null;
};

// Escalation status lifecycle — tracked, timestamped, immutable trail.
const ESCALATION_STATUSES = Object.freeze(['raised', 'received', 'acknowledged', 'action_taken', 'resolved']);
const ESCALATION_TRANSITIONS = Object.freeze({
  raised: ['received'],
  received: ['acknowledged'],
  acknowledged: ['action_taken', 'resolved'],
  action_taken: ['resolved'],
  resolved: []
});
const canAdvanceEscalation = (from, to) =>
  (ESCALATION_TRANSITIONS[from] || []).includes(to);

// Statuses that require a note from the recipient (spec §4: "+ note").
const ESCALATION_NOTE_REQUIRED = Object.freeze(['action_taken', 'resolved']);

// Route an escalation off the patient's careTeam.
//   Clinical      → assigned FNP(s)
//   Behavioral    → case manager
//   Safety-urgent → FNP(s) + case manager + admin
// Admin always has VISIBILITY; admins are only NOTIFIED on urgent.
//
// `users` is the full user list. Returns the actual people, by name, because
// the confirmation names them — a generic "sent" toast is exactly what this
// replaces. When the care team has nobody for the type, routing falls back to
// admin and says so; an unrouted concern must never look delivered.
function routeEscalation({ concernType, client, users }) {
  const type = normalizeConcernType(concernType);
  if (!type) return { valid: false, reason: 'INVALID_CONCERN_TYPE' };

  const all = Array.isArray(users) ? users : [];
  const byId = new Map(all.filter(u => u && u.id).map(u => [u.id, u]));
  const person = (u, why) => ({ id: u.id, name: u.name || u.email, email: u.email || null, role: roleLabelFor(u), reason: why });

  const careTeam = (client && client.careTeam) || {};
  const fnps = (Array.isArray(careTeam.assignedFNPs) ? careTeam.assignedFNPs : [])
    .map(id => byId.get(id)).filter(Boolean).map(u => person(u, 'assigned_fnp'));
  const cm = careTeam.assignedCaseManager ? byId.get(careTeam.assignedCaseManager) : null;
  const caseManagers = cm ? [person(cm, 'assigned_case_manager')] : [];
  const admins = all.filter(u => u && u.role === 'admin' && u.accountStatus !== 'inactive')
    .map(u => person(u, 'admin'));

  let notify = [];
  if (type === 'clinical') notify = fnps;
  else if (type === 'behavioral') notify = caseManagers;
  else notify = fnps.concat(caseManagers, admins);

  // Nobody on the care team for this type → admin, flagged.
  let fallbackToAdmin = false;
  if (notify.length === 0) {
    notify = admins.map(a => ({ ...a, reason: 'admin_fallback' }));
    fallbackToAdmin = true;
  }

  notify = dedupeById(notify);
  // Admin has visibility on everything, whether or not they were paged.
  const visibility = dedupeById(notify.concat(admins));

  return {
    valid: true,
    concernType: type,
    label: CONCERN_META[type].label,
    severity: CONCERN_META[type].severity,
    channels: CONCERN_META[type].channels.slice(),
    requiresDescription: CONCERN_META[type].requiresDescription,
    notify,
    visibility,
    fallbackToAdmin,
    unrouted: notify.length === 0
  };
}

const dedupeById = (rows) => {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
};

const roleLabelFor = (u) => {
  if (!u) return '';
  if (u.role === 'admin') return 'admin';
  if (u.role === 'caseManager') return 'case manager';
  if (u.hasClinicalAccess) return u.licenseLevel ? String(u.licenseLevel).toUpperCase() : 'FNP';
  if (u.role === 'vendor') return 'caregiver';
  return u.role || '';
};

// "Sent to Courtney, case manager, and Bethel, FNP" — the confirmation text.
// Naming the humans is the feature; do not replace this with a generic toast.
function describeRecipients(recipients) {
  const parts = (recipients || []).map(r => r.role ? `${r.name}, ${r.role}` : r.name).filter(Boolean);
  if (parts.length === 0) return 'no one — this concern could not be routed';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function escalationConfirmation(routing) {
  const who = describeRecipients(routing.notify);
  if (routing.fallbackToAdmin) {
    return `No ${routing.concernType === 'behavioral' ? 'case manager' : 'clinician'} is assigned to this client, so this went to ${who}.`;
  }
  return `Sent to ${who}.`;
}

// ============================================================================
// RBAC (spec §5) — a caregiver sees only their assigned clients
// ============================================================================
// Two links exist and both are honored, because the repo carries both:
//   - vendor.assignedClients (the existing picker, which stores client NAMES
//     for vendors and ids elsewhere — accept either rather than assume)
//   - client.careTeam.primaryCaregiver / backupCaregiver (the §5 link, ids)
// Anything not explicitly assigned is denied.
function isAssignedToCaregiver(caregiver, client) {
  if (!caregiver || !client) return false;
  const assigned = Array.isArray(caregiver.assignedClients) ? caregiver.assignedClients.map(String) : [];
  if (assigned.includes(String(client.id))) return true;
  if (client.name && assigned.includes(String(client.name))) return true;
  const team = client.careTeam || {};
  if (team.primaryCaregiver && String(team.primaryCaregiver) === String(caregiver.id)) return true;
  if (team.backupCaregiver && String(team.backupCaregiver) === String(caregiver.id)) return true;
  return false;
}

const isCaregiver = (user) =>
  !!user && user.role === 'vendor' && !!normalizeLevel(user.licenseLevel);

// What a caregiver may see of a client. Spec §5: read-only care plan and
// behavioral protocols, RELEVANT SECTIONS ONLY. Never clinical notes, never
// rates or billing, never another caregiver's notes, never provider-to-family
// communication. This is an allow-list: a field added to the client record
// later does not leak by default.
const CAREGIVER_CLIENT_FIELDS = Object.freeze([
  'id', 'name', 'careTier', 'careTierLabel', 'serviceLine', 'address', 'phone'
]);
const CAREGIVER_CARE_PLAN_FIELDS = Object.freeze([
  'version', 'effectiveDate', 'targetDate', 'goals', 'tasks', 'frequency', 'days', 'times', 'duration'
]);
// Explicitly withheld from the caregiver view, and build-enforced. `chargeNote`
// and every rate field are money; `problems`, `rnSignature` and the narrative
// are clinical.
const CAREGIVER_FORBIDDEN_FIELDS = Object.freeze([
  'chargeNote', 'rateAgreement', 'payer', 'billing', 'rate', 'problems',
  'rnSignature', 'clinicalNotes', 'note', 'intake', 'consents', 'password',
  'openEmrPatientId', 'messages'
]);

function caregiverClientView(client) {
  if (!client) return null;
  const out = {};
  for (const key of CAREGIVER_CLIENT_FIELDS) {
    if (client[key] !== undefined) out[key] = client[key];
  }
  const plan = client.carePlan && typeof client.carePlan === 'object' ? client.carePlan : null;
  if (plan) {
    const view = {};
    for (const key of CAREGIVER_CARE_PLAN_FIELDS) {
      if (plan[key] !== undefined) view[key] = plan[key];
    }
    out.carePlan = view;
  } else {
    out.carePlan = null;
  }
  // Behavioral protocols are what the caregiver most needs and are not clinical
  // narrative — they are the standing instructions for handling this client.
  out.behavioralProtocols = Array.isArray(client.behavioralProtocols) ? client.behavioralProtocols : [];
  out.standingInstructions = standingInstructionsFor(client);
  return out;
}

// ============================================================================
// Idempotency (offline submit → sync on reconnect without duplication)
// ============================================================================
// Scoped PER USER so two caregivers cannot collide on a client-generated key,
// and so a stolen key cannot address another caregiver's row.
const idempotencyKeyFor = (userId, key) => {
  const raw = String(key || '').trim().slice(0, 120);
  if (!raw) return null;
  return `${userId}:${raw}`;
};

// ---- Incident reports (spec §3a / §6) ----
// A fall or an abuse/neglect observation is its own reportable record, not a
// checkbox buried in a daily note.
function incidentsFromSubmission(clean) {
  const flagged = (clean && Array.isArray(clean.safetyConcerns) ? clean.safetyConcerns : [])
    .filter(id => INCIDENT_SAFETY_CONCERNS.includes(id));
  return flagged.map(id => ({
    kind: id,
    label: (SAFETY_CONCERNS.find(c => c.id === id) || {}).label || id
  }));
}

module.exports = {
  LICENSE_LEVELS, LICENSE_LABELS, LEVEL_RANK, normalizeLevel,
  COMPETENCIES, COMPETENCY_LABELS, verifiedCompetencies,
  MAX_PAY_RATE, normalizePayRate, normalizeClientPayRates, resolvePayRate,
  TASK_GROUPS, RESTRICTED_TASK_IDS, SKILLED_TASK_IDS,
  STANDING_INSTRUCTIONS, PATIENT_CONDITIONS, SAFETY_CONCERNS, INCIDENT_SAFETY_CONCERNS,
  MEASUREMENT_FIELDS, NARRATIVE_FIELDS, SATISFACTION_VALUES, VISIT_LOG_STATUSES,
  visitLogSchemaFor, authorizedTaskIds, standingInstructionsFor, sanitizeVisitLogSubmission, skilledContentPresent,
  CONCERN_TYPES, CONCERN_META, normalizeConcernType, severityForConcernType,
  ESCALATION_STATUSES, ESCALATION_TRANSITIONS, ESCALATION_NOTE_REQUIRED, canAdvanceEscalation,
  routeEscalation, describeRecipients, escalationConfirmation,
  isAssignedToCaregiver, isCaregiver, caregiverClientView,
  CAREGIVER_CLIENT_FIELDS, CAREGIVER_CARE_PLAN_FIELDS, CAREGIVER_FORBIDDEN_FIELDS,
  idempotencyKeyFor, incidentsFromSubmission
};
