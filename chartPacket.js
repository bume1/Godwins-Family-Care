// ============================================================
// chartPacket.js — everything the requesting clinician can read about ONE
// patient, assembled into cited sections (2026-10-12, owner decision 5).
//
// THE REVIEW IS COMPREHENSIVE BY OWNER DECISION: no time window, no count
// caps, no document cap. It reads what the clinician asking could already
// open for that patient — behavioural health notes, risk assessments,
// caregiver logs, care-team messages they can see, and records received under
// 42 CFR Part 2 consent (used here for treatment, which is what that consent
// permits).
//
// IT DOES NOT WIDEN WHO CAN READ A CHART. Every row handed in was gathered
// with the clinician's OWN OpenEMR session and their own visibility rules;
// this module only arranges what it is given. It decides WHAT GOES IN A PASS,
// never who may ask.
//
// TWO EXCLUSIONS, AND ONLY TWO:
//   • Another patient's data. Every row is checked against the client id and
//     a row that does not belong is DROPPED AND COUNTED, never arranged. This
//     is the one failure this repo has already paid for once (PR #88), and a
//     model that is handed two patients will write findings that merge them.
//   • Non-clinical artefacts — signature images, IP hashes, prices. They are
//     not clinical facts, they are large, and a signature image in a prompt is
//     a disclosure with no clinical purpose at all.
//
// EVERY SECTION CARRIES A STABLE sourceId, because a finding that cannot be
// traced to its source is a finding a clinician cannot check, and §10.3's
// whole posture is that the model proposes and the clinician verifies. The
// manifest is what the citation check is run against.
//
// Pure: no I/O. The server gathers; this arranges. Same split as
// patientPublish.js, and for the same reason — the arranging is where the
// rules live and it has to be testable without an EMR.
// ============================================================
'use strict';

// The source kinds this packet can carry (D2). An id is `<kind-prefix>:<key>`
// and the prefix is what a citation names, so these strings are a contract
// with the review output and must not be renamed casually.
const SECTION_KINDS = Object.freeze({
  DEMOGRAPHICS: 'emr:demographics',
  PROBLEMS: 'emr:problems',
  MEDICATIONS: 'emr:medications',
  ALLERGIES: 'emr:allergies',
  VITALS: 'emr:vitals',
  ENCOUNTERS: 'emr:encounters',
  IMMUNIZATIONS: 'emr:immunizations',
  PROCEDURES: 'emr:procedures',
  GOALS: 'emr:goals',
  CARE_TEAM: 'emr:care-team',
  COVERAGE: 'emr:coverage',
  INTAKE: 'intake',
  CONSENT_ELECTIONS: 'consent:elections'
});

// Prefixes for the per-row sources.
const PREFIX = Object.freeze({
  ENCOUNTER: 'enc', ORDER: 'order', RESULT: 'result', RX: 'rx',
  CARE_PLAN: 'careplan', MED_REC: 'medrec', CAREGIVER: 'caregiver',
  MESSAGE: 'msg', DOCUMENT: 'doc'
});

// WHAT GOES IN EVERY PASS. When a chart is too big for one call, these travel
// with each pass — a finding about a medication is wrong if the pass that
// produced it could not see the problem list or the allergies.
const HEADER_KINDS = Object.freeze([
  SECTION_KINDS.DEMOGRAPHICS,
  SECTION_KINDS.PROBLEMS,
  SECTION_KINDS.MEDICATIONS,
  SECTION_KINDS.ALLERGIES
]);

// The heading an unsigned note is put under, and nothing else. The model is
// told in its system instruction to treat this as unverified; the heading is
// how it can tell. A draft presented as part of the record is a finding built
// on something no clinician has attested to.
const DRAFT_HEADING = 'UNSIGNED DRAFT, not part of the record';

// Keys that are never clinical facts. Dropped wherever they appear, at any
// depth: a signature image is megabytes of no diagnostic value, an IP hash
// identifies a person's connection, and a price is a billing artefact.
const NON_CLINICAL_KEYS = Object.freeze([
  'signature', 'signatureImage', 'signatureDataUrl', 'rnSignature', 'clientSignature',
  'coSignSignature', 'signatureImageUrl', 'drawnSignature',
  'ipHash', 'ip', 'ipAddress', 'clientIpHash',
  'price', 'rate', 'hourlyRate', 'dailyMinimumHours', 'rateAgreement',
  'amount', 'charge', 'chargeAmount', 'fee', 'payRate', 'clientPayRates'
]);
const NON_CLINICAL_RE = /(signature|iphash|ipaddress|payrate|hourlyrate|rateagreement)/i;

