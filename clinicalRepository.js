// ============================================================
// Clinical workspace pure helpers (Session 4.1)
//
// Pure functions only — no I/O, no db. server.js wires them to the KV store
// and openemr.js; the unit tests in test/ exercise them directly so the
// invariants (care-plan versioning starts at 1 and never overwrites history,
// activation requires every checklist step, med-rec merge never drops a row)
// are build-enforced.
// ============================================================

// ---- Care-plan versioning ----
// client.carePlan holds the CURRENT plan (no signature image — that stays in
// the append-only care_plan_versions collection). Versions start at 1 and
// increment; prior versions are retained by the caller in care_plan_versions.
const CARE_PLAN_FIELDS = [
  'problems', 'goals', 'eachVisit', 'visitFrequency', 'visitDays', 'visitTimes',
  'duration', 'chargePlanNote', 'effectiveDate', 'targetDate'
];

const sanitizeStringArray = (v, maxLen = 300, maxItems = 40) =>
  Array.isArray(v) ? v.map(x => String(x || '').trim()).filter(Boolean).slice(0, maxItems).map(s => s.slice(0, maxLen)) : [];

const buildCarePlanVersion = (existingPlan, input, author) => {
  if (!input || typeof input !== 'object') throw new Error('Care plan payload is required');
  const goals = sanitizeStringArray(input.goals);
  const problems = sanitizeStringArray(input.problems);
  if (!goals.length) return { error: 'At least one goal is required', code: 'CARE_PLAN_NO_GOALS' };
  if (!problems.length) return { error: 'At least one problem is required', code: 'CARE_PLAN_NO_PROBLEMS' };

  const version = (existingPlan && typeof existingPlan === 'object' && Number.isInteger(existingPlan.version))
    ? existingPlan.version + 1
    : 1; // versioned, starting at 1 — the Session 3.5 contract

  const plan = {
    version,
    problems,
    goals,
    eachVisit: sanitizeStringArray(input.eachVisit ?? input.tasks),
    visitFrequency: String(input.visitFrequency || '').slice(0, 120),
    visitDays: sanitizeStringArray(input.visitDays, 12, 7),
    visitTimes: String(input.visitTimes || '').slice(0, 120),
    duration: String(input.duration || '').slice(0, 120),
    chargePlanNote: String(input.chargePlanNote || '').slice(0, 2000),
    effectiveDate: input.effectiveDate || null,
    targetDate: input.targetDate || null,
    authoredBy: author && author.name ? String(author.name) : null,
    authoredById: author && author.id ? String(author.id) : null,
    authoredAt: (author && author.at) || new Date().toISOString(),
    // Portal display: visitSchedule is the human summary line the client sees
    visitSchedule: input.visitSchedule
      ? String(input.visitSchedule).slice(0, 240)
      : [input.visitFrequency, sanitizeStringArray(input.visitDays, 12, 7).join('/'), input.visitTimes]
          .filter(Boolean).join(' · ') || null
  };
  return { plan };
};

// ---- Clinical enrollment sequence (v2 §6) ----
// Ordered checklist driving IHPC activation. `manual` steps are marked by
// staff; `derived` steps compute from the record and cannot be hand-set.
const CLINICAL_ENROLLMENT_STEPS = [
  { key: 'payerVerification', label: 'Payer verification', kind: 'manual' },   // manual until B1 automates
  { key: 'recordsRoi',        label: 'Records / Transfer-of-Care ROI', kind: 'derived' },
  { key: 'npaConfirmation',   label: 'NPA / prescriptive authority confirmed', kind: 'manual' },
  { key: 'initialVisit',      label: 'Initial comprehensive visit (H&P)', kind: 'derived' },
  { key: 'carePlan',          label: 'Care plan authored + co-signed', kind: 'derived' },
  { key: 'consents',          label: 'IHPC consents (treat / AOB / practice NPP)', kind: 'derived' }
];
const MANUAL_CHECKLIST_STEPS = CLINICAL_ENROLLMENT_STEPS.filter(s => s.kind === 'manual').map(s => s.key);

