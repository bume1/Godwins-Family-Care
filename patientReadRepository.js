// ============================================================
// Patient clinical read — pure helpers (Session 4.3)
//
// ARCHITECTURE RULE: read-only, filtered, scoped. A patient (or the family /
// POA the client authorized) sees a CURATED read of their own OpenEMR record.
// Never raw clinician notes, never another patient's data, never OpenEMR's
// native portal. server.js resolves the patient from the authenticated
// session's client record (openEmrPatientId) — NEVER from a request
// parameter — and passes the raw rows through the builders here. Everything
// in this module is I/O-free so the sharing rules are unit-testable.
//
// The three audiences:
//   patient — the client themselves (full curated read)
//   poa     — family user with familyIsPoa (client-equivalent read + acting)
//   family  — non-POA family: read-only, ROI-gated AND subject to the
//             client's sharing settings (SHARING_DEFAULTS below)
//
// Case-manager scoped read (v2 §4 owner decision, 08/2026): /api/clinical/*
// splits into READ routes (admin + clinical + case manager) and WRITE routes
// (admin + clinical). The predicates live here so the split is one reviewable
// rule, build-enforced in test/patient_clinical_read.test.js.
// ============================================================

const AUDIENCES = Object.freeze(['patient', 'poa', 'family']);

// ---- Sharing settings the client (or their POA) controls for NON-POA family ----
// Defaults per the 4.3 prompt: care-plan summary yes, medications no, visit
// summaries at summary level only. Everything else defaults closed except the
// upcoming-visit schedule (a family member coordinating the home visit needs it).
const VISIT_LEVELS = Object.freeze(['none', 'summary', 'full']);
const SHARING_DEFAULTS = Object.freeze({
  carePlan: true,             // care-plan summary (goals + schedule, no charge note)
  visitSummaries: 'summary',  // none | summary (date/provider/reason) | full
  medications: false,
  allergies: false,
  problems: false,
  appointments: true,
  vitals: false
});
const SHARING_BOOL_KEYS = Object.freeze(['carePlan', 'medications', 'allergies', 'problems', 'appointments', 'vitals']);
const normalizeSharing = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of SHARING_BOOL_KEYS) out[k] = k in src ? !!src[k] : SHARING_DEFAULTS[k];
  out.visitSummaries = VISIT_LEVELS.includes(src.visitSummaries) ? src.visitSummaries : SHARING_DEFAULTS.visitSummaries;
  return out;
};

// ---- THE sharing-rule filter (scope B) — one reviewable object ----
// Per section, the ONLY keys that may be serialized at each level. Anything
// not listed is dropped server-side by pickFields(); the UI never sees it.
// `summary` is the non-POA family level; `full` is patient / POA (and family
// only where the client's sharing settings open a section fully).
const FILTER_MAP = Object.freeze({
  visit: {
    full: ['id', 'date', 'provider', 'reason', 'summary', 'followUp', 'status', 'newPrescriptions', 'testsOrdered', 'diagnosesAddressed'],
    summary: ['id', 'date', 'provider', 'reason', 'status']
  },
  medication: { full: ['id', 'name', 'instructions', 'status', 'since'] },
  allergy: { full: ['id', 'name', 'severity', 'status'] },
  problem: { full: ['id', 'name', 'status', 'since'] },
  appointment: { full: ['id', 'date', 'startTime', 'endTime', 'durationMinutes', 'title', 'location', 'provider', 'state'] },
  vital: { full: ['date', 'bloodPressure', 'bloodPressureNote', 'heartRate', 'temperature', 'respiration', 'oxygen', 'weight', 'height', 'pain'] },
  carePlan: {
    full: ['version', 'problems', 'goals', 'eachVisit', 'visitFrequency', 'visitDays', 'visitTimes', 'duration', 'chargePlanNote', 'effectiveDate', 'targetDate',
      'authoredBy', 'authoredAt', 'visitSchedule', 'careTier', 'careTierLabel', 'coSignedAt', 'coSignedBy', 'rnSignedAt', 'rnName', 'updatedAt', 'updatedBy', 'primaryCaregiver', 'careTeam', 'authorizedServices', 'signedPdf'],
    summary: ['version', 'goals', 'eachVisit', 'visitSchedule', 'effectiveDate', 'careTierLabel', 'coSignedAt', 'authoredBy', 'signedPdf']
  }
});

