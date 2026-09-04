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

// OpenEMR's SOAP validator accepts an empty section but rejects a 1-character
// one (lengthBetween 2..65535, answered as HTTP 200 + a validation map). Treat
// a lone character as empty so a stray keystroke can never lose the note.
const soapSection = (v, max) => {
  const t = String(v == null ? '' : v).trim().slice(0, max);
  return t.length < 2 ? '' : t;
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
    subjective: soapSection(form.subjective || form.chiefConcern, 8000),
    objective: objective.slice(0, 16000),
    assessment: soapSection(form.assessment, 8000),
    plan: [soapSection(form.plan, 8000),
      form.triage && form.triage.track ? `RN Track assignment: ${form.triage.track}${form.triage.rationale ? ` — ${form.triage.rationale}` : ''}` : '',
      clinicianName ? `Documented by ${clinicianName}` : '']
      .filter(Boolean).join('\n').slice(0, 8000)
  };
  return { encounter, vitals, soapNote };
};

// Valid Track assignments the RN can set from the H&P triage step.
const VALID_TRACKS = ['A1', 'A2', 'A3', 'A4', 'B'];

// ============================================================
// Clinical scheduling (Session 4.2) — pure helpers
//
// OpenEMR is the single appointment ledger. These helpers build the standard-
// REST payloads and derive view state from LIVE OpenEMR rows; nothing here
// stores appointment data app-side. OpenEMR 7.0.4's API is create/delete only
// (no update route — verified against the dev instance), so reschedule/cancel
// use the TOMBSTONE SWAP approved 08/2026: post the replacement row(s) FIRST
// — including a cancelled ('x') tombstone that preserves the original slot —
// and delete the superseded active row LAST, so no information ever leaves
// the calendar and a mid-swap failure leaves a visible duplicate, never a gap.
// ============================================================

// OpenEMR pc_apptstatus values this build uses. 'x' (cancelled) and '?'
// (no-show) rows never block a slot.
const APPT_STATUS = { none: '-', cancelled: 'x', noShow: '?' };
const APPT_LOCATIONS = ['home', 'telehealth', 'office'];
const APPT_MIN_MINUTES = 5;
const APPT_MAX_MINUTES = 8 * 60;

