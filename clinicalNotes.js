// clinicalNotes.js — the shared clinical note (owner-directed, 2026-09-27)
//
// A note used to be written to OpenEMR ONCE and never again: filing created
// the encounter and the narrative soap_note, the private per-clinician draft
// was deleted, and from then on nobody — the author included — could change a
// word. This module is the note as a SHARED, VERSIONED draft that lives on the
// encounter until it is signed:
//
//   Save draft      → the app AND the OpenEMR narrative, one action, every
//                     save stamped with its editor and time (a revision row)
//   Sign & submit   → locks it. A billable clinician's signature is billable;
//                     an RN's or LMSW's is an AUTHOR signature that waits for
//                     a clinician addendum (clinicalRoles.js)
//   Co-signatures   → any licensed clinician, never billing
//   Addenda         → the only change after signing
//
// Everything here is PURE so the rules are testable without an EMR. The
// routes in server.js own the reads and writes.

const crypto = require('crypto');
const nf = require('./public/note-format.js');
const gfcTime = require('./public/gfc-time.js');
const apptTypes = require('./appointmentTypes.js');
const clinicalRepo = require('./clinicalRepository.js');

// ---- Shape ----------------------------------------------------------------
const NOTE_KINDS = Object.freeze(['hp', 'followup']);
const NOTE_TEXT_FIELDS = Object.freeze(['chiefConcern', 'subjective', 'objective', 'assessment', 'plan']);
const NOTE_TEXT_LABELS = Object.freeze({
  chiefConcern: 'Chief concern', subjective: 'Subjective / history', objective: 'Objective / exam',
  assessment: 'Assessment', plan: 'Plan'
});
// The union of the H&P's two-arm vitals and the follow-up's single BP.
const NOTE_VITAL_KEYS = Object.freeze([
  'bpRightSys', 'bpRightDia', 'bpLeftSys', 'bpLeftDia', 'bpSys', 'bpDia',
  'hr', 'temp', 'rr', 'spo2', 'weight', 'height', 'pain'
]);
const HP_SECTION_KEYS = Object.freeze(Object.keys(clinicalRepo.HP_SECTION_LABELS));
const NOTE_MAX_FIELD = 20000;       // markup, per field — formatting markers count
const NOTE_MAX_HP_VALUE = 2000;
const NOTE_MAX_TOTAL = 400000;
const NOTE_STATUS = Object.freeze({ DRAFT: 'draft', SIGNED: 'signed', VOIDED: 'voided' });

const cleanText = (v, max) => String(v == null ? '' : v)
  // Keep newlines and tabs; drop every other control character.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const plainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

// A note payload from the page → the allow-listed shape, or a refusal. Keys
// the note does not declare never reach a record, and a template section must
// be one the catalog knows.
const sanitizeNote = (input) => {
  if (!plainObject(input)) return { error: 'A note payload is required', code: 'NOTE_INVALID' };
  const note = { kind: NOTE_KINDS.includes(input.kind) ? input.kind : 'followup' };
  if (isDate(input.visitDate)) note.visitDate = input.visitDate;
  for (const k of NOTE_TEXT_FIELDS) note[k] = cleanText(input[k], NOTE_MAX_FIELD);
  note.sections = {};
  if (plainObject(input.sections)) {
    for (const [k, v] of Object.entries(input.sections)) {
      if (!Object.prototype.hasOwnProperty.call(apptTypes.SECTIONS, k)) continue;
      const text = cleanText(v, NOTE_MAX_FIELD);
      if (text) note.sections[k] = text;
    }
  }
  note.vitals = {};
  if (plainObject(input.vitals)) {
    for (const k of NOTE_VITAL_KEYS) {
      const v = cleanText(input.vitals[k], 16).trim();
      if (v) note.vitals[k] = v;
    }
  }
  note.hp = {};
  if (plainObject(input.hp)) {
    for (const section of HP_SECTION_KEYS) {
      const src = input.hp[section];
      if (!plainObject(src)) continue;
      const out = {};
      for (const [k, v] of Object.entries(src).slice(0, 64)) {
        if (v === null || v === undefined || typeof v === 'object') continue;
        const t = cleanText(v, NOTE_MAX_HP_VALUE);
        if (t.trim()) out[String(k).slice(0, 64)] = t;
      }
      if (Object.keys(out).length) note.hp[section] = out;
    }
  }
  note.confirmedFields = Array.isArray(input.confirmedFields)
    ? input.confirmedFields.filter(x => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 64))
    : [];
  if (plainObject(input.visit)) {
    note.visit = {};
    for (const k of ['appointmentType', 'modality', 'location']) {
      const v = cleanText(input.visit[k], 64).trim();
      if (v) note.visit[k] = v;
    }
  }
  if (JSON.stringify(note).length > NOTE_MAX_TOTAL) return { error: 'This note is too large to save', code: 'NOTE_TOO_LARGE' };
  if (isEmptyNote(note)) return { error: 'There is nothing in this note to save yet', code: 'NOTE_EMPTY' };
  return { note };
};