// Compute the full checklist state for a client.
//  - manualState: client.clinicalEnrollment.steps ({key: {done, byId, byName, at}})
//  - roiEvents: consent_events rows for this client (3.4 data)
//  - cosignedVersion: latest co-signed care-plan version or null
const deriveClinicalChecklist = ({ client, manualState, roiEvents, isConsentSatisfied }) => {
  const steps = {};
  const manual = manualState || {};
  for (const def of CLINICAL_ENROLLMENT_STEPS) {
    if (def.kind === 'manual') {
      const m = manual[def.key];
      steps[def.key] = { ...def, done: !!(m && m.done), by: (m && m.byName) || null, at: (m && m.at) || null };
    }
  }
  // Records/ROI: satisfied when at least one non-revoked transfer-ROI signing
  // event exists (3.4), or the roiTransfer consent rollup is satisfied.
  const roiOk = (roiEvents || []).some(e => e && !e.revoked_at) ||
    isConsentSatisfied((client.consents || {}).roiTransfer);
  const roiEvent = (roiEvents || []).find(e => e && !e.revoked_at);
  steps.recordsRoi = {
    ...CLINICAL_ENROLLMENT_STEPS[1], done: roiOk,
    by: roiOk ? 'Transfer-of-Care ROI on file' : null,
    at: roiEvent ? (roiEvent.signed_at || null) : null
  };
  // Initial visit: recorded by the H&P submit
  const visit = client.clinicalInitialVisit || null;
  steps.initialVisit = {
    ...CLINICAL_ENROLLMENT_STEPS[3], done: !!visit,
    by: visit ? visit.byName || null : null, at: visit ? visit.at || null : null
  };
  // Care plan: authored AND co-signed at the current version
  const plan = (client.carePlan && typeof client.carePlan === 'object') ? client.carePlan : null;
  const coSign = plan ? (client.carePlanCoSign || {})[`v${plan.version}`] : null;
  steps.carePlan = {
    ...CLINICAL_ENROLLMENT_STEPS[4], done: !!(plan && coSign),
    by: plan ? (coSign ? `v${plan.version} co-signed by ${coSign.name}` : `v${plan.version} awaiting co-signature`) : null,
    at: coSign ? coSign.at : null
  };
  // IHPC consents from 3.2 (signed or signed_offline both satisfy)
  const consents = client.consents || {};
  const ihpcTypes = ['consentToTreat', 'assignmentOfBenefits', 'practiceNpp'];
  const missing = ihpcTypes.filter(t => !isConsentSatisfied(consents[t]));
  steps.consents = {
    ...CLINICAL_ENROLLMENT_STEPS[5], done: missing.length === 0,
    by: missing.length ? `Missing: ${missing.join(', ')}` : 'All three signed', at: null
  };

  const allDone = CLINICAL_ENROLLMENT_STEPS.every(def => steps[def.key] && steps[def.key].done);
  return {
    steps: CLINICAL_ENROLLMENT_STEPS.map(def => steps[def.key]),
    allDone,
    activated: !!(client.clinicalEnrollment && client.clinicalEnrollment.activatedAt),
    activatedAt: (client.clinicalEnrollment && client.clinicalEnrollment.activatedAt) || null,
    activatedBy: (client.clinicalEnrollment && client.clinicalEnrollment.activatedByName) || null
  };
};

// ---- Medication reconciliation ----
// Side-by-side merge of family-reported rows (app) and OpenEMR medication rows.
// Matching is by normalized name prefix; nothing is ever silently dropped —
// every row lands in exactly one bucket.
const normMedName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/)[0] || '';