const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTimeStr = (s) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(s || ''));
const timeToMinutes = (t) => {
  const [h, m] = String(t || '').split(':').map(n => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
};
const minutesToTime = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

// A row's duration in minutes — pc_duration (seconds) when present, else the
// start→end span (the list endpoint omits pc_duration).
const rowDurationMinutes = (row) => {
  if (row && row.pc_duration) return Math.round(Number(row.pc_duration) / 60) || 0;
  if (row && row.pc_startTime && row.pc_endTime) {
    return Math.max(0, timeToMinutes(row.pc_endTime) - timeToMinutes(row.pc_startTime));
  }
  return 0;
};

// The structured location marker lives in OpenEMR (pc_hometext first line), so
// the flag round-trips through the EMR rather than a second app-side store.
const LOCATION_MARKER = /^\[GFC location=([a-z]+)\]\n?/;
const encodeAppointmentNotes = (location, notes) =>
  `[GFC location=${location}]${notes ? `\n${String(notes).slice(0, 2000)}` : ''}`;
const decodeAppointmentNotes = (hometext) => {
  const s = String(hometext || '');
  const m = s.match(LOCATION_MARKER);
  return { location: m ? m[1] : null, notes: s.replace(LOCATION_MARKER, '').trim() || null };
};

// Validate + normalize a create/reschedule request into OpenEMR POST fields.
// `defaults` carries the instance config (category, facility).
const buildAppointmentFields = (input, defaults) => {
  const i = input || {};
  if (!isDateStr(i.date)) return { error: 'date must be YYYY-MM-DD', code: 'APPT_BAD_DATE' };
  if (!isTimeStr(i.startTime)) return { error: 'startTime must be HH:MM (24h)', code: 'APPT_BAD_TIME' };
  const minutes = parseInt(i.durationMinutes, 10);
  if (!Number.isInteger(minutes) || minutes < APPT_MIN_MINUTES || minutes > APPT_MAX_MINUTES) {
    return { error: `durationMinutes must be ${APPT_MIN_MINUTES}–${APPT_MAX_MINUTES}`, code: 'APPT_BAD_DURATION' };
  }
  const providerId = String(i.providerId || '').trim();
  if (!/^\d+$/.test(providerId)) return { error: 'providerId (OpenEMR numeric id) is required', code: 'APPT_NO_PROVIDER' };
  const location = APPT_LOCATIONS.includes(i.location) ? i.location : 'home';
  const title = String(i.title || 'Clinical visit').trim().slice(0, 150) || 'Clinical visit';
  return {
    fields: {
      pc_catid: String(i.categoryId || (defaults && defaults.categoryId) || '5'),
      pc_title: title,
      pc_duration: String(minutes * 60),
      pc_hometext: encodeAppointmentNotes(location, i.notes),
      pc_apptstatus: APPT_STATUS.none,
      pc_eventDate: i.date,
      pc_startTime: i.startTime.slice(0, 5),
      pc_facility: String((defaults && defaults.facilityId) || '3'),
      pc_billing_location: String((defaults && defaults.facilityId) || '3'),
      pc_aid: providerId
    },
    minutes, location, title
  };
};

// Slot conflict against LIVE OpenEMR rows (the availability authority).
// Returns the first overlapping active row for the same provider/date, or null.
const findAppointmentConflict = (rows, { providerId, date, startTime, durationMinutes, ignoreEids }) => {
  const ignore = new Set((ignoreEids || []).map(String));
  const start = timeToMinutes(startTime);
  const end = start + durationMinutes;
  for (const row of rows || []) {
    if (!row || ignore.has(String(row.pc_eid))) continue;
    if (String(row.pc_aid) !== String(providerId)) continue;
    if (String(row.pc_eventDate) !== String(date)) continue;
    if ([APPT_STATUS.cancelled, APPT_STATUS.noShow].includes(row.pc_apptstatus)) continue;
    const rStart = timeToMinutes(row.pc_startTime);
    const rEnd = rStart + rowDurationMinutes(row);
    if (start < rEnd && rStart < end) return row;
  }
  return null;
};

// Copy the fields OpenEMR's appointment POST accepts out of a read-back row,
// so swap replacements preserve the original slot verbatim.
const rowToPostFields = (row) => ({
  pc_catid: String(row.pc_catid || '5'),
  pc_title: String(row.pc_title || 'Clinical visit'),
  pc_duration: String(rowDurationMinutes(row) * 60),
  pc_hometext: String(row.pc_hometext || ''),
  pc_apptstatus: String(row.pc_apptstatus || APPT_STATUS.none),
  pc_eventDate: String(row.pc_eventDate),
  pc_startTime: String(row.pc_startTime || '').slice(0, 5),
  pc_facility: String(row.pc_facility || '3'),
  pc_billing_location: String(row.pc_billing_location || row.pc_facility || '3'),
  pc_aid: String(row.pc_aid || '')
});

// Cancelled tombstone preserving the superseded slot. Reason is REQUIRED for a
// cancellation (never for the internal reschedule/no-show supersede note).
const buildCancelTombstone = (row, { reason, byName, at, supersededByNote }) => {
  const base = rowToPostFields(row);
  const stamp = supersededByNote
    ? `[${(at || new Date().toISOString())}] ${supersededByNote}`
    : `[CANCELLED ${(at || new Date().toISOString())}${byName ? ` by ${byName}` : ''}] Reason: ${reason}`;
  return {
    ...base,
    pc_apptstatus: APPT_STATUS.cancelled,
    pc_hometext: [base.pc_hometext, stamp].filter(Boolean).join('\n').slice(0, 4000)
  };
};

// Reschedule payloads: the new active row + the tombstone for the old slot.
const buildReschedulePayloads = (row, built, { byName, at }) => {
  const when = at || new Date().toISOString();
  const newRow = {
    ...built.fields,
    pc_aid: built.fields.pc_aid || String(row.pc_aid || ''),
    pc_hometext: [built.fields.pc_hometext,
      `[${when}] Rescheduled from ${row.pc_eventDate} ${String(row.pc_startTime || '').slice(0, 5)}${byName ? ` by ${byName}` : ''}`
    ].filter(Boolean).join('\n').slice(0, 4000)
  };
  const tombstone = buildCancelTombstone(row, {
    at: when, supersededByNote: `Rescheduled to ${built.fields.pc_eventDate} ${built.fields.pc_startTime}${byName ? ` by ${byName}` : ''}`
  });
  return { newRow, tombstone };
};

// Status swap payload (no-show today; the slot itself is preserved).
const buildStatusSwap = (row, status, { byName, at }) => ({
  ...rowToPostFields(row),
  pc_apptstatus: status,
  pc_hometext: [String(row.pc_hometext || ''),
    `[${at || new Date().toISOString()}] Marked ${status === APPT_STATUS.noShow ? 'no-show' : status}${byName ? ` by ${byName}` : ''}`
  ].filter(Boolean).join('\n').slice(0, 4000)
});

// View state for a chart/calendar row given the app-side linkage pointers.
//  documented > cancelled > no_show > scheduled (future) / needs_documentation (past)
const deriveAppointmentState = (row, linkedEncounterUuid, now = new Date()) => {
  if (linkedEncounterUuid) return 'documented';
  if (row.pc_apptstatus === APPT_STATUS.cancelled) return 'cancelled';
  if (row.pc_apptstatus === APPT_STATUS.noShow) return 'no_show';
  const startsAt = new Date(`${row.pc_eventDate}T${row.pc_startTime || '00:00'}`);
  return (!isNaN(startsAt) && startsAt.getTime() < now.getTime()) ? 'needs_documentation' : 'scheduled';
};

// Calendar/chart summary of a raw OpenEMR appointment row.
const summarizeAppointmentRow = (row, linkedEncounterUuid, now) => {
  const { location, notes } = decodeAppointmentNotes(row.pc_hometext);
  return {
    eid: String(row.pc_eid),
    uuid: row.pc_uuid || null,
    date: row.pc_eventDate,
    startTime: String(row.pc_startTime || '').slice(0, 5),
    endTime: String(row.pc_endTime || '').slice(0, 5) ||
      minutesToTime(timeToMinutes(row.pc_startTime) + rowDurationMinutes(row)),
    durationMinutes: rowDurationMinutes(row),
    title: row.pc_title || 'Clinical visit',
    categoryId: row.pc_catid != null ? String(row.pc_catid) : null,
    status: row.pc_apptstatus || APPT_STATUS.none,
    providerId: row.pc_aid != null ? String(row.pc_aid) : null,
    patientPid: row.pid != null ? String(row.pid) : null,
    patientPuuid: row.puuid || null,
    patientName: [row.fname, row.lname].filter(Boolean).join(' ') || null,
    location, notes,
    encounterUuid: linkedEncounterUuid || null,
    state: deriveAppointmentState(row, linkedEncounterUuid, now)
  };
};

// ============================================================
// Clinical completeness P0 (Session 4.4) — pure helpers
//
// Spec: docs/GFC_Clinical_Completeness_Spec_v1.md (rev 1.1). Everything here
// is I/O-free; server.js wires it to the KV store and openemr.js.
//
// Preflight findings this design encodes (OpenEMR 7.0.4, verified live
// 2026-09-04 against the route table and the dev instance):
//   - NO write route exists for prescriptions, procedure orders, or billing/
//     fee-sheet rows, NO encounter sign/close concept, and NO code-table
//     search (FHIR ValueSet serves list_options only). The encounter PUT is
//     blocked by the API user's ACL. So the §2.4 interim applies to ALL of
//     coding, Rx and orders: app-side records (encounter_billing,
//     prescriptions, clinical_orders, encounter_attestations, encounter_addenda)
//     PLUS a machine-parseable structured note on the encounter, rendered by
//     buildStructuredNote() below. The clinician's narrative SOAP note is
//     NEVER rewritten — the structured record is a second note row.
//   - OpenEMR owns the code sets (spec §7). Nothing here is a code list:
//     the validators check FORMAT only; descriptions come from OpenEMR's
//     problem list read-back, the clinician's own prior selections (T2), or
//     what the clinician typed.
// ============================================================

// ---- Code-format validation (format only — OpenEMR owns the code sets) ----
// ICD-10-CM: letter, digit, alnum, optional "." + 1–4 alnum (e.g. E11.9, I10,
// Z79.899). "U" codes exist but are reserved; still accepted by format.
const ICD10_RE = /^[A-Z][0-9][0-9A-Z](\.[0-9A-Z]{1,4})?$/;
const normalizeIcd10 = (raw) => {
  let s = String(raw || '').trim().toUpperCase().replace(/^ICD10:/, '').replace(/\s+/g, '');
  // Accept the undotted form clinicians often type ("E119" → "E11.9")
  if (/^[A-Z][0-9][0-9A-Z][0-9A-Z]{1,4}$/.test(s)) s = `${s.slice(0, 3)}.${s.slice(3)}`;
  return ICD10_RE.test(s) ? s : null;
};
// CPT: 5 chars (4 digits + digit/letter, e.g. 99347, 1111F); HCPCS Level II:
// letter A–V + 4 digits (e.g. G0506). Returns null on anything else.
const classifyServiceCode = (raw) => {
  const s = String(raw || '').trim().toUpperCase();
  if (/^\d{4}[\dA-Z]$/.test(s)) return { code: s, codeType: 'CPT4' };
  if (/^[A-V]\d{4}$/.test(s)) return { code: s, codeType: 'HCPCS' };
  return null;
};
const normalizeNpiValue = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 10 ? d : null;
};

