// ============================================================
// patientPublish.js — what the patient portal reads (Portal P1, 2026-09-29)
//
// OWNER DECISION 2026-09-29: PATIENTS NEVER READ OPENEMR. Since Session 5.2
// every OpenEMR read runs as the person asking, and a patient, POA or family
// user has no OpenEMR identity — so every patient-facing read failed with
// EMR_NOT_CONNECTED and the Health tab told people to "try again in a few
// minutes" forever. Giving the app a system login to OpenEMR would undo the
// Session 5 decision that there is no shared credential.
//
// So the chart is PUBLISHED instead: when a clinician signs a visit (or adds
// the clinician addendum, or an addendum, or presses Publish / Refresh), the
// server reads with THAT CLINICIAN'S own live session and stores a
// patient-facing copy. The portal reads only these copies.
//
// STORE AT FULL LEVEL, FILTER AT READ TIME. A published row holds the full
// curated shape; patientReadRepository's sectionsFor + FILTER_MAP still run on
// every read, so a sharing change takes effect on the next request with no
// republish. This module decides WHERE ROWS COME FROM, never who may see them.
//
// Pure: no I/O. The mappers are the existing ones (clinicalRepository's FHIR
// summarizers, patientReadRepository's *ForPatient and buildVisitSummary) —
// never a second copy of any of them.
// ============================================================

const crypto = require('crypto');
const clinicalRepo = require('./clinicalRepository');
const patientRead = require('./patientReadRepository');
const clinicalNotes = require('./clinicalNotes');

const CHART_HISTORY_MAX = 20;

// ---- Holding a note from the portal (owner, 2026-09-29) ----
// A fixed list, not free text: withholding a note from a patient is allowed
// for narrow reasons and the reason has to be one of them.
const HOLD_REASONS = Object.freeze(['risk_of_harm', 'patient_request']);
const HOLD_REASON_LABELS = Object.freeze({
  risk_of_harm: 'Substantial risk of harm to the patient or another person',
  patient_request: 'The patient asked for it not to be shown'
});
// Input: undefined/false = no hold. { reason } = a hold, and the reason must
// be on the list. Anything else is refused rather than read as "no hold".
const validateHold = (input) => {
  if (input === undefined || input === null || input === false) return { hold: null };
  const reason = input && typeof input === 'object' ? input.reason : undefined;
  if (!HOLD_REASONS.includes(reason)) {
    return { error: `Holding a note from the portal needs a reason: ${HOLD_REASONS.map(r => HOLD_REASON_LABELS[r]).join(', or ')}.`, code: 'PORTAL_HOLD_REASON_REQUIRED' };
  }
  return { hold: { reason } };
};