const isNonClinicalKey = (k) => NON_CLINICAL_KEYS.includes(k) || NON_CLINICAL_RE.test(String(k));

// Strip the non-clinical artefacts out of anything, at any depth.
const stripNonClinical = (value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripNonClinical);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isNonClinicalKey(k)) continue;
      out[k] = stripNonClinical(v);
    }
    return out;
  }
  return value;
};

// Render a value as the text the model reads. Objects go in as compact JSON
// rather than prose: the shape is itself information (a null is a question
// nobody answered) and a prose rendering would have to invent a sentence.
const asText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 1);
};

// ── belonging ─────────────────────────────────────────────────────────────
// A row that names a different client is dropped and counted. `undefined`
// means the row is not client-keyed (an EMR section already scoped by the
// patient read) and is allowed through; an explicit mismatch is not.
const belongsTo = (row, clientId) => {
  if (!row || typeof row !== 'object') return true;
  for (const key of ['clientId', 'client_id', 'patientClientId']) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v) !== String(clientId)) return false;
  }
  return true;
};

const section = ({ sourceId, kind, title, date, value, text, encounterUuid, draft }) => ({
  sourceId,
  kind,
  title: title || kind,
  date: date || null,
  encounterUuid: encounterUuid || null,
  draft: !!draft,
  text: [
    draft ? DRAFT_HEADING : null,
    text !== undefined ? text : asText(stripNonClinical(value))
  ].filter(v => v !== null && v !== '').join('\n')
});