// Default SERVICE-code favorites (spec §2.2): the home-visit E/M range GFC
// bills. Code NUMBERS only, grouped by family — the AMA descriptors are
// copyrighted and live in OpenEMR's fee schedule, not here. Admin-editable
// (clinical_settings.serviceCodeFavorites) — this only seeds an empty list.
// 99343 is omitted: it was deleted in the 2023 E/M revision; an admin can add
// it back if the billing consultant says otherwise.
const DEFAULT_SERVICE_CODE_FAVORITES = Object.freeze([
  ...['99341', '99342', '99344', '99345'].map(code => ({ code, codeType: 'CPT4', label: 'Home visit · new patient' })),
  ...['99347', '99348', '99349', '99350'].map(code => ({ code, codeType: 'CPT4', label: 'Home visit · established patient' }))
]);
const sanitizeServiceFavorites = (list) => {
  const out = []; const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const c = classifyServiceCode(item && item.code);
    if (!c || seen.has(c.code)) continue;
    seen.add(c.code);
    out.push({ ...c, label: String((item && item.label) || '').trim().slice(0, 80) });
  }
  return out.slice(0, 60);
};

// ---- Attribution interim (spec §4) ----
// Every EMR write authenticates as the gfc-app-api service account, so the
// chart must carry the acting clinician itself: name, credential and NPI go
// into the note header, the encounter reason/billing note, and every
// app-side record. Session 5 replaces this with per-user OpenEMR auth.
const actorStamp = (actor) => {
  const name = (actor && actor.name) || 'Unknown clinician';
  const cred = actor && actor.licenseLevel ? `, ${actor.licenseLevel}` : '';
  const npi = normalizeNpiValue(actor && actor.npi);
  return `${name}${cred} (${npi ? `NPI ${npi}` : 'NPI not on file'})`;
};
const actorRecord = (actor) => ({
  id: (actor && actor.id) || null,
  name: (actor && actor.name) || null,
  licenseLevel: (actor && actor.licenseLevel) || null,
  npi: normalizeNpiValue(actor && actor.npi),
  openEmrProviderId: actor && actor.openEmrProviderId ? String(actor.openEmrProviderId) : null
});
const buildAttributionHeader = (actor, serviceAccount) =>
  `[GFC CLINICIAN] ${actorStamp(actor)} — documented via the GFC Care Platform` +
  (serviceAccount ? ` (EMR write attributed to service account "${serviceAccount}"; see spec §4)` : '');