const buildMedRecView = (familyMeds, emrMeds) => {
  const fam = (familyMeds || []).map((m, i) => ({ ...m, _idx: i, _key: normMedName(m.name || m.title) }));
  const emr = (emrMeds || []).map((m, i) => ({ ...m, _idx: i, _key: normMedName(m.title || m.name) }));
  const matched = [];
  const familyOnly = [];
  const emrMatched = new Set();
  for (const f of fam) {
    const hit = f._key && emr.find(e => e._key === f._key && !emrMatched.has(e._idx));
    if (hit) { emrMatched.add(hit._idx); matched.push({ family: f, emr: hit }); }
    else familyOnly.push(f);
  }
  const emrOnly = emr.filter(e => !emrMatched.has(e._idx));
  return { matched, familyOnly, emrOnly };
};

// Apply a clinician's med-rec resolution to the app-side structured rows.
// Each decision: { action: 'keep'|'add'|'discontinue', med: {name, dose, route, frequency, prescriber, pharmacy} }
const applyMedRecResolution = (decisions) => {
  if (!Array.isArray(decisions)) return { error: 'decisions must be an array' };
  const rows = [];
  for (const d of decisions) {
    if (!d || !d.med || !d.med.name) return { error: 'Every decision needs med.name' };
    if (!['keep', 'add', 'discontinue'].includes(d.action)) return { error: `Unknown med-rec action: ${d.action}` };
    if (d.action !== 'discontinue') {
      rows.push({
        name: String(d.med.name).slice(0, 200),
        dose: String(d.med.dose || '').slice(0, 100),
        route: String(d.med.route || '').slice(0, 60),
        frequency: String(d.med.frequency || '').slice(0, 100),
        prescriber: String(d.med.prescriber || '').slice(0, 120),
        pharmacy: String(d.med.pharmacy || '').slice(0, 120),
        reconciledAt: d.reconciledAt || null
      });
    }
  }
  return { rows };
};

// ---- FHIR display summarizers (for the chart UI) ----
const codeableText = (cc) => {
  if (!cc) return '';
  if (cc.text) return cc.text;
  const c = (cc.coding || [])[0];
  return (c && (c.display || c.code)) || '';
};
const summarizeCondition = (r) => ({
  id: r.id,
  title: codeableText(r.code),
  code: (((r.code || {}).coding || [])[0] || {}).code || null,
  status: codeableText(r.clinicalStatus) || 'unknown',
  onset: r.onsetDateTime || null
});
const summarizeAllergy = (r) => ({
  id: r.id,
  title: codeableText(r.code),
  criticality: r.criticality || null,
  status: codeableText(r.clinicalStatus) || 'active'
});
const summarizeMedicationRequest = (r) => ({
  id: r.id,
  title: codeableText(r.medicationCodeableConcept),
  status: r.status || null,
  authoredOn: r.authoredOn || null,
  instructions: (((r.dosageInstruction || [])[0] || {}).text) || ''
});
const summarizeEncounter = (r) => ({
  id: r.id,
  type: codeableText((r.type || [])[0]) || (r.class && (r.class.display || r.class.code)) || 'Encounter',
  status: r.status || null,
  start: (r.period && r.period.start) || null,
  provider: (((r.participant || [])[0] || {}).individual || {}).display || null
});
const summarizeDocument = (r) => ({
  id: r.id,
  description: r.description || codeableText(r.type) || 'Document',
  date: r.date || null,
  contentType: ((((r.content || [])[0] || {}).attachment) || {}).contentType || null,
  url: ((((r.content || [])[0] || {}).attachment) || {}).url || null
});
const summarizeVitalObservation = (r) => {
  const val = r.valueQuantity
    ? `${r.valueQuantity.value}${r.valueQuantity.unit ? ' ' + r.valueQuantity.unit : ''}`
    : (r.component || []).map(c => `${codeableText(c.code)} ${(c.valueQuantity || {}).value ?? ''}`).join(' / ');
  return { id: r.id, name: codeableText(r.code), value: val, at: r.effectiveDateTime || null };
};