// ── building the packet ───────────────────────────────────────────────────
//
// `input` is what the server gathered. Every field is optional: a section the
// clinician's own OpenEMR session refused is reported in `notRead` and NEVER
// filled another way (D1) — a review that quietly substituted a different
// source would be a review of something other than what it claims.
const buildSections = (input) => {
  const {
    clientId,
    emr = {},
    encounters = [],
    orders = [],
    results = [],
    prescriptions = [],
    carePlanVersions = [],
    intake = null,
    medReconciliations = [],
    caregiverLogs = [],
    messageThreads = [],
    consentElections = null,
    documents = [],
    notRead = []
  } = input || {};

  const sections = [];
  const dropped = [];
  const missing = [...notRead];

  const keep = (row, label) => {
    if (belongsTo(row, clientId)) return true;
    // Named by LABEL only. What was in it is exactly what must not be recorded.
    dropped.push(label);
    return false;
  };

  // The EMR sections. Each is listed as not read when the clinician's session
  // could not produce it, rather than being filled from somewhere else.
  const emrSections = [
    [SECTION_KINDS.DEMOGRAPHICS, 'Demographics', emr.demographics],
    [SECTION_KINDS.PROBLEMS, 'Problem list', emr.problems],
    [SECTION_KINDS.MEDICATIONS, 'Medications', emr.medications],
    [SECTION_KINDS.ALLERGIES, 'Allergies', emr.allergies],
    [SECTION_KINDS.VITALS, 'Vitals', emr.vitals],
    [SECTION_KINDS.ENCOUNTERS, 'Encounter list', emr.encounters],
    [SECTION_KINDS.IMMUNIZATIONS, 'Immunizations', emr.immunizations],
    [SECTION_KINDS.PROCEDURES, 'Procedures', emr.procedures],
    [SECTION_KINDS.GOALS, 'Goals', emr.goals],
    [SECTION_KINDS.CARE_TEAM, 'Care team', emr.careTeam],
    [SECTION_KINDS.COVERAGE, 'Coverage', emr.coverage]
  ];
  for (const [kind, title, value] of emrSections) {
    if (value === undefined || value === null) {
      if (!missing.some(n => n.sourceId === kind)) {
        missing.push({ sourceId: kind, why: 'not returned by the clinician\'s own EMR session' });
      }
      continue;
    }
    sections.push(section({ sourceId: kind, kind, title, value }));
  }

  // Every encounter, with its note read by the RECORDED narrative sid — never
  // a list read, which can return another encounter's notes (openemr.js).
  for (const e of encounters) {
    if (!keep(e, `${PREFIX.ENCOUNTER}:${e && e.encounterUuid}`)) continue;
    sections.push(section({
      sourceId: `${PREFIX.ENCOUNTER}:${e.encounterUuid}`,
      kind: 'encounter',
      title: e.type || 'Encounter',
      date: e.date || null,
      encounterUuid: e.encounterUuid,
      draft: !!e.unsigned,
      value: {
        type: e.type, date: e.date, clinician: e.clinician,
        diagnoses: e.diagnoses, serviceCodes: e.serviceCodes,
        note: e.note, addenda: e.addenda,
        coSignStatus: e.coSignStatus, riskAssessment: e.riskAssessment
      }
    }));
  }

  const perRow = [
    [orders, PREFIX.ORDER, 'order', (o) => o.id, (o) => o.orderType || 'Order'],
    [results, PREFIX.RESULT, 'result', (r) => r.id, (r) => r.title || 'Result'],
    [prescriptions, PREFIX.RX, 'prescription', (r) => r.id, (r) => r.drug || 'Prescription'],
    [medReconciliations, PREFIX.MED_REC, 'medication reconciliation', (m, i) => m.id || i + 1, () => 'Medication reconciliation'],
    [caregiverLogs, PREFIX.CAREGIVER, 'caregiver record', (c) => c.id, (c) => c.kind || 'Caregiver record']
  ];
  for (const [rows, prefix, kind, idOf, titleOf] of perRow) {
    (rows || []).forEach((row, i) => {
      const sourceId = `${prefix}:${idOf(row, i)}`;
      if (!keep(row, sourceId)) return;
      sections.push(section({
        sourceId, kind, title: titleOf(row, i),
        date: row.date || row.at || row.createdAt || null,
        encounterUuid: row.encounterUuid || null,
        value: row
      }));
    });
  }

  // Every care-plan version. Signatures are stripped by stripNonClinical;
  // what the plan SAID is the clinical content.
  for (const v of carePlanVersions) {
    if (!keep(v, `${PREFIX.CARE_PLAN}:v${v && v.version}`)) continue;
    sections.push(section({
      sourceId: `${PREFIX.CARE_PLAN}:v${v.version}`,
      kind: 'care plan', title: `Care plan v${v.version}`,
      date: v.effectiveDate || v.at || null, value: v
    }));
  }

  if (intake) {
    sections.push(section({ sourceId: SECTION_KINDS.INTAKE, kind: 'intake', title: 'Intake', value: intake }));
  }
  if (consentElections) {
    // ELECTIONS ONLY — never the consent text, never a signature. What the
    // patient CHOSE is clinical (a code status election changes care); the
    // document they signed is not a clinical fact about them.
    sections.push(section({
      sourceId: SECTION_KINDS.CONSENT_ELECTIONS, kind: 'consent elections',
      title: 'Consent elections', value: consentElections
    }));
  }

  // Care-team message threads the requesting clinician can see. The caller
  // has already applied threadVisibility; anything whose client does not
  // match is still dropped here, because this is the surface where a merge
  // between two patients would be invisible.
  for (const t of messageThreads) {
    const sourceId = `${PREFIX.MESSAGE}:${t && t.threadId}`;
    if (!keep(t, sourceId)) continue;
    sections.push(section({
      sourceId, kind: 'message thread',
      title: t.subject || t.channel || 'Message thread',
      date: t.lastAt || null, value: { channel: t.channel, messages: t.messages }
    }));
  }

  // Documents are carried as their own list (bytes stay out of the text).
  const docs = [];
  for (const d of documents) {
    const sourceId = d.sourceId || `${PREFIX.DOCUMENT}:${d.id}`;
    if (!keep(d, sourceId)) continue;
    docs.push({
      sourceId, kind: 'document', title: d.title || d.fileName || 'Document',
      date: d.date || null, mimeType: d.mimeType, bytes: d.bytes,
      encounterUuid: d.encounterUuid || null
    });
  }

  return { sections, documents: docs, notRead: missing, droppedForeign: dropped };
};

// ── the manifest ──────────────────────────────────────────────────────────
// Every section and document gets a row. The citation check is run against
// this, its ids (only) go in the audit rows, and `notRead` is what the screen
// shows under "Not read".
const buildManifest = ({ sections = [], documents = [], notRead = [], passes = 1 } = {}) => ({
  passes,
  sources: [...sections, ...documents].map(s => ({
    sourceId: s.sourceId, kind: s.kind, title: s.title, date: s.date || null, pass: s.pass || 1
  })),
  notRead: (notRead || []).map(n => (typeof n === 'string' ? { sourceId: n, why: 'could not be read' } : n))
});

const manifestIds = (manifest) => new Set(((manifest && manifest.sources) || []).map(s => s.sourceId));

// ── the planner ───────────────────────────────────────────────────────────
// D4. The server counts the real tokens; this decides the SHAPE of a split,
// because that is the part with rules in it:
//
//   • each encounter stays with its own orders, results and documents — a
//     pass that has the result but not the encounter it belongs to produces a
//     finding nobody can place;
//   • the header sections travel in EVERY pass;
//   • passes are date-ordered, so "pass 2 of 3" means something to a reader.
const BUDGET_FRACTION = 0.9;