// ---- Follow-up visit (Scope A): shorter SOAP form → Encounter + note ----
// Vitals are optional on a follow-up and, because the OpenEMR vitals REST
// endpoint 500s server-side (OPENEMR_SERVER_DEFECTS_2026-08.md), are ALWAYS
// preserved verbatim in the objective section; the vitals-form write is a
// best-effort extra the caller may attempt.
const FOLLOWUP_VITAL_KEYS = ['bpSys', 'bpDia', 'hr', 'temp', 'rr', 'spo2', 'weight', 'height', 'pain'];
const buildFollowUpWrites = (form, actor, opts) => {
  if (!form || typeof form !== 'object') return { error: 'Visit payload is required', code: 'ENCOUNTER_INVALID' };
  const reason = String(form.reason || '').trim();
  if (!reason) return { error: 'A visit reason is required', code: 'ENCOUNTER_NO_REASON' };
  const v = form.vitals && typeof form.vitals === 'object' ? form.vitals : {};
  const clean = (k) => String(v[k] == null ? '' : v[k]).trim().slice(0, 20);
  const hasVitals = FOLLOWUP_VITAL_KEYS.some(k => clean(k));
  const vitalsLine = hasVitals
    ? `VITALS — BP ${clean('bpSys') || '—'}/${clean('bpDia') || '—'}; HR ${clean('hr') || '—'}; Temp ${clean('temp') || '—'}; RR ${clean('rr') || '—'}; SpO2 ${clean('spo2') || '—'}; Wt ${clean('weight') || '—'}; Ht ${clean('height') || '—'}${clean('pain') ? `; Pain ${clean('pain')}/10` : ''}`
    : null;
  const vitals = hasVitals ? {
    bps: clean('bpSys'), bpd: clean('bpDia'), pulse: clean('hr'), temperature: clean('temp'),
    respiration: clean('rr'), oxygen_saturation: clean('spo2'), weight: clean('weight'), height: clean('height'),
    note: 'Recorded via GFC Care Platform follow-up visit'
  } : null;
  const stamp = actorStamp(actor);
  const date = isDateStr(form.date) ? form.date : new Date().toISOString().slice(0, 10);
  const encounter = {
    date,
    // Encounter record attribution (spec §4): the reason line names the clinician
    reason: `${reason.slice(0, 180)} — ${stamp}`.slice(0, 250),
    class_code: 'HH',
    // Lands in OpenEMR's billing view for back-office staff (set at create —
    // the encounter PUT is ACL-blocked on this instance)
    billing_note: `Rendering clinician: ${stamp}. Coding is recorded by the GFC Care Platform (see the GFC structured note on this encounter).`.slice(0, 500)
  };
  const header = buildAttributionHeader(actor, opts && opts.serviceAccount);
  // OpenEMR's SOAP validator requires ≥2 characters per section it receives.
  const soapNote = {
    subjective: [header, soapSection(form.subjective, 8000)].filter(Boolean).join('\n\n'),
    objective: ([vitalsLine, soapSection(form.objective, 16000)].filter(Boolean).join('\n\n')) || 'No objective findings recorded.',
    assessment: soapSection(form.assessment, 8000) || 'See encounter diagnoses (GFC structured note).',
    plan: [soapSection(form.plan, 8000), `Documented by ${stamp}`].filter(Boolean).join('\n')
  };
  return { encounter, vitals, soapNote, vitalsLine, reason: reason.slice(0, 180) };
};

// ---- Encounter diagnoses + services (spec §2.1–2.3) ----
const DX_SOURCES = ['problem_list', 'favorite', 'manual', 'intake', 'prior_encounter'];
const buildEncounterDiagnoses = (list) => {
  if (!Array.isArray(list)) return { error: 'diagnoses must be an array', code: 'DX_INVALID' };
  const out = []; const seen = new Set();
  for (const d of list) {
    const code = normalizeIcd10(d && d.code);
    if (!code) return { error: `"${d && d.code}" is not a valid ICD-10-CM code format`, code: 'DX_BAD_CODE' };
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      description: String((d && d.description) || '').trim().slice(0, 250),
      source: DX_SOURCES.includes(d && d.source) ? d.source : 'manual',
      problemUuid: d && d.problemUuid ? String(d.problemUuid) : null,
      primary: !!(d && d.primary)
    });
  }
  if (out.length > 20) return { error: 'At most 20 diagnoses per encounter', code: 'DX_TOO_MANY' };
  if (out.length && !out.some(x => x.primary)) out[0].primary = true;
  if (out.filter(x => x.primary).length > 1) out.forEach((x, i) => { x.primary = i === out.findIndex(y => y.primary); });
  return { diagnoses: out };
};
// Every service must link to ≥1 diagnosis ON THIS ENCOUNTER (spec §2.3).
const buildEncounterServices = (list, diagnoses) => {
  if (!Array.isArray(list)) return { error: 'services must be an array', code: 'SVC_INVALID' };
  const dxCodes = new Set((diagnoses || []).map(d => d.code));
  const out = [];
  for (const s of list) {
    const c = classifyServiceCode(s && s.code);
    if (!c) return { error: `"${s && s.code}" is not a valid CPT/HCPCS code format`, code: 'SVC_BAD_CODE' };
    const links = Array.from(new Set((Array.isArray(s.dxLinks) ? s.dxLinks : []).map(normalizeIcd10).filter(Boolean)));
    if (!links.length) return { error: `Service ${c.code} must link to at least one encounter diagnosis`, code: 'SVC_DX_LINK_REQUIRED' };
    const unknown = links.filter(l => !dxCodes.has(l));
    if (unknown.length) return { error: `Service ${c.code} links to ${unknown.join(', ')}, which is not a diagnosis on this encounter`, code: 'SVC_DX_LINK_UNKNOWN' };
    const units = parseInt(s.units, 10);
    out.push({
      ...c,
      label: String(s.label || '').trim().slice(0, 120),
      units: Number.isInteger(units) && units > 0 && units < 100 ? units : 1,
      modifiers: sanitizeStringArray(s.modifiers, 2, 4).map(m => m.toUpperCase()).filter(m => /^[A-Z0-9]{2}$/.test(m)),
      dxLinks: links
    });
  }
  if (out.length > 20) return { error: 'At most 20 service lines per encounter', code: 'SVC_TOO_MANY' };
  return { services: out };
};