// ---- H&P → OpenEMR payload mapping ----
// Serializes the structured §2C form into the encounter + vitals + SOAP-note
// writes. Pure so the mapping is testable without a live EMR.
const HP_SECTION_LABELS = {
  systemsExam: 'Systems exam',
  skinWound: 'Skin & wound (with measurements)',
  painAssessment: 'Pain assessment (PAINAD-style)',
  homeHazards: 'Home-hazard inventory',
  triage: 'RN triage / Track assignment'
};

const kvLines = (obj) => Object.entries(obj || {})
  .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
  .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}: ${Array.isArray(v) ? v.join(', ') : v}`);

const buildHpWrites = (form, clinicianName) => {
  if (!form || typeof form !== 'object') return { error: 'H&P payload is required' };
  const v = form.vitals || {};
  if (!v.bpRightSys || !v.bpLeftSys) {
    return { error: 'Blood pressure in BOTH arms is required for the initial visit (intake spec §2C)', code: 'HP_BP_BOTH_ARMS' };
  }
  const encounter = {
    date: form.visitDate || new Date().toISOString().slice(0, 10),
    reason: String(form.chiefConcern || 'Initial comprehensive visit (H&P)').slice(0, 250),
    class_code: 'HH' // home health encounter
  };
  // OpenEMR vitals form takes one BP pair — record the HIGHER reading arm
  // (clinical convention) and preserve both arms verbatim in the note.
  const right = parseInt(v.bpRightSys, 10) || 0;
  const left = parseInt(v.bpLeftSys, 10) || 0;
  const useRight = right >= left;
  const vitals = {
    bps: useRight ? v.bpRightSys : v.bpLeftSys,
    bpd: useRight ? (v.bpRightDia || '') : (v.bpLeftDia || ''),
    pulse: v.hr || '',
    temperature: v.temp || '',
    respiration: v.rr || '',
    oxygen_saturation: v.spo2 || '',
    weight: v.weight || '',
    height: v.height || '',
    note: `BP right arm ${v.bpRightSys}/${v.bpRightDia || '—'}; BP left arm ${v.bpLeftSys}/${v.bpLeftDia || '—'}`
  };
  const objective = [
    `VITALS — ${vitals.note}; HR ${v.hr || '—'}; Temp ${v.temp || '—'}; RR ${v.rr || '—'}; SpO2 ${v.spo2 || '—'}; Wt ${v.weight || '—'}; Ht ${v.height || '—'}`,
    ...Object.entries(HP_SECTION_LABELS)
      .filter(([key]) => form[key] && Object.keys(form[key]).length)
      .map(([key, label]) => `${label.toUpperCase()}:\n${kvLines(form[key]).join('\n')}`)
  ].join('\n\n');
  const soapNote = {
    subjective: String(form.subjective || form.chiefConcern || '').slice(0, 8000),
    objective: objective.slice(0, 16000),
    assessment: String(form.assessment || '').slice(0, 8000),
    plan: [String(form.plan || '').trim(),
      form.triage && form.triage.track ? `RN Track assignment: ${form.triage.track}${form.triage.rationale ? ` — ${form.triage.rationale}` : ''}` : '',
      clinicianName ? `Documented by ${clinicianName}` : '']
      .filter(Boolean).join('\n').slice(0, 8000)
  };
  return { encounter, vitals, soapNote };
};

// Valid Track assignments the RN can set from the H&P triage step.
const VALID_TRACKS = ['A1', 'A2', 'A3', 'A4', 'B'];

module.exports = {
  CARE_PLAN_FIELDS,
  buildCarePlanVersion,
  CLINICAL_ENROLLMENT_STEPS,
  MANUAL_CHECKLIST_STEPS,
  deriveClinicalChecklist,
  buildMedRecView,
  applyMedRecResolution,
  summarizeCondition,
  summarizeAllergy,
  summarizeMedicationRequest,
  summarizeEncounter,
  summarizeDocument,
  summarizeVitalObservation,
  buildHpWrites,
  VALID_TRACKS
};