const isEmptyNote = (note) => !note || (
  NOTE_TEXT_FIELDS.every(k => nf.isBlank(note[k])) &&
  !Object.values(note.sections || {}).some(v => !nf.isBlank(v)) &&
  !Object.keys(note.vitals || {}).length &&
  !Object.keys(note.hp || {}).length
);

// ---- Flattening: one comparable string per field --------------------------
// Used for three things that must agree on what "a field" is: which sections a
// save changed, which carried-forward fields are still untouched, and the
// revision row.
const stableJson = (o) => JSON.stringify(Object.keys(o || {}).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {}));
const flattenNote = (note, { includeVitals = true } = {}) => {
  const out = {};
  if (!note) return out;
  for (const k of NOTE_TEXT_FIELDS) if (!nf.isBlank(note[k])) out[k] = String(note[k]);
  for (const [k, v] of Object.entries(note.sections || {})) if (!nf.isBlank(v)) out[`sections.${k}`] = String(v);
  for (const [k, v] of Object.entries(note.hp || {})) if (plainObject(v) && Object.keys(v).length) out[`hp.${k}`] = stableJson(v);
  if (includeVitals && note.vitals && Object.keys(note.vitals).length) out.vitals = stableJson(note.vitals);
  if (includeVitals && note.visitDate) out.visitDate = note.visitDate;
  return out;
};
const changedKeys = (before, after) => {
  const a = flattenNote(before); const b = flattenNote(after);
  return Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).filter(k => a[k] !== b[k]).sort();
};
const fieldLabel = (key) => {
  if (NOTE_TEXT_LABELS[key]) return NOTE_TEXT_LABELS[key];
  if (key === 'vitals') return 'Vitals';
  if (key === 'visitDate') return 'Visit date';
  if (key.startsWith('sections.')) return apptTypes.SECTIONS[key.slice(9)] || key.slice(9);
  if (key.startsWith('hp.')) return clinicalRepo.HP_SECTION_LABELS[key.slice(3)] || key.slice(3);
  return key;
};

// ---- Concurrency ---------------------------------------------------------
// Two people editing one note is the point of sharing it, and the last save
// silently winning is the failure the owner raised first. Every save names the
// version it was made against; anything else is refused and says who saved.
const checkNoteVersion = (record, baseVersion, lastRevision) => {
  const current = Number((record && record.noteVersion) || 0);
  const base = Number(baseVersion);
  if (Number.isInteger(base) && base === current) return { ok: true, version: current };
  const by = lastRevision && lastRevision.savedBy;
  return {
    ok: false, code: 'NOTE_CHANGED', version: current,
    lastSavedBy: by ? { id: by.id, name: by.name, licenseLevel: by.licenseLevel } : null,
    lastSavedAt: lastRevision ? lastRevision.savedAt : null,
    error: by
      ? `${by.name || 'Someone'} saved this note at ${fmtEt(lastRevision.savedAt)}, after you opened it. Your changes are kept on screen — review theirs, then save again.`
      : 'This note changed after you opened it. Your changes are kept on screen — review the latest version, then save again.'
  };
};

// ---- Revisions: every save is a signature and a timestamp ----------------
const REVISION_ACTIONS = Object.freeze(['create', 'save', 'carry_forward', 'sign', 'void']);
const buildNoteRevision = ({ id, record, version, actor, clinicalRole, changed, action, carriedFrom, at }) => ({
  id,
  encounterUuid: String(record.encounterUuid),
  clientId: record.clientId,
  version,
  action: REVISION_ACTIONS.includes(action) ? action : 'save',
  savedAt: at || new Date().toISOString(),
  savedBy: { ...clinicalRepo.actorRecord(actor), clinicalRole: clinicalRole || null },
  // WHICH sections changed, never their text: the text lives in the note and
  // in OpenEMR, and a second copy of it per save is a second copy of PHI.
  sectionsChanged: Array.isArray(changed) ? changed.slice(0, 200) : [],
  carriedFrom: carriedFrom || null
});
const revisionsFor = (rows, encounterUuid) => (rows || [])
  .filter(r => r && r.encounterUuid === String(encounterUuid))
  .sort((a, b) => (a.version - b.version) || String(a.savedAt).localeCompare(String(b.savedAt)));
