// ============================================================
// Patient clinical read — pure helpers (Session 4.3)
//
// ARCHITECTURE RULE: read-only, filtered, scoped. A patient (or the family /
// POA the client authorized) sees a CURATED read of their own record. Never
// another patient's data, never OpenEMR's native portal. server.js resolves
// the patient from the authenticated session's client record — NEVER from a
// request parameter. Everything in this module is I/O-free so the sharing
// rules are unit-testable.
//
// Portal P1 (owner, 2026-09-29): the rows now come from the PUBLISHED copies
// (patientPublish.js), written when a clinician signs — patients never read
// OpenEMR. The audience and sharing rules below did not change.
//
// NOTES ACCESS (owner decision 2026-09-29, reversing the 4.3 rule that a
// narrative note is never shown to a patient): the SIGNED note reaches the
// patient and a POA, and non-POA family only when the client shares full
// visit summaries. It travels in ONE section, `note`, and nowhere else — the
// build-fail test asserts the note-content fields appear in no other section.
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

const clinicalRoles = require('./clinicalRoles');

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
  vitals: false,
  results: false              // test results (Portal P1): closed to non-POA family by default
});
const SHARING_BOOL_KEYS = Object.freeze(['carePlan', 'medications', 'allergies', 'problems', 'appointments', 'vitals', 'results']);
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
    full: ['id', 'date', 'provider', 'reason', 'overview', 'summary', 'followUp', 'status', 'newPrescriptions', 'testsOrdered', 'diagnosesAddressed'],
    summary: ['id', 'date', 'provider', 'reason', 'status']
  },
  medication: { full: ['id', 'name', 'instructions', 'status', 'since'] },
  allergy: { full: ['id', 'name', 'severity', 'status'] },
  problem: { full: ['id', 'name', 'status', 'since'] },
  appointment: { full: ['id', 'date', 'startTime', 'endTime', 'durationMinutes', 'title', 'location', 'provider', 'state'] },
  vital: { full: ['date', 'bloodPressure', 'bloodPressureNote', 'heartRate', 'temperature', 'respiration', 'oxygen', 'weight', 'height', 'pain'] },
  // The signed note (Portal P1). The ONLY section that may carry note content.
  note: { full: ['subjective', 'objective', 'assessment', 'plan', 'addenda', 'signatures', 'signedAt'] },
  // A filed test result: what the lab sent and whether the care team has
  // reviewed it. Never the app's own interpretation flag or inbox summary.
  result: { full: ['id', 'label', 'resultDate', 'performedBy', 'reviewStatus', 'reviewedBy', 'reviewedAt', 'patientNote', 'hasFile'] },
  carePlan: {
    full: ['version', 'problems', 'goals', 'eachVisit', 'visitFrequency', 'visitDays', 'visitTimes', 'duration', 'chargePlanNote', 'effectiveDate', 'targetDate',
      'authoredBy', 'authoredAt', 'visitSchedule', 'careTier', 'careTierLabel', 'coSignedAt', 'coSignedBy', 'rnSignedAt', 'rnName', 'updatedAt', 'updatedBy', 'primaryCaregiver', 'careTeam', 'authorizedServices', 'signedPdf'],
    summary: ['version', 'goals', 'eachVisit', 'visitSchedule', 'effectiveDate', 'careTierLabel', 'coSignedAt', 'authoredBy', 'signedPdf']
  }
});