// ---- The billing plumbing note is never a patient's note ----
// The same test the sign route's hasNote check applies.
const isStructuredRecordNote = (soap, structuredNoteSid) => !!soap && (
  (structuredNoteSid && String(soap.id) === String(structuredNoteSid)) ||
  /^\[GFC STRUCTURED RECORD/.test(String(soap.subjective || ''))
);

// ---- The chart: problems, allergies, medications, latest vitals ----
// Each section is undefined when it was NOT READ this time (a failed read), so
// mergeChart keeps what was published before rather than telling a patient
// their allergy list is now empty.
const INACTIVE_MED = new Set(['stopped', 'cancelled', 'entered-in-error']);
const buildPublishedChart = ({ clientId, problems, allergies, medications, vitals, at, by, sourceEncounterUuid, sourceVisitDate }) => {
  const out = { clientId, publishedAt: at || new Date().toISOString(), publishedBy: personName(by) };
  if (sourceEncounterUuid !== undefined) out.sourceEncounterUuid = sourceEncounterUuid || null;
  if (sourceVisitDate !== undefined) out.publishedFromVisitDate = sourceVisitDate || null;
  if (Array.isArray(problems)) {
    out.problems = problems.map(clinicalRepo.summarizeCondition).map(patientRead.summarizeProblemForPatient);
  }
  if (Array.isArray(allergies)) {
    out.allergies = allergies.map(clinicalRepo.summarizeAllergy).map(patientRead.summarizeAllergyForPatient);
  }
  if (Array.isArray(medications)) {
    out.medications = medications.map(clinicalRepo.summarizeMedicationRequest)
      .filter(m => !INACTIVE_MED.has(String(m.status || '')))
      .map(patientRead.summarizeMedicationForPatient);
  }
  if (vitals) out.vitals = vitals;
  return out;
};
const CHART_SECTIONS = Object.freeze(['problems', 'allergies', 'medications', 'vitals']);
const mergeChart = (prior, next) => {
  const merged = { ...(prior || {}), ...next };
  for (const k of CHART_SECTIONS) if (next[k] === undefined && prior && prior[k] !== undefined) merged[k] = prior[k];
  // History: what the patient was shown before, capped. Never recursive.
  const snapshot = prior ? (({ history, ...rest }) => rest)(prior) : null;
  merged.history = [...(snapshot ? [snapshot] : []), ...((prior && prior.history) || [])].slice(0, CHART_HISTORY_MAX);
  return merged;
};

// Vitals from the signed note. The shared note (4.13) holds them as form keys;
// the patient shape is the one parseVitalsFromNote already produces, so the
// note's own VITALS line is fed through it rather than mapped a second time.
// A telehealth note's line reads "VITALS (patient-reported, telehealth) —", which
// parseVitalsFromNote does not match, so those readings silently never
// published. The label is about how the reading was taken, not what it is:
// vitalsLine is asked for the plain shape so the numbers reach the patient.
const vitalsFromNote = (note, date) => {
  if (!note) return null;
  const plain = note.visit && note.visit.modality === 'telehealth' ? { ...note, visit: { ...note.visit, modality: 'in_person' } } : note;
  return patientRead.parseVitalsFromNote(clinicalNotes.vitalsLine(plain), date);
};

// ---- The note, as signed ----
// Grouped by SOAP slot, which is how noteReadingOrder already lays a note out.
// Each item keeps its formatting markup (six fixed shapes, rendered by the
// portal through public/note-format.js, escaped before formatted).
const SLOTS = clinicalNotes.SLOTS;
const noteFromShared = (note) => {
  const out = {};
  for (const s of SLOTS) out[s] = [];
  for (const item of clinicalNotes.noteReadingOrder(note)) {
    // The RN's Track assignment is an internal staffing decision, not part of
    // what a patient reads about their visit.
    if (item.plain && /^RN Track assignment:/.test(item.plain)) continue;
    // The clinician's "VITALS — BP …; Temp —; RR —" shorthand, with its blank
    // dashes, is not something to hand a patient: the readings are published on
    // their own (the Latest vitals panel), so the line is left out of the note.
    if (item.plain && /^VITALS\b/.test(item.plain)) continue;
    out[item.slot].push({ label: item.label || null, ...(item.markup !== undefined ? { markup: item.markup } : { plain: item.plain }) });
  }
  return out;
};
// A note written before the shared note existed lives only in OpenEMR. Its
// attribution header (which carries an NPI), its "Documented by" line and its
// signature/history block are stripped — the signature is shown separately.
const noteFromLegacy = (soap) => {
  const out = {};
  for (const s of SLOTS) {
    const text = clinicalNotes.stripLegacyText(soap && soap[s]);
    out[s] = text && text !== 'Not documented.' ? [{ label: null, plain: text }] : [];
  }
  return out;
};
const noteIsEmpty = (n) => !n || SLOTS.every(s => !(n[s] || []).length);

const personName = (p) => {
  if (!p) return null;
  const name = p.name || null;
  if (!name) return null;
  return p.licenseLevel ? `${name}, ${p.licenseLevel}` : name;
};
// Who signed, in words a patient reads. No NPI, no ids, no billing capacity.
const patientSignatures = (attestation, record) => {
  const summary = clinicalNotes.buildSignatureSummary({ attestation, record });
  if (!summary) return [];
  const rows = [{ role: summary.signer.capacity === 'author' ? 'Written and signed by' : 'Signed by', name: personName(summary.signer), at: summary.signer.at }];
  if (summary.billing) rows.push({ role: 'Reviewed and signed by', name: personName(summary.billing), at: summary.billing.at });
  for (const c of summary.coSignatures) rows.push({ role: 'Co-signed by', name: personName(c), at: c.at });
  return rows;
};
const patientAddenda = (addenda) => (addenda || [])
  .map(a => ({ text: String(a.text || ''), by: personName(a.by), at: a.at || null, kind: a.kind === 'clinician_addendum' ? 'clinician_addendum' : 'addendum' }))
  .filter(a => a.text.trim());

// A prescription reaches the patient's "medication changes" only once it has
// actually gone out. No e-prescribing fields exist yet, so every row today is
// the legacy `transmission: 'none'` — recorded, and shown. When e-prescribing
// lands, a pending or unsent one stays off the portal.
const PRESCRIPTION_NOT_SENT = Object.freeze(['pending', 'not_sent']);
const sentPrescriptions = (rows) => (rows || []).filter(p => p && !PRESCRIPTION_NOT_SENT.includes(String(p.transmission || '')));

// ---- A visit, as published ----
// `hold` (from the attestation) publishes the summary WITHOUT the note.
const buildPublishedVisit = ({ clientId, encounterUuid, encounter, record, attestation, prescriptions, orders, addenda, legacyNote, hold, at, by, providerFallbackName }) => {
  const rec = record || {};
  const visit = patientRead.buildVisitSummary({
    encounterUuid, encounter, record: rec, attestation,
    prescriptions: sentPrescriptions(prescriptions), orders: orders || [], providerFallbackName
  });
  let note = null;
  if (!hold) {
    const body = rec.note ? noteFromShared(rec.note) : noteFromLegacy(legacyNote);
    if (!noteIsEmpty(body)) {
      note = { ...body, addenda: patientAddenda(addenda), signatures: patientSignatures(attestation, rec), signedAt: (attestation && attestation.signedAt) || null };
    }
  }
  const row = {
    clientId, encounterUuid: String(encounterUuid),
    visit,
    note,
    noteHeld: hold ? { reason: hold.reason } : null,
    vitals: rec.note ? vitalsFromNote(rec.note, visit.date) : (legacyNote ? patientRead.parseVitalsFromNote(legacyNote.objective, visit.date) : null),
    publishedAt: at || new Date().toISOString(),
    publishedBy: personName(by)
  };
  row.contentHash = visitContentHash(row);
  return row;
};
// What decides whether a republish tells the patient anything new: the summary
// text and the note text. A co-signature or a hold reason is not "new to read".
const visitContentHash = (row) => crypto.createHash('sha256').update(JSON.stringify({
  summary: row.visit && row.visit.summary, followUp: row.visit && row.visit.followUp,
  note: row.note ? SLOTS.map(s => row.note[s]).concat([row.note.addenda]) : null
})).digest('hex').slice(0, 16);

// ---- Reading: a published visit for one audience ----
// The visit goes through FILTER_MAP exactly as before; the note is attached
// only where the visit level is 'full' (patient, POA, and family whose client
// shares full visit summaries — owner, 2026-09-29).
const visitForAudience = (row, level) => {
  if (!row || !level || level === 'none') return null;
  const out = patientRead.filterRow('visit', level, row.visit);
  if (!out) return null;
  if (level === 'full') {
    if (row.note) out.note = patientRead.filterRow('note', 'full', row.note);
    if (row.noteHeld) out.noteHeld = true;
  }
  return out;
};

// ---- Results, visible on filing, notified on review (owner, 2026-09-29) ----
const ORDER_LABELS = Object.freeze({ lab: 'Lab results', imaging: 'Imaging report', procedure: 'Procedure report', referral: 'Consult report', dme: 'Equipment order' });
const resultForPatient = (r) => {
  if (!r || !r.releasedToPatientAt) return null;
  const reviewed = !!r.acknowledgedAt;
  return {
    id: String(r.id),
    label: r.orderType ? (ORDER_LABELS[r.orderType] || 'Test results') : 'Outside record',
    resultDate: r.resultDate || null,
    performedBy: r.performedBy || null,
    reviewStatus: reviewed ? 'reviewed' : 'not_reviewed',
    reviewedBy: reviewed ? ((r.acknowledgedBy && r.acknowledgedBy.name) || 'your care team') : null,
    reviewedAt: reviewed ? r.acknowledgedAt : null,
    patientNote: reviewed ? (r.patientNote || null) : null,
    hasFile: !!(r.patientCopy && r.patientCopy.storageRef)
  };
};

module.exports = {
  HOLD_REASONS, HOLD_REASON_LABELS, validateHold,
  isStructuredRecordNote,
  buildPublishedChart, mergeChart, CHART_SECTIONS, CHART_HISTORY_MAX,
  vitalsFromNote, noteFromShared, noteFromLegacy,
  buildPublishedVisit, visitContentHash, visitForAudience,
  resultForPatient, ORDER_LABELS, sentPrescriptions, PRESCRIPTION_NOT_SENT
};