const contributorsFrom = (revisions) => {
  const byId = new Map();
  for (const r of revisions || []) {
    const who = r.savedBy || {};
    const key = who.id || who.name || 'unknown';
    const cur = byId.get(key) || { id: who.id || null, name: who.name || 'Unknown', licenseLevel: who.licenseLevel || null, clinicalRole: who.clinicalRole || null, saves: 0, firstAt: r.savedAt, lastAt: r.savedAt };
    cur.saves += 1;
    if (String(r.savedAt) > String(cur.lastAt)) cur.lastAt = r.savedAt;
    if (String(r.savedAt) < String(cur.firstAt)) cur.firstAt = r.savedAt;
    byId.set(key, cur);
  }
  return Array.from(byId.values()).sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)));
};

// ---- Template sections: which the note has, derived — never stored --------
// `completedSections` used to be READ by the sign gate and WRITTEN by nothing,
// so any visit type with required sections could never be signed. It is
// derived now from what the note actually contains.
//
// Some template sections are answered by one of the note's fixed fields; the
// rest get their own box in the editor.
const FIELD_FOR_SECTION = Object.freeze({
  chiefComplaint: ['chiefConcern'],
  reasonForVisit: ['chiefConcern'],
  hpi: ['subjective'],
  intervalHistory: ['subjective'],
  vitals: ['vitals'],
  awvVitals: ['vitals'],
  physicalExam: ['objective', 'hp.systemsExam'],
  focusedExam: ['objective', 'hp.systemsExam'],
  mentalStatusExam: ['hp.mentalStatusExam'],
  assessment: ['assessment'],
  plan: ['plan']
});
const sectionHasOwnField = (key) => !Object.prototype.hasOwnProperty.call(FIELD_FOR_SECTION, key);
// `satisfiers` carries facts the note text is not the only evidence for — an
// order placed on this encounter IS the orders section, a structured risk
// assessment IS the risk section.
const deriveCompletedSections = (note, satisfiers = {}) => {
  const flat = flattenNote(note);
  const done = [];
  for (const key of Object.keys(apptTypes.SECTIONS)) {
    const via = FIELD_FOR_SECTION[key];
    const byField = via ? via.some(f => !!flat[f]) : false;
    const byOwn = !!flat[`sections.${key}`];
    if (byField || byOwn || satisfiers[key] === true) done.push(key);
  }
  return done;
};

// ---- Carry forward -------------------------------------------------------
// The whole note except vitals and the visit date (owner decision), and every
// carried field is held for review: Sign & submit is refused until each has
// been edited or confirmed. A copied exam is exactly what an auditor calls a
// cloned note; the per-field confirmation is what makes carrying it defensible.
const hashValue = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const carryForwardContent = (source) => {
  if (!source) return null;
  return {
    kind: NOTE_KINDS.includes(source.kind) ? source.kind : 'followup',
    ...NOTE_TEXT_FIELDS.reduce((acc, k) => { acc[k] = source[k] || ''; return acc; }, {}),
    sections: { ...(source.sections || {}) },
    hp: JSON.parse(JSON.stringify(source.hp || {})),
    vitals: {}
  };
};
// A note written before the shared note existed lives only as OpenEMR plain
// text, with an attribution header, a "Documented by" line, a VITALS line and
// possibly a signature block — none of which a NEW note may inherit.
const LEGACY_DROP_LINE = /^(\[GFC CLINICIAN\]|Documented by |VITALS —|Draft discarded by )/;
const LEGACY_STOP_LINE = /^(=+|ELECTRONICALLY SIGNED|NOTE HISTORY|AWAITING CLINICIAN ADDENDUM)/;
const stripLegacyText = (text) => {
  const out = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (LEGACY_STOP_LINE.test(line.trim())) break;
    if (LEGACY_DROP_LINE.test(line.trim())) continue;
    out.push(line);
  }
  return out.join('\n').replace(/^\n+|\n+$/g, '');
};
// The readings an old note carries on its "VITALS —" line, back in the form's
// own keys. Two shapes were ever written (clinicalRepository buildHpWrites and
// buildFollowUpWrites); "—" was written for an empty box. Dropping this line
// was a real bug: whoever opened an older note to edit it saw blank vitals,
// and their first save rewrote the OpenEMR note without them (2026-09-28).
const parseLegacyVitals = (text) => {
  const line = (String(text || '').match(/VITALS[^—\n]*—\s*([^\n]*)/) || [])[1];
  if (!line) return {};
  const out = {};
  const put = (k, v) => { const t = String(v == null ? '' : v).trim(); if (t && t !== '—') out[k] = t.slice(0, 16); };
  const arm = (side) => line.match(new RegExp(`BP ${side} arm ([^/;]*)/([^;]*)`, 'i'));
  const right = arm('right'); const left = arm('left');
  if (right || left) {
    if (right) { put('bpRightSys', right[1]); put('bpRightDia', right[2]); }
    if (left) { put('bpLeftSys', left[1]); put('bpLeftDia', left[2]); }
  } else {
    const bp = line.match(/(?:^|;)\s*BP\s+([^/;]*)\/([^;]*)/i);
    if (bp) { put('bpSys', bp[1]); put('bpDia', bp[2]); }
  }
  const val = (label) => (line.match(new RegExp(`(?:^|;)\\s*${label}\\s+([^;]+)`, 'i')) || [])[1];
  put('hr', val('HR')); put('temp', val('Temp')); put('rr', val('RR')); put('spo2', val('SpO2'));
  put('weight', val('Wt')); put('height', val('Ht'));
  const pain = line.match(/(?:^|;)\s*Pain\s+([^;/]+)\/10/i);
  if (pain) put('pain', pain[1]);
  return out;
};