// Fields that must NEVER reach a patient, family, or POA payload. The
// build-fail test asserts none of these appear in FILTER_MAP — EXCEPT the
// note-content fields (NOTE_CONTENT_FIELDS), which may appear in the `note`
// section and nowhere else (owner decision 2026-09-29).
const NOTE_CONTENT_FIELDS = Object.freeze(['subjective', 'objective', 'assessment', 'plan']);
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
  'warnings', 'emrWriteError', 'emrMedicationId',
  // results (Portal P1): the app's interpretation flag and the inbox's routing
  // and follow-up are the care team's. The lab's own report is the record.
  'interpretation', 'followUpNote', 'routeTo', 'patientCopy', 'storageRef'
]);
// A result's `summary` is inbox shorthand written for clinicians. `summary` is
// a legitimate VISIT field, so this is its own list, asserted absent from the
// result section.
const RESULT_CLINICIAN_ONLY_FIELDS = Object.freeze(['summary', 'interpretation', 'followUpNote', 'routeTo', 'escalatedAt', 'document']);

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
    return { carePlan: 'full', visits: 'full', medications: 'full', allergies: 'full', problems: 'full', appointments: 'full', vitals: 'full', results: 'full' };
  }
  return {
    carePlan: s.carePlan ? 'summary' : 'none',
    visits: s.visitSummaries,
    medications: s.medications ? 'full' : 'none',
    allergies: s.allergies ? 'full' : 'none',
    problems: s.problems ? 'full' : 'none',
    appointments: s.appointments ? 'full' : 'none',
    vitals: s.vitals ? 'full' : 'none',
    results: s.results ? 'full' : 'none'
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
// Session 4.8: the rule moved onto `clinicalRole` and is answered by
// clinicalRoles.js. These two names stay because every /api/clinical guard and
// the build-enforcement test in test/patient_clinical_read.test.js read them —
// they now DELEGATE rather than restate, because two copies of "who may write
// a chart" is how one path starts accepting what the other refuses.
//
// READ  = any assigned clinical role, `readOnly` (the case manager) included.
// WRITE = any LICENSED role. A case manager stays read-only exactly as before,
//         flag or no flag.
const canClinicalWrite = (u) => clinicalRoles.canClinicalWrite(u);
const canClinicalRead = (u) => clinicalRoles.canClinicalRead(u);

// ---- Visit summary (scope A): filtered fields only, plain language ----
// The encounter's app-side record (4.4 encounter_billing) carries the
// clinician's stamp (the visit-stamp fallback for the provider name when FHIR
// Practitioner 403s), coded diagnoses with descriptions, and — when the
// clinician wrote one — a patient-facing summary + follow-up instructions.
// Nothing here reads the narrative SOAP note.
const ORDER_TYPE_LABELS = { lab: 'Lab work', imaging: 'Imaging', procedure: 'Procedure', referral: 'Referral', dme: 'Equipment' };
const ORDER_STATUS_LABELS = { ordered: 'ordered', sent: 'sent to the lab', resulted: 'results received', cancelled: 'cancelled' };
// A referral and a piece of equipment are not a lab: they are arranged, sent
// to a provider or supplier, and (for a referral) scheduled. Saying "sent to
// the lab" about a home health referral would be wrong on the patient's copy.
const ORDER_STATUS_LABELS_BY_TYPE = {
  referral: { ordered: 'being arranged', sent: 'sent to the provider', scheduled: 'appointment scheduled', completed: 'completed', cancelled: 'cancelled' },
  dme: { ordered: 'being arranged', sent: 'sent to the supplier', completed: 'completed', cancelled: 'cancelled' }
};
// What the patient is told an order IS. Only the plain name of the thing and,
// for a referral or equipment, who it is with — never a fax number, NPI,
// order reference or a diagnosis code.
const orderWhat = (o) => {
  if (!o) return { tests: [], where: null };
  if (o.orderType === 'referral') {
    const r = o.referral || {};
    return { tests: [r.specialty || o.specialty].filter(Boolean), where: r.receivingPractice || null };
  }
  if (o.orderType === 'dme') {
    const d = o.dme || {};
    return { tests: [d.itemDescription || o.itemDescription].filter(Boolean), where: d.supplierName || null };
  }
  return { tests: Array.isArray(o.tests) ? o.tests : [], where: null };
};
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
  const tests = (orders || []).filter(o => o && o.status !== 'cancelled').map(o => {
    const what = orderWhat(o);
    const labels = ORDER_STATUS_LABELS_BY_TYPE[o.orderType] || ORDER_STATUS_LABELS;
    return {
      type: ORDER_TYPE_LABELS[o.orderType] || o.orderType || 'Order',
      tests: what.tests,
      // A referral still waiting on its agency is "being arranged", never "sent".
      status: (o.orderType === 'referral' && o.referral && o.referral.agencyPending && !o.referral.receivingFax)
        ? 'being arranged' : (labels[o.status] || o.status || 'ordered'),
      ...(what.where ? { where: what.where } : {})
    };
  });
  const signed = !!(attestation && attestation.signedAt);
  const sentences = [];
  if (rec.patientSummary) sentences.push(String(rec.patientSummary).trim());
  else if (dx.length) sentences.push(`This visit addressed: ${dx.join(', ')}.`);
  // What the visit was about, on its own. `summary` below appends the
  // prescription and test sentences, which the portal also lists under
  // "Medicine changes" and "Tests ordered" — showing both said everything twice.
  const overview = sentences[0] || (signed ? 'Your clinician completed and signed the note for this visit.' : 'Your clinician is still finishing the note for this visit.');
  if (rx.length) sentences.push(`${rx.length === 1 ? 'A prescription was' : 'Prescriptions were'} recorded: ${rx.map(r => r.name).join(', ')}.`);
  if (tests.length) sentences.push(`${tests.map(t => `${t.type}${t.tests.length ? ` (${t.tests.join(', ')})` : ''} — ${t.status}`).join('; ')}.`);
  if (!sentences.length) sentences.push(signed ? 'Your clinician completed and signed the note for this visit.' : 'Your clinician is still finishing the note for this visit.');
  return {
    id: String(encounterUuid || rec.encounterUuid || (encounter && encounter.id) || ''),
    date, provider, reason,
    overview,
    summary: sentences.join('\n\n'),
    followUp: rec.followUpInstructions ? String(rec.followUpInstructions).trim() : null,
    status: signed ? 'complete' : 'in_progress',
    newPrescriptions: rx,
    testsOrdered: tests,
    diagnosesAddressed: dx
  };
};