// The app-side encounter_billing record (spec §2.4 interim). One per OpenEMR
// encounter; created when the app documents the visit (or lazily when coding
// opens on an older encounter). Billing provider NPI comes from CONFIG — the
// caller passes it; it is never a literal here.
const buildEncounterBillingRecord = ({ id, clientId, puuid, encounterUuid, encounterEid, reason, date, actor, billingNpi, narrativeNoteSid, at }) => ({
  id,
  clientId,
  puuid,
  encounterUuid: String(encounterUuid),
  encounterEid: encounterEid != null ? String(encounterEid) : null,
  reason: String(reason || '').slice(0, 250),
  date: date || null,
  diagnoses: [],
  services: [],
  renderingProvider: actorRecord(actor),
  billingProviderNpi: normalizeNpiValue(billingNpi),
  codingStatus: 'not_coded',
  codedAt: null,
  codedBy: null,
  narrativeNoteSid: narrativeNoteSid != null ? String(narrativeNoteSid) : null,
  structuredNoteSid: null,
  createdAt: at || new Date().toISOString(),
  createdBy: actorRecord(actor),
  updatedAt: at || new Date().toISOString()
});

const deriveCodingStatus = (record) => {
  const dx = (record && record.diagnoses) || [];
  const svc = (record && record.services) || [];
  const missing = [];
  if (!dx.length) missing.push('diagnosis');
  if (!svc.length) missing.push('service');
  else if (svc.some(s => !(s.dxLinks || []).length)) missing.push('service_dx_link');
  return { coded: missing.length === 0, missing };
};

// Apply a coding change (replace dx + svc). Returns a NEW record; the caller
// must have already refused this on a closed encounter (isEncounterClosed).
const applyCoding = (record, { diagnoses, services }, actor, billingNpi, at) => {
  const dx = buildEncounterDiagnoses(diagnoses);
  if (dx.error) return dx;
  const svc = buildEncounterServices(services, dx.diagnoses);
  if (svc.error) return svc;
  const now = at || new Date().toISOString();
  const next = {
    ...record,
    diagnoses: dx.diagnoses,
    services: svc.services,
    renderingProvider: actorRecord(actor),
    billingProviderNpi: normalizeNpiValue(billingNpi) || record.billingProviderNpi || null,
    updatedAt: now
  };
  const status = deriveCodingStatus(next);
  next.codingStatus = status.coded ? 'coded' : 'not_coded';
  next.codedAt = status.coded ? (record.codedAt && record.codingStatus === 'coded' ? record.codedAt : now) : null;
  next.codedBy = status.coded ? actorRecord(actor) : null;
  return { record: next };
};

// ---- Sign & close (spec §3) ----
const SIGN_BLOCKER_CODES = {
  note: 'SIGN_NO_NOTE',
  diagnosis: 'SIGN_NO_DIAGNOSIS',
  service: 'SIGN_NO_SERVICE',
  service_dx_link: 'SIGN_UNLINKED_SERVICE',
  billing_npi: 'SIGN_NO_BILLING_NPI'
};
const SIGN_BLOCKER_LABELS = {
  note: 'a documented note',
  diagnosis: 'at least one ICD-10 diagnosis',
  service: 'at least one CPT/HCPCS service code',
  service_dx_link: 'every service linked to a diagnosis',
  billing_npi: 'the billing provider NPI configured in settings'
};
const checkSignReadiness = ({ hasNote, record, billingNpi }) => {
  const missing = [];
  if (!hasNote) missing.push('note');
  missing.push(...deriveCodingStatus(record).missing);
  if (!normalizeNpiValue(billingNpi)) missing.push('billing_npi');
  return {
    ok: missing.length === 0,
    missing,
    codes: missing.map(m => SIGN_BLOCKER_CODES[m]),
    message: missing.length ? `Cannot sign: the encounter needs ${missing.map(m => SIGN_BLOCKER_LABELS[m]).join(', ')}.` : null
  };
};
const ATTESTATION_TEXT = 'I attest that this encounter documentation is accurate and complete, that I personally performed or directly supervised the services recorded, and that the diagnoses and service codes are supported by the note.';
const buildAttestation = ({ id, record, actor, at, billingNpi, narrativeNoteSid }) => {
  const npi = normalizeNpiValue(actor && actor.npi);
  return {
    id,
    clientId: record.clientId,
    encounterUuid: record.encounterUuid,
    signedAt: at || new Date().toISOString(),
    signedBy: actorRecord(actor),
    attestationText: ATTESTATION_TEXT,
    diagnosisCodes: (record.diagnoses || []).map(d => d.code),
    serviceCodes: (record.services || []).map(s => s.code),
    billingProviderNpi: normalizeNpiValue(billingNpi),
    narrativeNoteSid: narrativeNoteSid != null ? String(narrativeNoteSid) : (record.narrativeNoteSid || null),
    warnings: npi ? [] : ['Signing clinician has no NPI on file — add it in the admin user form before real clinical use (spec §4).']
  };
};
const isEncounterClosed = (attestation) => !!(attestation && attestation.signedAt);
// Corrections after close are addenda: own text, own signer, own timestamp.
const buildAddendum = ({ id, encounterUuid, clientId, text, actor, at }) => {
  const body = String(text || '').trim();
  if (body.length < 3) return { error: 'Addendum text is required', code: 'ADDENDUM_EMPTY' };
  return {
    addendum: {
      id, encounterUuid: String(encounterUuid), clientId,
      text: body.slice(0, 8000),
      at: at || new Date().toISOString(),
      by: actorRecord(actor)
    }
  };
};
const deriveEncounterState = (record, attestation) => {
  if (isEncounterClosed(attestation)) return 'signed';
  if (record && deriveCodingStatus(record).coded) return 'coded';
  return 'not_coded';
};