// An old H&P's objective carries each exam as a block: the section label in
// capitals, then "Label: value" lines (clinicalRepository.kvLines). Read back
// into note.hp so the H&P form's boxes are filled rather than the text sitting
// in Objective.
const camelFromLabel = (label) => {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w.charAt(0).toLowerCase() + w.slice(1))).join('');
};
const HP_BLOCK_BY_HEADING = Object.freeze(Object.entries(clinicalRepo.HP_SECTION_LABELS)
  .reduce((acc, [k, label]) => { acc[`${label.toUpperCase()}:`] = k; return acc; }, {}));
const splitLegacyHpBlocks = (objectiveText) => {
  const hp = {};
  const kept = [];
  let current = null;
  for (const raw of String(objectiveText || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (HP_BLOCK_BY_HEADING[line]) { current = HP_BLOCK_BY_HEADING[line]; hp[current] = hp[current] || {}; continue; }
    if (current) {
      if (!line) { current = null; continue; }
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) { if (m[2].trim()) hp[current][camelFromLabel(m[1])] = m[2].trim().slice(0, NOTE_MAX_HP_VALUE); continue; }
      current = null;
    }
    kept.push(raw);
  }
  for (const k of Object.keys(hp)) if (!Object.keys(hp[k]).length) delete hp[k];
  return { hp, objective: kept.join('\n').replace(/^\n+|\n+$/g, '') };
};
const TRACK_LINE = /^RN Track assignment:\s*([^—\n]+?)(?:\s+—\s+(.*))?$/;

// `hint.isInitialVisit` — the server knows which encounter was the client's
// initial visit, which settles the kind even when the BP line was left blank.
const noteFromLegacyNarrative = (soap, kind, hint = {}) => {
  const s = soap || {};
  const placeholder = /^(No objective findings recorded\.|See encounter diagnoses \(GFC structured note\)\.|Not documented\.)$/;
  const vitals = parseLegacyVitals(s.objective);
  const isHp = kind === 'hp' || !!hint.isInitialVisit || !!(vitals.bpRightSys || vitals.bpLeftSys || vitals.bpRightDia || vitals.bpLeftDia);
  const clean = (v) => { const t = stripLegacyText(v); return placeholder.test(t.trim()) ? '' : t; };
  let objective = clean(s.objective);
  let plan = clean(s.plan);
  let hp = {};
  if (isHp) {
    const split = splitLegacyHpBlocks(objective);
    hp = split.hp; objective = split.objective;
    const planLines = plan.split('\n');
    const at = planLines.findIndex(l => TRACK_LINE.test(l.trim()));
    if (at !== -1) {
      const m = planLines[at].trim().match(TRACK_LINE);
      hp.triage = { track: m[1].trim(), ...(m[2] ? { rationale: m[2].trim() } : {}) };
      planLines.splice(at, 1);
      plan = planLines.join('\n').replace(/^\n+|\n+$/g, '');
    }
  }
  const field = (t) => (t ? nf.fromPlainText(t) : '');
  return {
    kind: isHp ? 'hp' : (NOTE_KINDS.includes(kind) ? kind : 'followup'),
    chiefConcern: '', subjective: field(clean(s.subjective)), objective: field(objective),
    assessment: field(clean(s.assessment)), plan: field(plan),
    sections: {}, vitals, hp, confirmedFields: []
  };
};