// Fields that must NEVER reach a patient, family, or POA payload, in any
// section. The build-fail test asserts none of these appear in FILTER_MAP.
const CLINICIAN_ONLY_FIELDS = Object.freeze([
  // narrative note content
  'subjective', 'objective', 'assessment', 'plan', 'narrativeNotes', 'narrativeNoteSid',
  // structured-note / billing plumbing (spec §2.4 interim)
  'structuredNoteSid', 'structuredNoteError', 'structuredNoteSyncedAt', 'billingProviderNpi', 'billingNote', 'billing_note',
  'codingStatus', 'codedAt', 'codedBy', 'services', 'serviceCodes', 'diagnosisCodes', 'dxLinks', 'codeType', 'units', 'modifiers',
  // identity / attribution internals
  'npi', 'ipHash', 'attestationText', 'renderingProvider', 'signedBy', 'prescriber', 'orderingClinician', 'signatureImage',
  // EMR keys and raw rows
  'encounterEid', 'eid', 'puuid', 'openEmrPatientId', 'pid', 'patientPid', 'patientPuuid', 'uuid', 'providerId', 'pc_aid', 'pc_hometext', 'hometext', 'notes',
  // operational noise
  'warnings', 'emrWriteError', 'emrMedicationId'
]);

const pickFields = (obj, allow) => {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of allow) if (k in obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};
const filterFor = (section, level) => {
  const map = FILTER_MAP[section];
  if (!map) throw new Error(`Unknown patient-read section: ${section}`);
  const allow = map[level] || (level === 'summary' && map.full ? null : null);
  return allow || [];
};
const filterRow = (section, level, row) => pickFields(row, filterFor(section, level));
const filterRows = (section, level, rows) => (rows || []).map(r => filterRow(section, level, r)).filter(Boolean);

// ---- Access evaluation (schema §6 + owner decisions 2026-08-30) ----
// Pure: the caller supplies the fresh client record and the consent predicate.
// Returns { ok, audience, sharing, sections } or { ok:false, status, code, error }.
const evaluateClinicalReadAccess = ({ reqUser, client, isConsentSatisfied, isClinicalServiceLine }) => {
  if (!reqUser) return { ok: false, status: 401, code: 'UNAUTHENTICATED', error: 'Sign in required' };
  let audience = null;
  if (reqUser.role === 'client') audience = 'patient';
  else if (reqUser.role === 'family') audience = reqUser.familyIsPoa ? 'poa' : 'family';
  else return { ok: false, status: 403, code: 'CLIENT_OR_FAMILY_ONLY', error: 'Client or family access required' };
  if (!client) return { ok: false, status: 404, code: 'NO_CLIENT', error: 'No client record on file' };
  const consents = client.consents || {};
  // Every family login (POA included) stays behind the client's ROI-family
  // consent — the same gate requireEnrolledClient applies. Revocation = the
  // consent no longer satisfied → denied on the very next request.
  if (audience !== 'patient' && !isConsentSatisfied(consents.roiFamily)) {
    return { ok: false, status: 403, code: 'ROI_FAMILY_REQUIRED', error: 'Family access is locked until the Release of Information (family) consent is signed.' };
  }
  if (!isClinicalServiceLine(client.serviceLine)) {
    return { ok: false, status: 403, code: 'CLINICAL_NOT_ON_LINE', error: 'Clinical sections apply to In-Home Primary Care clients only.' };
  }
  if (!client.openEmrPatientId) {
    return { ok: false, status: 403, code: 'CLINICAL_NOT_LINKED', error: 'Your clinical record is not linked yet. Your care team will complete this at your first visit.' };
  }
  if (!isConsentSatisfied(consents.consentToTreat)) {
    return { ok: false, status: 403, code: 'CLINICAL_CONSENT_REQUIRED', error: 'Consent to medical treatment must be on file before clinical information is shared.' };
  }
  const sharing = normalizeSharing(client.sharing);
  return { ok: true, audience, sharing, sections: sectionsFor(audience, sharing) };
};

// Which sections an audience gets, and at what level (none | summary | full).
const sectionsFor = (audience, sharingInput) => {
  const s = normalizeSharing(sharingInput);
  if (audience === 'patient' || audience === 'poa') {
    return { carePlan: 'full', visits: 'full', medications: 'full', allergies: 'full', problems: 'full', appointments: 'full', vitals: 'full' };
  }
  return {
    carePlan: s.carePlan ? 'summary' : 'none',
    visits: s.visitSummaries,
    medications: s.medications ? 'full' : 'none',
    allergies: s.allergies ? 'full' : 'none',
    problems: s.problems ? 'full' : 'none',
    appointments: s.appointments ? 'full' : 'none',
    vitals: s.vitals ? 'full' : 'none'
  };
};

// ---- POA acting identity (spec §4.3) ----
// Every POA action records the POA's OWN name as "<POA> as POA for <client>" —
// in the event record and on any signed PDF. The client's name is never
// presented as the signer when a POA signed.
const poaSignerName = (poaName, clientName) =>
  `${String(poaName || 'Authorized representative').trim()} as POA for ${String(clientName || 'the client').trim()}`;