const fitsInOnePass = (totalTokens, inputLimit) =>
  !(Number.isFinite(totalTokens) && Number.isFinite(inputLimit)) ||
  totalTokens <= inputLimit * BUDGET_FRACTION;

// The CURRENT care plan travels in every pass too (D4), which means the
// highest version rather than all of them: the superseded versions are
// history and belong to whichever pass their date falls in, but what the plan
// says TODAY is context every finding needs.
const currentCarePlanId = (sections) => {
  const versions = sections
    .map(s => /^careplan:v(\d+)$/.exec(s.sourceId))
    .filter(Boolean)
    .map(m => Number(m[1]));
  return versions.length ? `${PREFIX.CARE_PLAN}:v${Math.max(...versions)}` : null;
};

const splitIntoPasses = ({ sections = [], documents = [], passCount = 2 } = {}) => {
  const n = Math.max(1, Math.floor(passCount));
  const currentPlan = currentCarePlanId(sections);
  const inHeader = (s) => HEADER_KINDS.includes(s.sourceId) || (currentPlan && s.sourceId === currentPlan);
  const header = sections.filter(inHeader);
  const rest = sections.filter(s => !inHeader(s));
  if (n === 1) return [{ pass: 1, of: 1, sections: [...header, ...rest], documents }];

  // Group everything that belongs to one encounter together, keyed by its
  // uuid; anything unattached is its own group, ordered by date.
  const groups = new Map();
  const groupKeyOf = (s) => s.encounterUuid ? `enc:${s.encounterUuid}` : `solo:${s.sourceId}`;
  const add = (s, isDoc) => {
    const key = groupKeyOf(s);
    if (!groups.has(key)) groups.set(key, { key, date: s.date || null, sections: [], documents: [] });
    const g = groups.get(key);
    (isDoc ? g.documents : g.sections).push(s);
    // The group's date is the earliest thing in it, so ordering is stable.
    if (s.date && (!g.date || s.date < g.date)) g.date = s.date;
  };
  rest.forEach(s => add(s, false));
  documents.forEach(d => add(d, true));

  // Undated groups last: a date is what makes a pass boundary meaningful, and
  // guessing one would put a row in the wrong pass silently.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    if (a.date) return -1;
    if (b.date) return 1;
    return 0;
  });

  const per = Math.ceil(ordered.length / n) || 1;
  const passes = [];
  for (let i = 0; i < n; i++) {
    const slice = ordered.slice(i * per, (i + 1) * per);
    if (!slice.length && i > 0) break;
    passes.push({
      pass: passes.length + 1,
      of: n,
      // The header in every pass, as above.
      sections: [...header, ...slice.flatMap(g => g.sections)],
      documents: slice.flatMap(g => g.documents),
      from: slice.map(g => g.date).filter(Boolean).sort()[0] || null,
      to: slice.map(g => g.date).filter(Boolean).sort().slice(-1)[0] || null
    });
  }
  return passes.map((p, i) => ({ ...p, of: passes.length, pass: i + 1 }));
};

// ── citation enforcement (E3) ─────────────────────────────────────────────
// A finding whose citations do not all name a source in the manifest is
// DROPPED AND COUNTED. Not softened, not shown with a warning: a citation
// that does not resolve cannot be checked, and an unverifiable finding in a
// clinician's review is worse than one fewer finding. The count is surfaced so
// nobody has to wonder whether the list is complete.
const enforceCitations = (output, manifest) => {
  const ids = manifestIds(manifest);
  let dropped = 0;
  const cited = (row) => {
    const cites = Array.isArray(row && row.citations) ? row.citations : [];
    if (!cites.length) return false;
    return cites.every(c => c && ids.has(String(c.sourceId)));
  };
  const keepList = (list) => {
    const out = [];
    for (const row of (Array.isArray(list) ? list : [])) {
      if (cited(row)) out.push(row); else dropped++;
    }
    return out;
  };
  return {
    output: {
      ...output,
      findings: keepList(output && output.findings),
      timeline: keepList(output && output.timeline)
    },
    droppedUncited: dropped
  };
};

module.exports = {
  SECTION_KINDS, PREFIX, HEADER_KINDS, DRAFT_HEADING, NON_CLINICAL_KEYS, BUDGET_FRACTION,
  buildSections, buildManifest, manifestIds, splitIntoPasses, fitsInOnePass, enforceCitations,
  currentCarePlanId,
  stripNonClinical, belongsTo, asText, section
};