// ---- Draft vitals, shown before the note is signed (owner, 2026-09-28) ----
// The OpenEMR vitals row is written once, at signing, because OpenEMR cannot
// update or delete one. Until then the readings live only in the note — so the
// chart's vitals list and My Day's "Last vitals" show them from here, marked as
// a draft that is not in OpenEMR yet. Once the row is written they drop out.
const draftVitalsRows = (record) => {
  const r = record || {};
  if (!r.note || r.noteStatus !== NOTE_STATUS.DRAFT || r.vitalsWrittenAt) return [];
  const v = r.note.vitals || {};
  if (!Object.keys(v).length) return [];
  const at = r.note.visitDate || r.date || null;
  const id = (k) => `draft:${r.encounterUuid}:${k}`;
  const rows = [];
  const push = (key, name, value) => { if (value) rows.push({ id: id(key), name, value, at, draft: true, encounterUuid: r.encounterUuid || null }); };
  if (v.bpRightSys || v.bpLeftSys || v.bpRightDia || v.bpLeftDia) {
    const side = (s, d) => ((s || d) ? `${s || '—'}/${d || '—'}` : null);
    push('bp', 'Blood pressure', [side(v.bpRightSys, v.bpRightDia) && `right ${side(v.bpRightSys, v.bpRightDia)}`,
      side(v.bpLeftSys, v.bpLeftDia) && `left ${side(v.bpLeftSys, v.bpLeftDia)}`].filter(Boolean).join(' · '));
  } else if (v.bpSys || v.bpDia) {
    push('bp', 'Blood pressure', `${v.bpSys || '—'}/${v.bpDia || '—'} mmHg`);
  }
  push('hr', 'Heart rate', v.hr && `${v.hr} /min`);
  push('temp', 'Body temperature', v.temp && `${v.temp} °F`);
  push('rr', 'Respiratory rate', v.rr && `${v.rr} /min`);
  push('spo2', 'Oxygen saturation', v.spo2 && `${v.spo2} %`);
  push('weight', 'Body weight', v.weight && `${v.weight} lb`);
  push('height', 'Body height', v.height && `${v.height} in`);
  push('pain', 'Pain score', v.pain && `${v.pain}/10`);
  return rows;
};

// A note filed the old way already had its vitals row written at filing. Its
// first shared save records those readings as `legacyVitals`; signing then
// writes a new row only if somebody changed them, so OpenEMR does not get the
// same readings twice.
const vitalsNeedRow = (record) => {
  const v = (record && record.note && record.note.vitals) || {};
  if (!Object.keys(v).length) return false;
  if (!record.legacyVitals) return true;
  return stableJson(v) !== stableJson(record.legacyVitals);
};
const buildCarriedForward = ({ fromEncounterUuid, fromDate, content }) => {
  const flat = flattenNote(content, { includeVitals: false });
  const fields = {};
  for (const [k, v] of Object.entries(flat)) fields[k] = hashValue(v);
  return { fromEncounterUuid: String(fromEncounterUuid), fromDate: fromDate || null, fields, confirmed: [] };
};
// A carried field is still PENDING review while its value is exactly what was
// carried and nobody has confirmed it. Editing it clears it on its own.
const carriedPending = (note) => {
  const cf = note && note.carriedForward;
  if (!cf || !cf.fields) return [];
  const flat = flattenNote(note, { includeVitals: false });
  const confirmed = new Set(cf.confirmed || []);
  return Object.entries(cf.fields)
    .filter(([k, h]) => !confirmed.has(k) && flat[k] !== undefined && hashValue(flat[k]) === h)
    .map(([k]) => k).sort();
};

// ---- Composing the OpenEMR narrative ------------------------------------
// OpenEMR holds four plain-text SOAP fields. Template sections are placed in
// the one a reader would look in; headings are capitals because OpenEMR has no
// other way to show one.
const OBJECTIVE_SECTIONS = new Set(['vitals', 'awvVitals', 'physicalExam', 'focusedExam', 'mentalStatusExam', 'examination',
  'screeningScores', 'cognitiveAssessment', 'depressionScreen', 'functionalFallRisk']);