// ---- Prescription recording (Scope C — record only, no transmission) ----
const RX_ROUTES = ['oral', 'sublingual', 'buccal', 'topical', 'transdermal', 'inhaled', 'intranasal', 'ophthalmic', 'otic', 'rectal', 'vaginal', 'subcutaneous', 'intramuscular', 'intravenous', 'other'];
const RX_KINDS = ['new', 'refill'];
const buildPrescription = ({ id, clientId, puuid, encounterUuid, input, actor, at }) => {
  const i = input || {};
  const drug = String(i.drug || '').trim();
  if (!drug) return { error: 'Drug name is required', code: 'RX_NO_DRUG' };
  const dose = String(i.dose || '').trim();
  if (!dose) return { error: 'Dose is required', code: 'RX_NO_DOSE' };
  const frequency = String(i.frequency || '').trim();
  if (!frequency) return { error: 'Frequency is required', code: 'RX_NO_FREQUENCY' };
  const route = RX_ROUTES.includes(String(i.route || '').toLowerCase()) ? String(i.route).toLowerCase() : null;
  if (!route) return { error: `Route must be one of ${RX_ROUTES.join(', ')}`, code: 'RX_BAD_ROUTE' };
  const quantity = parseInt(i.quantity, 10);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 9999) return { error: 'Quantity must be a whole number greater than 0', code: 'RX_BAD_QUANTITY' };
  const refills = parseInt(i.refills == null || i.refills === '' ? 0 : i.refills, 10);
  if (!Number.isInteger(refills) || refills < 0 || refills > 99) return { error: 'Refills must be 0–99', code: 'RX_BAD_REFILLS' };
  const kind = RX_KINDS.includes(i.kind) ? i.kind : 'new';
  const date = isDateStr(i.date) ? i.date : new Date().toISOString().slice(0, 10);
  return {
    prescription: {
      id, clientId, puuid, encounterUuid: String(encounterUuid),
      kind, drug: drug.slice(0, 150), dose: dose.slice(0, 60), route, frequency: frequency.slice(0, 100),
      quantity, refills, date,
      instructions: String(i.instructions || '').trim().slice(0, 1000),
      prescriber: actorRecord(actor),
      transmission: 'none', // e-prescribing is out of scope by owner decision
      emrMedicationId: null, // OpenEMR medication-list row id once written
      createdAt: at || new Date().toISOString()
    }
  };
};
// The only Rx write OpenEMR 7.0.4 accepts is the medication LIST row
// (title/begdate/enddate/diagnosis), so the sig is packed into the title and
// the full structured Rx stays app-side + in the structured note.
const prescriptionToMedicationRow = (rx) => ({
  title: `${rx.drug} ${rx.dose} ${rx.route} ${rx.frequency} — qty ${rx.quantity}, refills ${rx.refills} (${rx.kind === 'refill' ? 'refill' : 'Rx'} via GFC)`.slice(0, 255),
  begdate: rx.date
});

// ---- Order capture (Scope D — labs / imaging / procedures; no HL7) ----
const ORDER_TYPES = ['lab', 'imaging', 'procedure'];
const ORDER_PRIORITIES = ['routine', 'urgent', 'stat'];
const ORDER_STATUSES = ['ordered', 'sent', 'resulted', 'cancelled'];
// Status is advanced manually by staff. Terminal states never move.
const ORDER_TRANSITIONS = Object.freeze({
  ordered: ['sent', 'resulted', 'cancelled'],
  sent: ['resulted', 'cancelled'],
  resulted: [],
  cancelled: []
});
const buildOrder = ({ id, clientId, puuid, encounterUuid, input, actor, encounterDiagnoses, at }) => {
  const i = input || {};
  if (!ORDER_TYPES.includes(i.orderType)) return { error: `orderType must be one of ${ORDER_TYPES.join(', ')}`, code: 'ORDER_BAD_TYPE' };
  const tests = sanitizeStringArray(i.tests, 200, 30);
  if (!tests.length) return { error: 'At least one test / study is required', code: 'ORDER_NO_TESTS' };
  const priority = ORDER_PRIORITIES.includes(i.priority) ? i.priority : 'routine';
  const dxCodes = new Set((encounterDiagnoses || []).map(d => d.code));
  const diagnosisCodes = Array.from(new Set((Array.isArray(i.diagnosisCodes) ? i.diagnosisCodes : []).map(normalizeIcd10).filter(Boolean)));
  if (!diagnosisCodes.length) return { error: 'Link the order to at least one encounter diagnosis', code: 'ORDER_NO_DIAGNOSIS' };
  const unknown = diagnosisCodes.filter(c => !dxCodes.has(c));
  if (unknown.length) return { error: `${unknown.join(', ')} is not a diagnosis on this encounter — add it to the encounter first`, code: 'ORDER_DX_UNKNOWN' };
  const now = at || new Date().toISOString();
  return {
    order: {
      id, clientId, puuid, encounterUuid: String(encounterUuid),
      orderType: i.orderType, tests, priority, diagnosisCodes,
      notes: String(i.notes || '').trim().slice(0, 2000),
      orderingClinician: actorRecord(actor),
      status: 'ordered',
      statusHistory: [{ status: 'ordered', at: now, by: actorRecord(actor), note: null }],
      transmission: 'manual', // Quest HL7 deferred by owner decision
      createdAt: now,
      updatedAt: now
    }
  };
};
const advanceOrderStatus = (order, next, actor, note, at) => {
  if (!order) return { error: 'Order not found', code: 'ORDER_NOT_FOUND' };
  if (!ORDER_STATUSES.includes(next)) return { error: `Status must be one of ${ORDER_STATUSES.join(', ')}`, code: 'ORDER_BAD_STATUS' };
  const allowed = ORDER_TRANSITIONS[order.status] || [];
  if (!allowed.includes(next)) {
    return { error: `An order that is "${order.status}" cannot move to "${next}"${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' — it is final'}`, code: 'ORDER_BAD_TRANSITION' };
  }
  const now = at || new Date().toISOString();
  return {
    order: {
      ...order,
      status: next,
      statusHistory: [...(order.statusHistory || []), { status: next, at: now, by: actorRecord(actor), note: String(note || '').trim().slice(0, 500) || null }],
      updatedAt: now
    }
  };
};