// Clinician-authored patient-facing text (set from the encounter panel).
// Bounded, plain strings; empty clears the field. Raised from 1000/600 (owner,
// 2026-09-29): a real home-visit summary ran past both. The screen reads the
// same constants, so the box and the save cannot disagree about the cap.
const PATIENT_SUMMARY_MAX = 4000;
const FOLLOW_UP_MAX = 4000;
// LINE BREAKS ARE KEPT. This used to collapse every run of whitespace to one
// space, so "1. Take the new dose… 2. Call if…" typed as a list reached the
// patient as one run-on paragraph. Lines are trimmed, runs of spaces squeezed,
// CR/LF normalised, control characters dropped and more than one blank line in a
// row collapsed. Everything that shows these strings must render newlines
// (the portal, the after-visit PDF).
const cleanMultiline = (v, max) => {
  const s = String(v == null ? '' : v)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, max).trim() : null;
};
const buildPatientFacingFields = (body) => {
  const src = body && typeof body === 'object' ? body : {};
  return { patientSummary: cleanMultiline(src.patientSummary, PATIENT_SUMMARY_MAX), followUpInstructions: cleanMultiline(src.followUpInstructions, FOLLOW_UP_MAX) };
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
// "Today" is Georgia's date: for four hours every evening UTC is already
// tomorrow, and the rest of today's visits dropped off the list.
const practiceDate = (now) => {
  try {
    const p = require('./public/gfc-time').zonedParts(now);
    if (p && p.isoDate) return p.isoDate;
  } catch (e) { /* fall through */ }
  return now.toISOString().slice(0, 10);
};
const selectUpcomingAppointments = (summaries, now = new Date()) => {
  const today = practiceDate(now);
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
  FILTER_MAP, CLINICIAN_ONLY_FIELDS, NOTE_CONTENT_FIELDS, RESULT_CLINICIAN_ONLY_FIELDS, pickFields, filterFor, filterRow, filterRows,
  evaluateClinicalReadAccess, sectionsFor,
  poaSignerName, buildActingIdentity,
  canClinicalWrite, canClinicalRead,
  buildVisitSummary, buildPatientFacingFields, cleanMultiline, PATIENT_SUMMARY_MAX, FOLLOW_UP_MAX, stripAttribution,
  parseVitalsFromNote,
  selectUpcomingAppointments, summarizeAppointmentForPatient, LOCATION_LABELS,
  summarizeMedicationForPatient, summarizeAllergyForPatient, summarizeProblemForPatient
};