const ASSESSMENT_SECTIONS = new Set(['assessment', 'riskAssessment', 'medicalOpinion', 'mdmComplexity', 'careManagementEligibility']);
const PLAN_SECTIONS = new Set(['plan', 'ordersRxReferrals', 'ordersRx', 'returnPrecautions', 'followUp', 'mdmOrTime',
  'preventionPlan', 'screeningSchedule', 'careGapsOrders', 'advanceCarePlanning', 'referralsResources',
  'patientCaregiverEducation', 'followUpAppointments', 'treatmentPlan', 'medicationsRx', 'safetyPlan', 'planMedChanges',
  'psychotherapyTime', 'dbqForms', 'reportAttachment', 'riskFactorsInterventions', 'twoDayContact']);
const slotForSection = (key) => (OBJECTIVE_SECTIONS.has(key) ? 'objective'
  : ASSESSMENT_SECTIONS.has(key) ? 'assessment'
    : PLAN_SECTIONS.has(key) ? 'plan' : 'subjective');
const SLOT_MAX = 60000;
const OPENEMR_EMPTY = 'Not documented.'; // OpenEMR's SOAP validator wants ≥2 characters per section

const fmtEt = (iso) => (iso ? `${gfcTime.fmtDateTime(iso)} ET` : '');
const personLine = (p) => {
  if (!p) return 'Unknown';
  const cred = p.licenseLevel ? `, ${p.licenseLevel}` : '';
  const npi = p.npi ? ` (NPI ${p.npi})` : '';
  return `${p.name || 'Unknown'}${cred}${npi}`;
};

const vitalsLine = (note) => {
  const v = (note && note.vitals) || {};
  if (!Object.keys(v).length) return '';
  const d = (k) => v[k] || '—';
  const bp = (v.bpRightSys || v.bpLeftSys)
    ? `BP right arm ${d('bpRightSys')}/${d('bpRightDia')}; BP left arm ${d('bpLeftSys')}/${d('bpLeftDia')}`
    : `BP ${d('bpSys')}/${d('bpDia')}`;
  const telehealth = note.visit && note.visit.modality === 'telehealth';
  return `VITALS${telehealth ? ' (patient-reported, telehealth)' : ''} — ${bp}; HR ${d('hr')}; Temp ${d('temp')}; RR ${d('rr')}; SpO2 ${d('spo2')}; Wt ${d('weight')}; Ht ${d('height')}${v.pain ? `; Pain ${v.pain}/10` : ''}`;
};

// The OpenEMR vitals ROW, written once at signing (there is no update route).
// The H&P records the HIGHER-reading arm, as it always has.
const buildVitalsRow = (note) => {
  const v = (note && note.vitals) || {};
  if (!Object.keys(v).length) return null;
  if (v.bpRightSys || v.bpLeftSys) {
    const useRight = (parseInt(v.bpRightSys, 10) || 0) >= (parseInt(v.bpLeftSys, 10) || 0);
    return {
      bps: useRight ? (v.bpRightSys || '') : (v.bpLeftSys || ''),
      bpd: useRight ? (v.bpRightDia || '') : (v.bpLeftDia || ''),
      pulse: v.hr || '', temperature: v.temp || '', respiration: v.rr || '', oxygen_saturation: v.spo2 || '',
      weight: v.weight || '', height: v.height || '',
      note: `BP right arm ${v.bpRightSys || '—'}/${v.bpRightDia || '—'}; BP left arm ${v.bpLeftSys || '—'}/${v.bpLeftDia || '—'}`
    };
  }
  return {
    bps: v.bpSys || '', bpd: v.bpDia || '', pulse: v.hr || '', temperature: v.temp || '', respiration: v.rr || '',
    oxygen_saturation: v.spo2 || '', weight: v.weight || '', height: v.height || '',
    note: 'Recorded via the GFC Care Platform'
  };
};