// ---- Coding assist T1: problem-list carry-forward (spec §8) ----
// Candidates come from the patient's ACTIVE OpenEMR problems (summarized
// Condition rows). Pre-selected = proposed; the clinician disposes by
// unchecking. Problems without an ICD-10 code are listed but NOT pre-selected
// (nothing uncoded can reach the claim) and flagged so the clinician can code
// them.
const buildCandidateDiagnoses = (problemRows) => (problemRows || [])
  .filter(p => p && !/inactive|resolved|remission/i.test(String(p.status || '')))
  .map(p => {
    const code = normalizeIcd10(p.code);
    return {
      code,
      description: String(p.title || '').slice(0, 250),
      source: 'problem_list',
      problemUuid: p.id || null,
      preselected: !!code,
      needsCode: !code
    };
  });

// Fill in codes the EMR read-back drops (this instance's FHIR Condition
// carries only the title — see OPENEMR_SERVER_DEFECTS) from the app's own
// prior encounter_billing records for the patient: a problem whose OpenEMR
// uuid was coded on an earlier encounter gets that code back (and is
// proposed); every other code from earlier encounters is offered, un-checked,
// as a "prior encounter" candidate. Nothing here is a code list — every code
// was chosen by a clinician and written to the chart.
const mergeCandidateSources = (candidates, priorRecords) => {
  const byProblem = new Map();
  const prior = [];
  const sorted = [...(priorRecords || [])].sort((a, b) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
  for (const r of sorted) {
    for (const d of (r && r.diagnoses) || []) {
      if (!d || !d.code) continue;
      if (d.problemUuid && !byProblem.has(d.problemUuid)) byProblem.set(d.problemUuid, d);
      if (!prior.some(x => x.code === d.code)) prior.push(d);
    }
  }
  const out = (candidates || []).map(c => {
    if (!c.code && c.problemUuid && byProblem.has(c.problemUuid)) {
      const d = byProblem.get(c.problemUuid);
      return { ...c, code: d.code, description: c.description || d.description, preselected: true, needsCode: false, codeVia: 'prior_encounter' };
    }
    return c;
  });
  const have = new Set(out.map(c => c.code).filter(Boolean));
  for (const d of prior) {
    if (have.has(d.code)) continue;
    have.add(d.code);
    out.push({ code: d.code, description: d.description || '', source: 'prior_encounter', problemUuid: d.problemUuid || null, preselected: false, needsCode: false });
  }
  return out;
};

// ---- Coding assist T2: per-clinician usage-ranked favorites (spec §8) ----
// Usage rows: { userId, set: 'ICD10'|'CPT4'|'HCPCS', code, description, count, lastUsedAt }
const CODE_SETS = ['ICD10', 'CPT4', 'HCPCS'];
const recordCodeUsage = (rows, { userId, set, code, description, at }) => {
  if (!userId || !CODE_SETS.includes(set) || !code) return rows || [];
  const now = at || new Date().toISOString();
  const list = Array.isArray(rows) ? rows.map(r => ({ ...r })) : [];
  const hit = list.find(r => r.userId === userId && r.set === set && r.code === code);
  if (hit) {
    hit.count = (hit.count || 0) + 1;
    hit.lastUsedAt = now;
    if (description && !hit.description) hit.description = String(description).slice(0, 250);
  } else {
    list.push({ userId, set, code, description: String(description || '').slice(0, 250), count: 1, lastUsedAt: now });
  }
  return list;
};
// Per-clinician only (never global): most used first, then most recent.
const rankFavorites = (rows, userId, set, limit = 15) => (rows || [])
  .filter(r => r && r.userId === userId && r.set === set)
  .sort((a, b) => (b.count || 0) - (a.count || 0) || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')))
  .slice(0, limit)
  .map(r => ({ code: r.code, description: r.description || '', count: r.count || 0, lastUsedAt: r.lastUsedAt || null, source: 'favorite' }));

// ---- Structured note (spec §2.4 interim) — render + parse ----
// A SECOND soap_note row on the encounter, regenerated from the app-side
// records on every change. Block grammar: "[GFC NAME v1]" … "[/GFC NAME]",
// one "key: v1 | v2 | …" record per line. parseGfcBlocks() round-trips it,
// which is what makes it machine-parseable rather than prose.
const GFC_BLOCK_VERSION = 1;
const renderBlock = (name, lines) => [`[GFC ${name} v${GFC_BLOCK_VERSION}]`, ...lines, `[/GFC ${name}]`].join('\n');
const cell = (v) => String(v == null ? '' : v).replace(/\s*\|\s*/g, '/').replace(/\r?\n/g, ' ').trim();
const providerCell = (p) => `${cell(p && p.name) || 'unknown'} | NPI ${(p && p.npi) || 'none'}`;

const renderCodingBlock = (record) => {
  const status = deriveCodingStatus(record);
  return renderBlock('CODING', [
    `encounter: ${cell(record.encounterUuid)}`,
    `status: ${status.coded ? 'coded' : 'not_coded'}`,
    `rendering_provider: ${providerCell(record.renderingProvider)}`,
    `billing_provider_npi: ${record.billingProviderNpi || 'not_configured'}`,
    ...(record.diagnoses || []).map((d, i) => `dx: ${i + 1} | ${d.code} | ${cell(d.description)} | ${d.primary ? 'primary' : 'secondary'}`),
    ...(record.services || []).map(s => `svc: ${s.code} | ${s.codeType} | units ${s.units} | dx ${s.dxLinks.join(',')} | mod ${(s.modifiers || []).join(',') || 'none'}`)
  ]);
};
const renderRxBlock = (prescriptions) => renderBlock('RX', (prescriptions || []).map(r =>
  `rx: ${r.kind} | ${cell(r.drug)} | ${cell(r.dose)} | ${r.route} | ${cell(r.frequency)} | qty ${r.quantity} | refills ${r.refills} | ${r.date} | ${providerCell(r.prescriber)} | record only, not transmitted`));
const renderOrdersBlock = (orders) => renderBlock('ORDERS', (orders || []).map(o =>
  `order: ${o.id} | ${o.orderType} | ${o.priority} | ${cell(o.tests.join('; '))} | dx ${o.diagnosisCodes.join(',')} | status ${o.status} | ${providerCell(o.orderingClinician)} | ${o.createdAt}`));
const renderAttestationBlock = (att) => renderBlock('ATTESTATION', [
  `signed_at: ${att.signedAt}`,
  `signed_by: ${providerCell(att.signedBy)}`,
  `attestation: ${cell(att.attestationText)}`,
  `dx: ${(att.diagnosisCodes || []).join(',')}`,
  `svc: ${(att.serviceCodes || []).join(',')}`,
  'encounter_closed: true | corrections are addenda only'
]);
const renderAddendaBlock = (addenda) => renderBlock('ADDENDA', (addenda || []).flatMap(a => [
  `addendum: ${a.id} | ${a.at} | ${providerCell(a.by)}`,
  `  ${String(a.text || '').replace(/\r?\n/g, '\n  ')}`
]));

const buildStructuredNote = ({ record, prescriptions, orders, attestation, addenda }) => ({
  subjective: '[GFC STRUCTURED RECORD v1] Generated by the GFC Care Platform from its encounter records (coding, prescriptions, orders, attestation). OpenEMR 7.0.4 exposes no billing, prescription, order or sign write API, so this note is the in-chart copy (spec §2.4 interim). The clinician\'s narrative is the separate SOAP note on this encounter. Do not edit this note by hand — it is regenerated on every change.',
  objective: [
    (prescriptions || []).length ? renderRxBlock(prescriptions) : 'No prescriptions recorded on this encounter.',
    (orders || []).length ? renderOrdersBlock(orders) : 'No orders recorded on this encounter.'
  ].join('\n\n'),
  assessment: renderCodingBlock(record),
  plan: [
    attestation ? renderAttestationBlock(attestation) : 'Encounter OPEN — not yet signed and closed.',
    (addenda || []).length ? renderAddendaBlock(addenda) : null
  ].filter(Boolean).join('\n\n')
});

// Parse every "[GFC NAME vN] … [/GFC NAME]" block in a text. Returns
// { NAME: { version, lines, records: [{ key, parts }] } } where parts are the
// " | "-separated cells of "key: …" lines (continuation lines are appended to
// the previous record's `text`).
const parseGfcBlocks = (text) => {
  const out = {};
  const re = /\[GFC ([A-Z_]+) v(\d+)\]\n([\s\S]*?)\n?\[\/GFC \1\]/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const lines = m[3] ? m[3].split('\n') : [];
    const records = [];
    for (const line of lines) {
      const kv = line.match(/^([a-z_]+): ?(.*)$/);
      if (kv) records.push({ key: kv[1], parts: kv[2].split(' | ').map(s => s.trim()), text: '' });
      else if (records.length && /^\s+/.test(line)) records[records.length - 1].text += (records[records.length - 1].text ? '\n' : '') + line.trim();
    }
    out[m[1]] = { version: parseInt(m[2], 10), lines, records };
  }
  return out;
};

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
  VALID_TRACKS,
  // Session 4.2 scheduling
  APPT_STATUS,
  APPT_LOCATIONS,
  buildAppointmentFields,
  findAppointmentConflict,
  buildCancelTombstone,
  buildReschedulePayloads,
  buildStatusSwap,
  deriveAppointmentState,
  summarizeAppointmentRow,
  encodeAppointmentNotes,
  decodeAppointmentNotes,
  rowDurationMinutes,
  // Session 4.4 clinical completeness P0
  normalizeIcd10,
  classifyServiceCode,
  normalizeNpiValue,
  DEFAULT_SERVICE_CODE_FAVORITES,
  sanitizeServiceFavorites,
  actorStamp,
  actorRecord,
  buildAttributionHeader,
  buildFollowUpWrites,
  buildEncounterDiagnoses,
  buildEncounterServices,
  buildEncounterBillingRecord,
  deriveCodingStatus,
  applyCoding,
  SIGN_BLOCKER_CODES,
  checkSignReadiness,
  ATTESTATION_TEXT,
  buildAttestation,
  isEncounterClosed,
  buildAddendum,
  deriveEncounterState,
  RX_ROUTES,
  RX_KINDS,
  buildPrescription,
  prescriptionToMedicationRow,
  ORDER_TYPES,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  buildOrder,
  advanceOrderStatus,
  buildCandidateDiagnoses,
  mergeCandidateSources,
  CODE_SETS,
  recordCodeUsage,
  rankFavorites,
  buildStructuredNote,
  renderCodingBlock,
  parseGfcBlocks
};