const buildActingIdentity = (reqUser, client) => {
  const clientName = (client && (client.preferredName || client.name)) || 'Client';
  if (reqUser && reqUser.role === 'family' && reqUser.familyIsPoa) {
    return { isPoa: true, actingFor: client ? client.id : null, signerName: poaSignerName(reqUser.name, client && client.name), signerRole: 'poa', displayName: `${reqUser.name} (POA)` };
  }
  return { isPoa: false, actingFor: null, signerName: clientName, signerRole: 'client', displayName: clientName };
};

// ---- Case-manager scoped read: the ONE rule for the /api/clinical split ----
const canClinicalWrite = (u) => !!u && (u.role === 'admin' || (!!u.hasClinicalAccess && u.role !== 'caseManager'));
const canClinicalRead = (u) => canClinicalWrite(u) || (!!u && u.role === 'caseManager');

// ---- Visit summary (scope A): filtered fields only, plain language ----
// The encounter's app-side record (4.4 encounter_billing) carries the
// clinician's stamp (the visit-stamp fallback for the provider name when FHIR
// Practitioner 403s), coded diagnoses with descriptions, and — when the
// clinician wrote one — a patient-facing summary + follow-up instructions.
// Nothing here reads the narrative SOAP note.
const ORDER_TYPE_LABELS = { lab: 'Lab work', imaging: 'Imaging', procedure: 'Procedure' };
const ORDER_STATUS_LABELS = { ordered: 'ordered', sent: 'sent to the lab', resulted: 'results received', cancelled: 'cancelled' };
// EMR encounter reasons carry the 4.4 attribution suffix (" — Name, cred (NPI …)"); strip it.
const stripAttribution = (reason) => String(reason || '').split(' — ')[0].trim();
const firstWords = (s, n) => String(s || '').split(/\s+/).slice(0, n).join(' ');

const buildVisitSummary = ({ encounterUuid, encounter, record, attestation, prescriptions, orders, providerFallbackName }) => {
  const rec = record || {};
  const date = rec.date || String((encounter && encounter.start) || '').slice(0, 10) || null;
  const provider = (rec.renderingProvider && rec.renderingProvider.name)
    || (encounter && encounter.provider) || providerFallbackName || 'Your care team';
  const reason = stripAttribution(rec.reason || (encounter && encounter.type)) || 'Clinical visit';
  const dx = (rec.diagnoses || []).map(d => (d && d.description) || null).filter(Boolean);
  const rx = (prescriptions || []).map(r => ({
    name: [r.drug, r.dose].filter(Boolean).join(' ') || 'Prescription',
    instructions: [r.route, r.frequency, r.instructions].filter(Boolean).join(' · ') || null
  }));
  const tests = (orders || []).filter(o => o && o.status !== 'cancelled').map(o => ({
    type: ORDER_TYPE_LABELS[o.orderType] || o.orderType || 'Order',
    tests: Array.isArray(o.tests) ? o.tests : [],
    status: ORDER_STATUS_LABELS[o.status] || o.status || 'ordered'
  }));
  const signed = !!(attestation && attestation.signedAt);
  const sentences = [];
  if (rec.patientSummary) sentences.push(String(rec.patientSummary).trim());
  else if (dx.length) sentences.push(`This visit addressed: ${dx.join(', ')}.`);
  if (rx.length) sentences.push(`${rx.length === 1 ? 'A prescription was' : 'Prescriptions were'} recorded: ${rx.map(r => r.name).join(', ')}.`);
  if (tests.length) sentences.push(`${tests.map(t => `${t.type}${t.tests.length ? ` (${t.tests.join(', ')})` : ''} — ${t.status}`).join('; ')}.`);
  if (!sentences.length) sentences.push(signed ? 'Your clinician completed and signed the note for this visit.' : 'Your clinician is still finishing the note for this visit.');
  return {
    id: String(encounterUuid || rec.encounterUuid || (encounter && encounter.id) || ''),
    date, provider, reason,
    summary: sentences.join(' '),
    followUp: rec.followUpInstructions ? String(rec.followUpInstructions).trim() : null,
    status: signed ? 'complete' : 'in_progress',
    newPrescriptions: rx,
    testsOrdered: tests,
    diagnosesAddressed: dx
  };
};

// Clinician-authored patient-facing text (set from the encounter panel).
// Bounded, plain strings; empty clears the field.
const buildPatientFacingFields = (body) => {
  const src = body && typeof body === 'object' ? body : {};
  const clean = (v, max) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };
  return { patientSummary: clean(src.patientSummary, 1000), followUpInstructions: clean(src.followUpInstructions, 600) };
};