// The both-arms rule for an H&P moved from SAVE to SIGN: refusing to save an
// incomplete note is how home-visit documentation is lost.
const checkNoteForSigning = (note) => {
  if (!note) return { ok: false, code: 'SIGN_NO_NOTE', error: 'There is no note on this encounter yet. Save a draft first.' };
  const pending = carriedPending(note);
  if (pending.length) {
    return {
      ok: false, code: 'NOTE_CARRIED_FORWARD_UNREVIEWED', pending,
      error: `This note carries text forward from an earlier visit that has not been reviewed: ${pending.map(fieldLabel).join(', ')}. Edit or confirm each one before signing.`
    };
  }
  if (note.kind === 'hp') {
    const v = note.vitals || {};
    if (!v.bpRightSys || !v.bpLeftSys) {
      return { ok: false, code: 'HP_BP_BOTH_ARMS', error: 'Blood pressure in BOTH arms is required before an initial visit (H&P) can be signed (intake spec §2C).' };
    }
  }
  return { ok: true };
};

// ---- Signatures ---------------------------------------------------------
// Who signed, in what capacity, and who co-signed — read from the attestation
// and the encounter record. The same summary drives the plain-text block in
// OpenEMR, the bold block in the app and the signed-note PDF.
const buildSignatureSummary = ({ attestation, record }) => {
  if (!attestation || !attestation.signedAt) return null;
  const r = record || {};
  const authorOnly = attestation.coSignStatus === 'pending' || attestation.coSignStatus === 'cleared' || r.coSignStatus === 'pending' || r.coSignStatus === 'cleared';
  return {
    signer: { ...attestation.signedBy, clinicalRole: attestation.signedByClinicalRole || null, at: attestation.signedAt, capacity: authorOnly ? 'author' : 'billing' },
    billing: r.coSignStatus === 'cleared' && r.coSignedBy
      ? { ...r.coSignedBy, at: r.coSignedAt, capacity: 'clinician_addendum' }
      : null,
    awaitingAddendum: r.coSignStatus === 'pending',
    coSignatures: (Array.isArray(r.coSignatures) ? r.coSignatures : []).map(c => ({ ...c }))
  };
};
const RULE = '========================================';
const signatureBlockLines = (summary) => {
  if (!summary) return [];
  const lines = [RULE, 'ELECTRONICALLY SIGNED'];
  const s = summary.signer;
  lines.push(s.capacity === 'author'
    ? `Signed by ${personLine(s)} — AUTHOR (not a billing signature) — ${fmtEt(s.at)}`
    : `Signed by ${personLine(s)} — ${fmtEt(s.at)}`);
  if (summary.billing) lines.push(`Clinician addendum and billing signature: ${personLine(summary.billing)} — ${fmtEt(summary.billing.at)}`);
  if (summary.awaitingAddendum) lines.push('AWAITING CLINICIAN ADDENDUM — not billable until a provider (or an LCSW, for behavioral health) adds it.');
  for (const c of summary.coSignatures) lines.push(`Co-signed by ${personLine(c)} — ${fmtEt(c.at)}`);
  lines.push(RULE);
  return lines;
};
const HISTORY_MAX_LINES = 30;
const noteHistoryLines = (revisions) => {
  const saves = (revisions || []).filter(r => r.action !== 'sign');
  if (!saves.length) return [];
  const shown = saves.slice(-HISTORY_MAX_LINES);
  const lines = ['NOTE HISTORY — every saved draft, its editor and time:'];
  if (saves.length > shown.length) lines.push(`  … ${saves.length - shown.length} earlier saves`);
  for (const r of shown) lines.push(`  v${r.version}  ${personLine(r.savedBy)} — ${fmtEt(r.savedAt)}${r.carriedFrom ? ' (carried forward from an earlier note)' : ''}`);
  return lines;
};

const clip = (s) => (s.length > SLOT_MAX ? `${s.slice(0, SLOT_MAX - 80)}\n… [truncated in OpenEMR — the full note is in the signed PDF]` : s);

// The note's content in reading order, one list read by BOTH the OpenEMR text
// and the signed-note PDF, so the two cannot lay a note out differently.
// Each item carries formatted `markup`, or `plain` text for a line the app
// composes itself (vitals, the H&P's structured exam rows, triage).
const SLOTS = Object.freeze(['subjective', 'objective', 'assessment', 'plan']);
const SLOT_LABELS = Object.freeze({ subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' });
const noteReadingOrder = (note) => {
  const n = note || {};
  const items = [];
  const push = (slot, label, value, isPlain, inline) => {
    if (isPlain ? !String(value || '').trim() : nf.isBlank(value)) return;
    items.push({ slot, label: label || null, inline: !!inline, ...(isPlain ? { plain: String(value) } : { markup: String(value) }) });
  };
  push('subjective', 'Chief concern', n.chiefConcern, false, true);
  push('subjective', null, n.subjective);
  push('objective', null, vitalsLine(n), true);
  push('objective', null, n.objective);
  for (const section of HP_SECTION_KEYS) {
    const obj = n.hp && n.hp[section];
    if (!obj || !Object.keys(obj).length || section === 'triage') continue;
    push('objective', clinicalRepo.HP_SECTION_LABELS[section], clinicalRepo.kvLines(obj).join('\n'), true);
  }
  push('assessment', null, n.assessment);
  push('plan', null, n.plan);
  const tri = n.hp && n.hp.triage;
  if (tri && tri.track) push('plan', null, `RN Track assignment: ${tri.track}${tri.rationale ? ` — ${tri.rationale}` : ''}`, true);
  // Template sections in the catalog's own order, so the note reads the way
  // the template is laid out.
  for (const key of Object.keys(apptTypes.SECTIONS)) {
    push(slotForSection(key), apptTypes.SECTIONS[key], n.sections && n.sections[key]);
  }
  return SLOTS.flatMap(slot => items.filter(i => i.slot === slot));
};
const itemPlainText = (item) => {
  const body = (item.plain !== undefined ? item.plain : nf.toPlainText(item.markup)).trim();
  if (!item.label) return body;
  return item.inline ? `${item.label}: ${body}` : `${item.label.toUpperCase()}:\n${body}`;
};

const composeNarrative = ({ note, revisions, signature, voided }) => {
  if (voided) {
    const line = `Draft discarded by ${personLine(voided.by)} — ${fmtEt(voided.at)} — ${voided.reason}`;
    return { subjective: line, objective: 'Discarded draft — no clinical content.', assessment: 'Discarded draft.', plan: 'Discarded draft — this encounter does not bill.' };
  }
  const slots = { subjective: [], objective: [], assessment: [], plan: [] };
  for (const item of noteReadingOrder(note)) slots[item.slot].push(itemPlainText(item));
  const foot = [...noteHistoryLines(revisions), ...(signature ? ['', ...signatureBlockLines(signature)] : [])];
  if (foot.length) slots.plan.push(foot.join('\n'));
  const join = (arr) => clip(arr.filter(Boolean).join('\n\n')) || OPENEMR_EMPTY;
  return { subjective: join(slots.subjective), objective: join(slots.objective), assessment: join(slots.assessment), plan: join(slots.plan) };
};

// A note written before the shared note existed has no `note` on its record —
// only OpenEMR text. Signing it must not recompose that text (which would drop
// what the author wrote the old way), so the signature is APPENDED to its plan,
// replacing any signature block an earlier write put there.
const appendSignatureToLegacyPlan = (plan, summary) => {
  const lines = String(plan || '').replace(/\r\n?/g, '\n').split('\n');
  const stop = lines.findIndex(l => LEGACY_STOP_LINE.test(l.trim()));
  const kept = (stop === -1 ? lines : lines.slice(0, stop)).join('\n').replace(/\n+$/, '');
  return clip([kept, '', ...signatureBlockLines(summary)].join('\n').replace(/^\n+/, '')) || OPENEMR_EMPTY;
};

module.exports = {
  NOTE_KINDS,
  NOTE_TEXT_FIELDS,
  NOTE_TEXT_LABELS,
  NOTE_VITAL_KEYS,
  NOTE_STATUS,
  NOTE_MAX_FIELD,
  REVISION_ACTIONS,
  FIELD_FOR_SECTION,
  sanitizeNote,
  isEmptyNote,
  flattenNote,
  changedKeys,
  fieldLabel,
  checkNoteVersion,
  buildNoteRevision,
  revisionsFor,
  contributorsFrom,
  sectionHasOwnField,
  deriveCompletedSections,
  hashValue,
  carryForwardContent,
  stripLegacyText,
  noteFromLegacyNarrative,
  parseLegacyVitals,
  splitLegacyHpBlocks,
  draftVitalsRows,
  vitalsNeedRow,
  buildCarriedForward,
  carriedPending,
  slotForSection,
  vitalsLine,
  buildVitalsRow,
  checkNoteForSigning,
  buildSignatureSummary,
  signatureBlockLines,
  noteHistoryLines,
  SLOTS,
  SLOT_LABELS,
  noteReadingOrder,
  itemPlainText,
  composeNarrative,
  appendSignatureToLegacyPlan,
  fmtEt,
  personLine
};