// ---- Vitals from the encounter note (server-side vitals defect) ----
// The vitals REST endpoint 500s on this instance, so readings live verbatim in
// the note's objective section in one of two app-written shapes:
//   H&P:       "VITALS — BP right arm 130/80; BP left arm 128/78; HR 72; Temp 98.1; RR 16; SpO2 97; Wt 160; Ht 66"
//   follow-up: "VITALS — BP 128/78; HR 72; Temp —; RR —; SpO2 97; Wt —; Ht —; Pain 3/10"
// Returns null when no reading is present → the section is OMITTED, never an
// empty panel. Only the parsed numbers leave the server; the note text does not.
const parseVitalsFromNote = (objectiveText, date) => {
  const t = String(objectiveText || '');
  const line = (t.match(/VITALS\s*—\s*([^\n]*)/) || [])[1];
  if (!line) return null;
  const val = (label) => {
    const m = line.match(new RegExp(`(?:^|;)\\s*${label}\\s+([^;]+)`, 'i'));
    const v = m ? m[1].trim() : '';
    return v && v !== '—' ? v : null;
  };
  const arm = (side) => { const m = line.match(new RegExp(`BP ${side} arm (\\d{2,3})\\/(\\d{2,3})`, 'i')); return m ? { sys: Number(m[1]), dia: Number(m[2]), text: `${m[1]}/${m[2]}` } : null; };
  const right = arm('right'); const left = arm('left');
  let bloodPressure = null; let bloodPressureNote = null;
  if (right || left) {
    const higher = (right && left) ? (right.sys >= left.sys ? right : left) : (right || left);
    bloodPressure = higher.text;
    bloodPressureNote = [right && `right arm ${right.text}`, left && `left arm ${left.text}`].filter(Boolean).join(' · ');
  } else {
    const m = line.match(/(?:^|;)\s*BP\s+(\d{2,3})\/(\d{2,3})/i);
    if (m) bloodPressure = `${m[1]}/${m[2]}`;
  }
  const pain = (line.match(/Pain\s+(\d{1,2})\/10/i) || [])[1] || null;
  const out = {
    date: date || null,
    bloodPressure, bloodPressureNote,
    heartRate: val('HR'), temperature: val('Temp'), respiration: val('RR'),
    oxygen: val('SpO2'), weight: val('Wt'), height: val('Ht'), pain
  };
  const hasReading = ['bloodPressure', 'heartRate', 'temperature', 'respiration', 'oxygen', 'weight', 'height', 'pain'].some(k => out[k]);
  return hasReading ? out : null;
};

// ---- Upcoming appointments: LIVE rows only, never tombstones ----
// Works on the 4.2 summarized rows (state derived from pc_apptstatus + the
// encounter linkage). A reschedule leaves a cancelled ('x') tombstone and a
// no-show a '?' row; neither is a patient's appointment any more.
const selectUpcomingAppointments = (summaries, now = new Date()) => {
  const today = now.toISOString().slice(0, 10);
  return (summaries || [])
    .filter(a => a && a.state === 'scheduled' && a.status !== 'x' && a.status !== '?' && String(a.date || '') >= today)
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
};
const LOCATION_LABELS = { home: 'Your home', telehealth: 'Video / phone visit', office: 'Office visit' };
const summarizeAppointmentForPatient = (a, providerName) => ({
  id: String(a.eid),
  date: a.date, startTime: a.startTime, endTime: a.endTime, durationMinutes: a.durationMinutes,
  title: a.title || 'Clinical visit',
  location: LOCATION_LABELS[a.location] || 'Your home',
  provider: providerName || 'Your care team',
  state: a.state
});

// ---- Patient-friendly presentation of FHIR summaries (4.1 read path) ----
const summarizeMedicationForPatient = (m) => ({
  id: String(m.id), name: m.title || 'Medication', instructions: m.instructions || null,
  status: m.status || null, since: m.authoredOn ? String(m.authoredOn).slice(0, 10) : null
});
const summarizeAllergyForPatient = (a) => ({
  id: String(a.id), name: a.title || 'Allergy', severity: a.criticality || null, status: a.status || null
});
const summarizeProblemForPatient = (p) => ({
  id: String(p.id), name: p.title || 'Condition', status: p.status || null, since: p.onset ? String(p.onset).slice(0, 10) : null
});

module.exports = {
  AUDIENCES, VISIT_LEVELS, SHARING_DEFAULTS, normalizeSharing,
  FILTER_MAP, CLINICIAN_ONLY_FIELDS, pickFields, filterFor, filterRow, filterRows,
  evaluateClinicalReadAccess, sectionsFor,
  poaSignerName, buildActingIdentity,
  canClinicalWrite, canClinicalRead,
  buildVisitSummary, buildPatientFacingFields, stripAttribution,
  parseVitalsFromNote,
  selectUpcomingAppointments, summarizeAppointmentForPatient, LOCATION_LABELS,
  summarizeMedicationForPatient, summarizeAllergyForPatient, summarizeProblemForPatient
};
