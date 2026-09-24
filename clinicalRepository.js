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
// An allergen entered as free text (which is every allergy this practice
// records, since OpenEMR has no RxNorm allergen picker configured) comes back
// from FHIR with `code` set to the data-absent-reason "Unknown" and the actual
// allergen ONLY in the narrative `text.div`. Reading `code` alone rendered
// every allergy in the chart as "Unknown" — including the ones that were there
// before this session. Verified live 2026-09-08 on all four rows.
const NARRATIVE_ABSENT = /data-absent-reason/;
const narrativeText = (r) => String(((r && r.text) || {}).div || '')
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const allergenName = (r) => {
  const coded = codeableText(r && r.code);
  const absent = ((((r && r.code) || {}).coding || [])[0] || {}).system || '';
  if (coded && !NARRATIVE_ABSENT.test(absent)) return coded;
  return narrativeText(r) || coded || 'Unspecified allergy';
};
const summarizeAllergy = (r) => ({
  id: r.id,
  title: allergenName(r),
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

// ── The chart's document list ───────────────────────────────────────
//
// THE PROBLEM THIS SOLVES: a clinician reviewing a chart could see no
// documents at all. Probed live on 8.4 (2026-09-09):
//
//   POST patient/{pid}/document          → 200, body literally `true` (no id)
//   FHIR DocumentReference?patient=...   → 200, total 0 — instance-wide, even
//                                          immediately after a successful upload
//   GET  patient/{pid}/document          → 404 (no list route exists)
//   GET  patient/{pid}/document/{id}     → 500 "CSRF key is empty" — the route
//                                          EXISTS and crashes on a session check
//                                          that has no business running on an
//                                          API request
//
// So OpenEMR takes documents and gives none back. Until the EMR side grows a
// working read, the chart is assembled from what the APP knows it holds — and
// that is most of the chart: every care plan, consent, record release and
// client upload passed through this app on its way in.
//
// Each row says WHERE it can be read from, because that is a real difference a
// clinician needs to see. `openable: false` on an EMR row is not a bug in this
// list; it is the EMR read gap, named on the row rather than hidden by omitting
// it. Omitting it would tell the clinician the document does not exist.
const CHART_DOC_SOURCE = { APP: 'app', EMR: 'emr' };

const buildChartDocumentIndex = (input) => {
  const {
    client = {}, emrRows = [], carePlanVersions = [], roiAuthorizations = [],
    clientUploads = [], consentDefs = [], consentSatisfied = () => false
  } = input || {};

  const rows = [];
  const consents = client.consents || {};
  const consentMeta = client.consentMeta || {};
  const planDocs = client.carePlanDocs || {};
  const coSign = client.carePlanCoSign || {};

  // 1. Care plans — every authored version, not only the current one. A prior
  //    version is the plan that was in force at the time and a reviewer needs it.
  for (const v of carePlanVersions) {
    if (!v || v.client_id !== client.id) continue;
    const signed = !!coSign[`v${v.version}`];
    rows.push({
      id: `careplan:${v.version}`,
      title: `Plan of care — version ${v.version}${signed ? ' (signed)' : ' (awaiting co-signature)'}`,
      category: 'Plan of care',
      date: (coSign[`v${v.version}`] || {}).at || v.createdAt || null,
      contentType: 'application/pdf',
      source: CHART_DOC_SOURCE.APP,
      openable: true,
      // Whether this version also reached the OpenEMR chart, so a reviewer can
      // tell the app's copy from the filed one.
      inChart: !!((planDocs[`v${v.version}`] || {}).chartFiled || {}).emrDocumented
    });
  }

  // 2. Executed consents — the enrollment paperwork, regenerated on demand at
  //    the body version each was signed against.
  for (const def of consentDefs) {
    const status = consents[def.type];
    if (!consentSatisfied(status)) continue;
    const meta = consentMeta[def.type] || {};
    rows.push({
      id: `consent:${def.type}`,
      title: def.title || def.type,
      category: 'Consent',
      date: meta.signedAt || null,
      contentType: 'application/pdf',
      source: CHART_DOC_SOURCE.APP,
      openable: true,
      inChart: false,
      note: status === 'signed_offline' ? 'Signed on paper' : null
    });
  }

  // 3. Transfer-of-Care record releases — one per prior provider.
  for (const a of roiAuthorizations) {
    if (!a || a.client_id !== client.id) continue;
    rows.push({
      id: `roi:${a.id}`,
      title: `Record release — ${a.provider_name || 'prior provider'}`,
      category: 'Record release',
      date: a.created_at || a.signed_at || null,
      contentType: 'application/pdf',
      source: CHART_DOC_SOURCE.APP,
      openable: !!a.generated_pdf_drive_url,
      inChart: false,
      note: a.generated_pdf_drive_url ? null : 'No stored copy on file'
    });
  }

  // 4. What the client sent us — ID, insurance card, POA, records from a prior
  //    provider. A rejected upload is deliberately excluded: it is not evidence
  //    of anything and showing it in a chart would mislead.
  for (const u of clientUploads) {
    if (!u || u.clientId !== client.id || u.status === 'rejected') continue;
    // This is also what makes a `readable` flag unnecessary on the row below: a
    // rejected document never reaches the chart at all, so nothing downstream
    // can offer to read one. A field that is always true reads like a guard and
    // is not one.
    rows.push({
      id: `upload:${u.id}`,
      title: u.fileName || 'Client document',
      category: 'From the client',
      date: u.uploadedAt || null,
      contentType: u.mimeType || null,
      source: CHART_DOC_SOURCE.APP,
      openable: true,
      inChart: false,
      // Only an UPLOAD row can be read into proposals: it is the one kind that
      // corresponds to a stored file the extractor can fetch. A consent, a care
      // plan and a record release are documents this app GENERATED from the
      // record, so reading them back would propose the record to itself.
      //
      // `uploadId` and `kind` are carried so the chart can offer the control
      // without re-deriving either from the composite id — parsing an id back
      // apart in a page is how a prefix change becomes a silent breakage.
      uploadId: u.id,
      kind: u.kind || null,
      // WHO FILED IT. A reviewer weighs a document the client sent differently
      // from one the office scanned in, and the read should say which it is.
      filedBy: u.source === 'staff' ? 'staff' : 'client',
      note: u.status === 'accepted' ? null : 'Not yet reviewed'
    });
  }

  // 5. What OpenEMR itself holds — a fax, an outside record, anything filed
  //    straight into the chart. This is the half the app can never know about
  //    on its own, and the only reason the Phase 6B document routes exist.
  //
  //    `emrReadSupported` is FEATURE-DETECTED by the transport, not assumed. It
  //    is false until the patch is rebuilt and deployed, and the difference
  //    matters: a row that cannot be opened because the read is not deployed is
  //    a different fact from one that cannot be opened at all, and a clinician
  //    who is told the wrong one goes looking for the wrong problem.
  const emrReadSupported = !!input.emrReadSupported;
  for (const r of emrRows) {
    rows.push({
      id: `emr:${r.id}`,
      title: r.description || r.name || 'Document',
      category: 'In the EMR',
      date: r.date || null,
      contentType: r.contentType || r.mimetype || null,
      source: CHART_DOC_SOURCE.EMR,
      openable: emrReadSupported,
      inChart: true,
      note: emrReadSupported ? null : 'Open in OpenEMR — the document read is not deployed on this instance yet'
    });
  }

  // Newest first; undated rows last rather than sorted as epoch zero.
  return rows.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return String(b.date).localeCompare(String(a.date));
  });
};

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
  // Session 4.12 Scope G — psychiatry is the SAME ambulatory encounter with a
  // different exam, not a different kind of note. So the MSE is a section of
  // the H&P beside the systems exam, and it is offered ALONGSIDE it rather
  // than instead of it: a psychiatric home visit still takes vitals and still
  // looks at the home, and a note shape that dropped those would document
  // less of a visit than the paper it replaced.
  mentalStatusExam: 'Mental status exam',
  skinWound: 'Skin & wound (with measurements)',
  painAssessment: 'Pain assessment (PAINAD-style)',
  homeHazards: 'Home-hazard inventory',
  triage: 'RN triage / Track assignment'
};
// NOTE: `hpSectionsFor` lived here and was DEAD from the moment it was
// written — nothing ever called it, which is the inert-capability trap this
// repo keeps paying for. `appointmentTypes.sectionsFor` answers this question
// now, per visit rather than per patient, and is actually read.

const kvLines = (obj) => Object.entries(obj || {})
  .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
  .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}: ${Array.isArray(v) ? v.join(', ') : v}`);

// ---- H&P note drafts (2026-09-22) ----
//
// A draft is documentation IN PROGRESS, so it is deliberately NOT held to the
// rules `buildHpWrites` enforces: an incomplete note is the whole point, and
// the both-arms BP rule applies when the note is FILED to the chart, never
// while it is being typed. Refusing to save a half-finished assessment is how
// a clinician loses an hour of work to a browser reload.
//
// The section vocabulary is DERIVED from HP_SECTION_LABELS rather than listed
// a second time, so a section added to the H&P is draftable the day it lands
// instead of being silently dropped by an allow-list nobody widened.
const DRAFT_TEXT_FIELDS = ['visitDate', 'chiefConcern', 'subjective', 'assessment', 'plan'];
const DRAFT_VITALS_FIELDS = ['bpRightSys', 'bpRightDia', 'bpLeftSys', 'bpLeftDia', 'hr', 'temp', 'rr', 'spo2', 'weight', 'height'];
const DRAFT_MAX_FIELD = 8000;
const DRAFT_MAX_SECTION_KEYS = 64;
const DRAFT_MAX_TOTAL = 200000;

const sanitizeNoteDraft = (form) => {
  if (!form || typeof form !== 'object' || Array.isArray(form)) {
    return { error: 'A draft payload is required', code: 'DRAFT_EMPTY' };
  }
  const str = (v) => String(v === null || v === undefined ? '' : v).slice(0, DRAFT_MAX_FIELD);
  const draft = {};
  for (const k of DRAFT_TEXT_FIELDS) {
    if (form[k] !== undefined && form[k] !== null) draft[k] = str(form[k]);
  }
  if (form.vitals && typeof form.vitals === 'object' && !Array.isArray(form.vitals)) {
    const v = {};
    for (const k of DRAFT_VITALS_FIELDS) {
      if (form.vitals[k] !== undefined && form.vitals[k] !== null) v[k] = str(form.vitals[k]).slice(0, 16);
    }
    if (Object.keys(v).length) draft.vitals = v;
  }
  for (const section of Object.keys(HP_SECTION_LABELS)) {
    const src = form[section];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    const out = {};
    for (const [k, val] of Object.entries(src).slice(0, DRAFT_MAX_SECTION_KEYS)) {
      // The filed note renders scalars through kvLines; a draft holds the same
      // shape, so a nested object is dropped rather than stored as "[object Object]".
      if (val === null || val === undefined || typeof val === 'object') continue;
      out[String(k).slice(0, 64)] = str(val);
    }
    if (Object.keys(out).length) draft[section] = out;
  }
  if (Array.isArray(form.confirmedFields)) {
    draft.confirmedFields = form.confirmedFields
      .filter(x => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 64));
  }
  if (form.appointmentEid !== undefined && form.appointmentEid !== null && String(form.appointmentEid).trim() !== '') {
    draft.appointmentEid = str(form.appointmentEid).slice(0, 40);
  }
  if (!Object.keys(draft).length) return { error: 'There is nothing in this draft to save', code: 'DRAFT_EMPTY' };
  if (JSON.stringify(draft).length > DRAFT_MAX_TOTAL) {
    return { error: 'This draft is too large to save', code: 'DRAFT_TOO_LARGE' };
  }
  return { draft };
};

// One draft per clinician per patient. The id carries BOTH, because two
// clinicians documenting the same patient on the same day is the normal case
// here — an on-site assessment and a virtual one — and a draft keyed on the
// patient alone would have each of them overwriting the other's note.
const noteDraftId = (clientId, clinicianId) =>
  `${String(clientId)}:${String(clinicianId || 'unknown')}`;

const buildNoteDraft = ({ clientId, actor, draft, at, existing }) => {
  const now = at || new Date().toISOString();
  const who = actorRecord(actor);
  return {
    id: noteDraftId(clientId, who && who.id),
    clientId: String(clientId),
    clinicianId: (who && who.id) || null,
    clinicianName: (who && who.name) || null,
    draft,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now
  };
};

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

// ============================================================
// Session 4.12 Scope G — the risk assessment a psychiatric visit cannot be
// signed without
// ============================================================
// A psychiatric note with no documented risk assessment is the standard-of-
// care failure this exists to stop. So on a psychiatric encounter it is a
// SIGNING blocker — documenting the visit is never blocked, the same rule
// every other blocker in this file follows, because care happens whether or
// not the paperwork is finished and it is the signature that is an assertion.
//
// REQUIRED ONLY WHERE THE ENCOUNTER TYPE IS PSYCHIATRIC. On every encounter
// it would be noise, and noise is how a real refusal gets clicked past; on
// none it is the gap. The encounter type is the fact that decides it, which
// is the same stamp the place of service is checked against.
const RISK_LEVELS = Object.freeze(['none', 'low', 'moderate', 'high', 'imminent']);
// "None" IS an assessment and it satisfies the gate: the record is that
// somebody asked. Refusing to accept it would push a clinician to skip the
// section entirely, which records nothing at all.
const RISK_NEEDS_PLAN = Object.freeze(['moderate', 'high', 'imminent']);
const RISK_DOMAINS = Object.freeze(['suicide', 'homicide', 'selfNeglect']);

const buildRiskAssessment = ({ id, clientId, encounterUuid, form, actor, at }) => {
  const f = form || {};
  const levels = {};
  for (const d of RISK_DOMAINS) {
    const v = String(f[d] || '').trim().toLowerCase();
    if (!RISK_LEVELS.includes(v)) {
      return { error: `${d} risk must be one of: ${RISK_LEVELS.join(', ')}`, code: 'RISK_LEVEL_REQUIRED' };
    }
    levels[d] = v;
  }
  const plan = String(f.plan || '').trim();
  // A plan is required wherever any domain is at moderate or above. Recording
  // "patient endorses suicidal ideation" with nothing about what is being
  // done is a record that somebody SAW it, which is not a record that it was
  // handled — the rule 4.10's abnormal-result follow-up note already sets.
  const raised = RISK_DOMAINS.filter(d => RISK_NEEDS_PLAN.includes(levels[d]));
  if (raised.length && plan.length < 10) {
    return {
      error: `Risk is ${raised.map(d => `${d}: ${levels[d]}`).join(', ')} — say what is being done about it. An assessment with no plan records that it was seen, not that it was handled.`,
      code: 'RISK_PLAN_REQUIRED'
    };
  }
  return {
    assessment: {
      id, clientId, encounterUuid: String(encounterUuid),
      levels,
      protectiveFactors: String(f.protectiveFactors || '').trim().slice(0, 4000),
      meansRestriction: String(f.meansRestriction || '').trim().slice(0, 4000),
      plan: plan.slice(0, 8000),
      at: at || new Date().toISOString(),
      by: actorRecord(actor)
    }
  };
};

// Revising is a NEW row, never a rewrite. Risk changes inside one visit, and
// overwriting would lose that the clinician escalated — the same append-only
// rule the care plan and the escalation trail follow. The latest row is what
// the gate reads.
const latestRiskAssessment = (rows, encounterUuid) =>
  (rows || []).filter(r => r && r.encounterUuid === String(encounterUuid))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;

// Asked of the VISIT, not the patient. A behavioural-health appointment type
// is what makes a risk assessment mandatory; a patient's usual kind of visit
// is not a fact about the one being signed.
const riskAssessmentRequired = (visit) => isBehavioralVisit(visit);
const highestRisk = (assessment) => {
  if (!assessment || !assessment.levels) return null;
  let worst = null; let rank = -1;
  for (const d of RISK_DOMAINS) {
    const i = RISK_LEVELS.indexOf(assessment.levels[d]);
    if (i > rank) { rank = i; worst = assessment.levels[d]; }
  }
  return worst;
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
      // pc_facility (WHERE the visit happens) and pc_billing_location (WHICH
      // ENTITY bills) are deliberately NOT set here. They come from two
      // different sources — the patient's facility assignment and OpenEMR's
      // business entity — and resolving either needs a live read, so the route
      // sets them. This builder used to fill both from one `defaults.facilityId`
      // with a hardcoded '3' behind it, which is how every appointment came to
      // carry the office as its service location. Omitting them means a route
      // that forgets fails loudly at OpenEMR instead of quietly booking a home
      // visit into the office.
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
const rowToPostFields = (row, billingFacilityId) => ({
  pc_catid: String(row.pc_catid || '5'),
  pc_title: String(row.pc_title || 'Clinical visit'),
  pc_duration: String(rowDurationMinutes(row) * 60),
  pc_hometext: String(row.pc_hometext || ''),
  pc_apptstatus: String(row.pc_apptstatus || APPT_STATUS.none),
  pc_eventDate: String(row.pc_eventDate),
  pc_startTime: String(row.pc_startTime || '').slice(0, 5),
  // A swap preserves the original row verbatim, so the service facility is
  // copied as-is. The BILLING entity is re-stamped from `billingFacilityId`
  // instead of being copied, because rows booked before the split carry the
  // service facility in this field; inheriting it would carry that error
  // forward into every reschedule. Neither falls back to a literal id.
  pc_facility: row.pc_facility ? String(row.pc_facility) : '',
  pc_billing_location: String(billingFacilityId || row.pc_billing_location || ''),
  pc_aid: String(row.pc_aid || '')
});

// Cancelled tombstone preserving the superseded slot. Reason is REQUIRED for a
// cancellation (never for the internal reschedule/no-show supersede note).
const buildCancelTombstone = (row, { reason, byName, at, supersededByNote, billingFacilityId }) => {
  const base = rowToPostFields(row, billingFacilityId);
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
const buildReschedulePayloads = (row, built, { byName, at, billingFacilityId }) => {
  const when = at || new Date().toISOString();
  const newRow = {
    ...built.fields,
    pc_aid: built.fields.pc_aid || String(row.pc_aid || ''),
    pc_hometext: [built.fields.pc_hometext,
      `[${when}] Rescheduled from ${row.pc_eventDate} ${String(row.pc_startTime || '').slice(0, 5)}${byName ? ` by ${byName}` : ''}`
    ].filter(Boolean).join('\n').slice(0, 4000)
  };
  const tombstone = buildCancelTombstone(row, {
    at: when, billingFacilityId,
    supersededByNote: `Rescheduled to ${built.fields.pc_eventDate} ${built.fields.pc_startTime}${byName ? ` by ${byName}` : ''}`
  });
  return { newRow, tombstone };
};

// Status swap payload (no-show today; the slot itself is preserved).
const buildStatusSwap = (row, status, { byName, at, billingFacilityId }) => ({
  ...rowToPostFields(row, billingFacilityId),
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

// ---- Author line (spec §4, interim RETIRED in Session 5.2) ----
// Every EMR write now runs under the acting clinician's OWN OpenEMR user
// (authorization_code, emrAuth.js), so OpenEMR attributes it natively and the
// note no longer has to explain that "the EMR sees a service account". The
// clinician's name, credential and NPI still head the note — a note names its
// author, and the NPI is required content on a prescription — but it is an
// author line, not an attribution workaround. The service-account clause and
// the OPENEMR_SERVICE_ACCOUNT constant are gone (build-enforced).
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
const buildAttributionHeader = (actor) =>
  `[GFC CLINICIAN] ${actorStamp(actor)} — documented via the GFC Care Platform`;

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
    // Lands in OpenEMR's billing view for back-office staff. Still set at
    // create, but no longer ONLY settable there: 4.5 can change it afterwards
    // through the encounter PUT, which works on 8.4 with `user` + `group`.
    billing_note: `Rendering clinician: ${stamp}. Coding is recorded by the GFC Care Platform (see the GFC structured note on this encounter).`.slice(0, 500)
  };
  // Scope D: per-visit billing facility on form_encounter. Omitted when the
  // clinician did not choose one, so the transport's instance default applies.
  // Never a charge field — see buildChargePayloads.
  if (/^\d+$/.test(String(form.billingFacilityId || ''))) {
    encounter.billing_facility = String(form.billingFacilityId);
  }
  const header = buildAttributionHeader(actor);
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
// `encounterType` is stamped HERE, at creation, from the patient's admin-set
// default resolved against the booking — not re-derived at signing. At signing
// the stamp is checked against the POS OpenEMR actually holds, and two
// independent facts are what make that check mean anything: re-deriving the
// type from the encounter's own POS would make it agree with itself.
const buildEncounterBillingRecord = ({ id, clientId, puuid, encounterUuid, encounterEid, reason, date, actor, billingNpi, narrativeNoteSid, visit, at }) => ({
  id,
  visit: normalizeVisit(visit),
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

// ============================================================
// What a visit IS — Service + Appointment Type → Modality → Location
// ============================================================
// Owner config 2026-09-23. This REPLACES the flat `ENCOUNTER_TYPES` list,
// which tangled "where did this happen" and "what kind of visit was it" into
// one field and so needed a separate entry for every combination.
//
// The vocabulary, the place-of-service matrix, the code families and the note
// templates all live in `appointmentTypes.js`. Nothing is restated here: a
// second copy of which place of service a location carries is a second answer
// to a question that decides a claim.
const apptTypes = require('./appointmentTypes');

const VISIT_POS_DISAGREES = 'VISIT_POS_MISMATCH';

// The visit descriptor stamped on the encounter, normalised. A field the
// catalog does not know becomes null rather than being stored, because an
// invented appointment type reads back as a real one to everything
// downstream and would never match a place of service.
const normalizeVisit = (v) => {
  const raw = v && typeof v === 'object' ? v : {};
  const type = apptTypes.typeByKey(raw.appointmentType);
  const modality = apptTypes.modalityByKey(raw.modality);
  const location = apptTypes.locationByKey(raw.location);
  return {
    appointmentType: type ? type.key : null,
    modality: modality ? modality.key : null,
    location: location ? location.key : null
  };
};

const visitLabel = (v) => {
  const n = normalizeVisit(v);
  const type = apptTypes.typeByKey(n.appointmentType);
  const modality = apptTypes.modalityByKey(n.modality);
  const location = apptTypes.locationByKey(n.location);
  if (!type || !modality || !location) return null;
  return `${type.label} · ${modality.label} · ${location.label}`;
};

// THE REFUSAL, AND IT NAMES BOTH VALUES. A signed encounter becomes a claim:
// a telehealth visit billed at the patient's home place of service, or a
// clinic visit billed as a home visit, is a false statement about where care
// happened. What the visit SHOULD bill at is computed from its own modality
// and location; what it DOES carry is read off the encounter OpenEMR holds.
// Two independent facts, which is the only reason comparing them proves
// anything.
const checkVisitAgainstPos = ({ visit, posCode, facilityName, facilityPos }) => {
  const n = normalizeVisit(visit);
  if (!n.modality || !n.location) return { ok: true, error: null, code: null };
  const expected = apptTypes.resolvePos({ modality: n.modality, location: n.location, facilityPos: facilityPos || posCode });
  if (expected.error) return { ok: false, code: expected.code, error: expected.error };
  const actual = String(posCode || '').trim();
  if (!actual) {
    return {
      ok: false, code: 'VISIT_NO_POS',
      error: `This visit is recorded as ${visitLabel(n) || 'an unresolved visit'}, which bills at place of service ${expected.pos}, but ${facilityName ? `the facility "${facilityName}"` : 'the encounter'} carries none. An admin sets it on the facility in OpenEMR.`
    };
  }
  if (actual === expected.pos) return { ok: true, error: null, code: null };
  return {
    ok: false, code: VISIT_POS_DISAGREES,
    error: `This visit is recorded as ${visitLabel(n)}, which bills at place of service ${expected.pos}, but the encounter carries place of service ${actual}. One of the two is wrong, and a signed encounter becomes a claim — correct the visit's modality and location, or the facility in OpenEMR.`
  };
};

// Which sections this note must contain, answered by the catalog for THIS
// visit: the same appointment type demands a physical exam in person and does
// not over video.
const requiredSectionsForVisit = (visit, { riskPositive } = {}) => {
  const n = normalizeVisit(visit);
  if (!n.appointmentType) return [];
  return apptTypes.requiredSectionKeys(n.appointmentType, { modality: n.modality, riskPositive });
};

const isBehavioralVisit = (visit) => apptTypes.isBehavioralHealth(normalizeVisit(visit).appointmentType);
const isTelehealthVisit = (visit) => normalizeVisit(visit).modality === 'telehealth';


// ---- Sign & close (spec §3) ----
const SIGN_BLOCKER_CODES = {
  note: 'SIGN_NO_NOTE',
  diagnosis: 'SIGN_NO_DIAGNOSIS',
  service: 'SIGN_NO_SERVICE',
  service_dx_link: 'SIGN_UNLINKED_SERVICE',
  billing_npi: 'SIGN_NO_BILLING_NPI',
  // A signed encounter becomes a claim, and a claim needs a real place of
  // service. Documenting the visit is never blocked; billing it is.
  facility_pos: 'SIGN_NO_FACILITY_POS',
  // A POS that EXISTS but contradicts what kind of visit this was is a worse
  // failure than a missing one, because nothing about it looks wrong: the
  // claim goes out asserting care happened somewhere it did not.
  encounter_type_pos: VISIT_POS_DISAGREES,
  // Scope F/G: the note template this appointment type declares.
  note_sections: 'SIGN_NOTE_SECTIONS_INCOMPLETE',
  // Scope G. A psychiatric note signed with no documented risk assessment.
  risk_assessment: 'SIGN_NO_RISK_ASSESSMENT'
};
const SIGN_BLOCKER_LABELS = {
  note: 'a documented note',
  diagnosis: 'at least one ICD-10 diagnosis',
  service: 'at least one CPT/HCPCS service code',
  service_dx_link: 'every service linked to a diagnosis',
  billing_npi: 'the billing provider NPI configured in settings',
  facility_pos: "a place of service — this patient has no OpenEMR facility assigned, or their facility has no POS code on its record. An admin fixes it on the patient or the facility, not here",
  risk_assessment: 'a risk assessment — this is a psychiatric visit and it cannot be signed without one'
};
// `posCode` is the place of service the encounter actually carries, derived
// from the patient's facility. Documenting a visit is never blocked on it —
// care happens whether or not an admin has finished the facility setup — but
// SIGNING is, because a signed encounter becomes a claim and a claim with an
// unverified POS is the silent error this whole change exists to prevent.
//
// `encounterType` is what the admin recorded this patient's visits as, resolved
// against the booking. Where the type names a place of service, it is checked
// against the one the facility resolved to, and a disagreement REFUSES the
// signature naming both values — see checkEncounterTypeAgainstPos. That refusal
// carries its own sentence rather than a label in the joined list, because the
// reader has to know which of the two is wrong and neither is fixed from here.
const checkSignReadiness = ({ hasNote, record, billingNpi, posCode, visit, facilityName, riskAssessment, completedSections, ncciPtpEdits, ncciMue, ncciSourceVersion }) => {
  const missing = [];
  if (!hasNote) missing.push('note');
  missing.push(...deriveCodingStatus(record).missing);
  if (!normalizeNpiValue(billingNpi)) missing.push('billing_npi');
  const pos = String(posCode || '').trim();
  if (!pos) missing.push('facility_pos');
  // Only asked where a POS actually resolved: with none, `facility_pos` above
  // already blocks and saying it twice in two different sentences would send
  // the reader at two layers for one problem.
  const agreement = pos
    ? checkVisitAgainstPos({ visit, posCode: pos, facilityName })
    : { ok: true, error: null, code: null };
  if (!agreement.ok) missing.push('encounter_type_pos');

  // Scope G, asked of the VISIT: a behavioural-health appointment type cannot
  // be signed without a risk assessment.
  if (riskAssessmentRequired(visit) && !riskAssessment) missing.push('risk_assessment');

  // Scope F: the appointment type's own note template, resolved for THIS
  // visit — a physical exam is demanded in person and not over video. The
  // SAFETY PLAN becomes required once the risk recorded on this encounter is
  // not negative, which is why the risk row is read here rather than the
  // template being fixed at the start of the visit.
  const riskPositive = !!(riskAssessment && riskAssessment.levels &&
    RISK_DOMAINS.some(d => RISK_NEEDS_PLAN.includes(riskAssessment.levels[d])));
  const required = requiredSectionsForVisit(visit, { riskPositive });
  const done = new Set((Array.isArray(completedSections) ? completedSections : []).map(String));
  const openSections = required.filter(k => !done.has(k));
  if (openSections.length) missing.push('note_sections');

  // NCCI/MUE: a bundling conflict or a unit-cap overage between the codes on
  // THIS encounter. Asked of the record's own services, alongside the POS
  // check above — a caller that never mentions ncci (every pre-existing
  // caller of this function) gets ok:true from it and nothing changes; see
  // checkNcciBundling's own comment.
  const ncci = checkNcciBundling(record && record.services, visit, { ptpEdits: ncciPtpEdits, mueByCode: ncciMue, sourceVersion: ncciSourceVersion });
  if (!ncci.ok) missing.push('ncci_bundling');

  const labelled = missing.filter(m => m !== 'encounter_type_pos' && m !== 'note_sections' && m !== 'ncci_bundling');
  const sentences = [];
  if (labelled.length) sentences.push(`Cannot sign: the encounter needs ${labelled.map(m => SIGN_BLOCKER_LABELS[m]).join(', ')}.`);
  if (openSections.length) {
    // NAMED, never counted. "3 sections outstanding" is a number a clinician
    // has to go hunting through their own note for.
    const type = apptTypes.typeByKey(normalizeVisit(visit).appointmentType);
    sentences.push(`Cannot sign: this ${type ? type.label : 'visit'} note still needs ${openSections.map(k => apptTypes.SECTIONS[k]).join(', ')}.`);
  }
  if (!agreement.ok) sentences.push(`Cannot sign: ${agreement.error}`);
  if (!ncci.ok) sentences.push(ncci.message);
  return {
    ok: missing.length === 0,
    missing,
    openSections,
    // 'ncci_bundling' is one missing-key that can carry SEVERAL specific
    // codes (a PTP block and an MUE overage can both be true at once), so it
    // expands rather than mapping 1:1 like every other blocker.
    codes: missing.flatMap(m => (m === 'ncci_bundling' ? ncci.codes : [SIGN_BLOCKER_CODES[m]])),
    message: sentences.length ? sentences.join(' ') : null,
    // Present even when ok:true: an allowed-but-flagged PTP pair (a modifier
    // was required AND present) is exactly the case that needs a human to
    // see it rather than pass silently.
    warnings: ncci.warnings
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
  // ── Session 4.10: the schedule and the prescriber's credential ──────────
  // `authority` is the answer controlledSubstances.evaluatePrescription gave the
  // ROUTE. It is required here rather than optional: the whole point of Scope B
  // is that a prescription cannot be recorded without the scope check having
  // run, and a builder that quietly accepts a missing verdict is a builder a
  // later route can call without one.
  const auth = i.authority;
  if (!auth || !auth.schedule || !auth.prescriberCredential) {
    return { error: 'A prescription requires a declared schedule and a prescriber credential', code: 'RX_NO_SCHEDULE' };
  }
  return {
    prescription: {
      id, clientId, puuid, encounterUuid: String(encounterUuid),
      kind, drug: drug.slice(0, 150), dose: dose.slice(0, 60), route, frequency: frequency.slice(0, 100),
      quantity, refills, date,
      instructions: String(i.instructions || '').trim().slice(0, 1000),
      schedule: auth.schedule,
      prescriberCredential: auth.prescriberCredential,
      // The DEA number is recorded because a controlled prescription is written
      // UNDER a registration and the chart has to say which one. Not for a
      // non-controlled drug, where it is not part of the record.
      deaNumber: (auth.dea && auth.dea.deaNumber) || null,
      pdmpAttestation: auth.pdmpAttestation || null,
      prescriber: actorRecord(actor),
      transmission: 'none', // e-prescribing is out of scope by owner decision
      emrMedicationId: null, // OpenEMR medication-list row id once written
      createdAt: at || new Date().toISOString()
    }
  };
};
// 4.5: 8.4 has a real prescription write, so the Rx becomes a first-class
// prescription row instead of a medication-list row with the sig packed into
// its title (the 7.0.4 workaround, retired). `patient_id` is added by the
// transport, which resolves the numeric pid.
//
// `note` carries the acting clinician's name and NPI: OpenEMR attributes every
// API write to the gfc-app-api service account, so without this stamp the
// prescriber is unrecoverable from the EMR side (attribution interim, spec §4,
// until Session 5 per-user auth).
//
// TWO THINGS THIS GUARDS, both found by the shadow-data audit (2026-09-08):
//
// G5a — the date. The prescriptions table reads `date_added`. `start_date` is
// accepted and silently discarded, so every Rx written before this landed with
// a null date. Verified live both ways.
//
// G5b — route and frequency. OpenEMR resolves both against its `drug_route`
// and `drug_interval` option lists, and on this instance BOTH LISTS ARE EMPTY
// (0 rows, verified live), so there is no id for a value to resolve to and the
// columns store null. That is an instance data gap like the ICD-10 load, not
// something the app can fix by sending a different shape. The structured
// fields are still sent, so they start working the day the lists are seeded.
//
// Until then route and frequency ride in `note`, which is free text and does
// persist. A prescription without a route or a frequency is not a prescription,
// so the sig is assembled first and the note is trimmed from the SIG end: the
// prescriber stamp is attribution and must survive truncation intact.
const prescriptionToEmrRow = (rx) => {
  // 4.10: the schedule, the credential and the PDMP check ride in the note too.
  // A controlled prescription recorded in the chart without its schedule is a
  // record that does not say what it was, and the note is the only field on this
  // instance that reliably persists free text (drug_route / drug_interval are
  // empty option lists — see G5b below).
  const sched = rx.schedule && rx.schedule !== 'non_controlled' ? ` | ${rx.schedule}` : '';
  const cred = rx.prescriberCredential ? ` ${rx.prescriberCredential}` : '';
  const pdmp = rx.pdmpAttestation && rx.pdmpAttestation.checked ? ` | PDMP checked ${rx.pdmpAttestation.checkedOn}` : '';
  const tail = ` | ${rx.kind === 'refill' ? 'Refill' : 'New Rx'}${sched} | Prescriber: ${(rx.prescriber && rx.prescriber.name) || 'unknown'}${cred} (NPI ${(rx.prescriber && rx.prescriber.npi) || 'none'})${pdmp}`;
  const sig = [rx.dose, rx.route, rx.frequency].filter(Boolean).join(' ');
  const head = [sig ? `Sig: ${sig}` : null, rx.instructions].filter(Boolean).join('. ');
  return {
    drug: String(rx.drug || '').slice(0, 150),
    dosage: `${rx.dose}`.slice(0, 100),
    quantity: String(rx.quantity),
    route: rx.route || null,
    interval: String(rx.frequency || '').slice(0, 100),
    refills: rx.refills,
    date_added: rx.date,
    note: (head.slice(0, Math.max(0, 255 - tail.length)) + tail).slice(0, 255)
  };
};

// ---- Facility and POS resolution (Session 4.5, owner spec 2026-09-08) ----
//
// POS IS A PROPERTY OF THE FACILITY RECORD, SET ONCE. A clinician never sees or
// chooses a POS number, and it is never a per-visit dropdown.
//
// What connects a visit to the right POS is THE PATIENT. Each patient lives
// somewhere fixed, so each patient record is assigned to a facility: a Hickory
// Log resident to the Hickory Log record (POS 13/14), an Ellijay client to the
// private-residence record (POS 12). The encounter inherits both the facility
// and its POS from that assignment.
//
// WHAT THIS REPLACES, AND WHY IT MATTERS: the app used to stamp every encounter
// with one hardcoded facility and POS 12 from its own settings, regardless of
// who the patient was. That is correct only while every patient is a private
// residence. The moment Hickory Log goes live it breaks silently — POS 12 on
// claims that should read 13 or 14. So the global default is never a fallback
// here: a patient with no facility assignment is reported, not defaulted.
//
// Telehealth is the ONE legitimate per-visit variation, because the same
// patient can be seen in person one week and by video the next. It keys off the
// appointment's location marker (4.2's `[GFC location=telehealth]`), not off a
// dropdown a clinician has to remember.
// The BILLING facility — the business entity on the claim. This is the other
// half of the pair, and the two must never come from one source.
//
// THE DEFECT THIS CLOSES (owner report, 2026-09-09). Service location and
// billing entity were both derived from a single setting, so they always
// matched. For a practice whose care happens in people's homes that is exactly
// backwards: the service location moves with the patient, the billing entity
// never moves. Encounters were split in 4.5, but APPOINTMENTS were not —
// buildAppointmentFields set `pc_facility` and `pc_billing_location` from the
// same `defaults.facilityId`, each falling back to a hardcoded '3'. Every
// appointment ever booked carries the office as its service location.
//
// Resolved from OpenEMR rather than from config, because OpenEMR already
// records which facility is the business entity and a config value can drift
// from it silently. Order: the primary business entity, then a lone billing
// location, then an explicit configured id. A configured id that DISAGREES
// with OpenEMR is reported, never silently preferred — that disagreement is a
// wrong address on a claim.
const BILLING_FACILITY_UNRESOLVED = 'BILLING_FACILITY_UNRESOLVED';
const isFlagOn = (v) => v === 1 || v === '1' || v === true;
const resolveBillingFacility = ({ facilities, configuredId }) => {
  const rows = facilities || [];
  const cfg = configuredId ? String(configuredId) : null;
  const byId = new Map(rows.map(f => [String(f.id), f]));
  const primary = rows.filter(f => isFlagOn(f.primary_business_entity));
  const billing = rows.filter(f => isFlagOn(f.billing_location));
  const openEmrPick = primary.length === 1 ? primary[0]
    : (primary.length === 0 && billing.length === 1 ? billing[0] : null);

  // AN EXPLICIT CONFIGURED ID WINS. It is a deliberate decision by the practice
  // about who bills, and OpenEMR's primary-business-entity flag is not always
  // set to reflect it — on this instance OpenEMR flags 4 (Buckhead) while the
  // owner's decision (2026-09-09) is 3 (Vinings). Deferring to OpenEMR there
  // would put the wrong address on every claim.
  //
  // But it is never silent: a disagreement is reported every time, because the
  // durable fix is to make OpenEMR say the same thing, and a warning nobody
  // ever sees is how the two drift apart again.
  if (cfg && byId.has(cfg)) {
    const f = byId.get(cfg);
    const disagrees = openEmrPick && String(openEmrPick.id) !== cfg;
    return {
      facilityId: cfg, facilityName: f.name || null, source: 'configured',
      warning: disagrees
        ? `Billing to the configured facility ${cfg} ("${f.name || cfg}"), but OpenEMR marks ${openEmrPick.id} ("${openEmrPick.name || openEmrPick.id}") as its primary business entity. The configured value is used because it is a deliberate decision; mark ${cfg} as the primary business entity in OpenEMR so the two agree.`
        : (!openEmrPick && billing.length > 1
          ? `OpenEMR flags ${billing.length} facilities as billing locations (${billing.map(x => x.id).join(', ')}) and names no single business entity, so the configured id ${cfg} was used. An admin should mark exactly one as primary.`
          : null)
    };
  }

  // A configured id that names a facility which does not exist is a mistake
  // worth surfacing, not something to quietly route around.
  const staleWarning = (cfg && !byId.has(cfg))
    ? `The configured billing facility ${cfg} does not exist in OpenEMR, so OpenEMR's own business entity was used instead. An admin should correct the setting.`
    : null;

  if (openEmrPick) {
    const id = String(openEmrPick.id);
    return {
      facilityId: id, facilityName: openEmrPick.name || null,
      source: primary.length === 1 ? 'primary_business_entity' : 'sole_billing_location',
      warning: staleWarning
    };
  }
  return {
    facilityId: null, facilityName: null, source: 'unresolved',
    error: BILLING_FACILITY_UNRESOLVED,
    warning: staleWarning
      || 'The billing facility could not be determined: OpenEMR names no single business entity and no billing facility is configured. An admin marks the GFC LLC record as the primary business entity in OpenEMR.'
  };
};


const FACILITY_UNASSIGNED = 'FACILITY_NOT_ASSIGNED';
const resolveEncounterFacility = ({ patientFacilityId, telehealthFacilityId, appointmentLocation, facilities }) => {
  const byId = new Map((facilities || []).map(f => [String(f.id), f]));
  const isTelehealth = String(appointmentLocation || '').toLowerCase() === 'telehealth';

  // Telehealth overrides the patient's usual place, when a telehealth facility
  // record exists to carry POS 10. Without one, fall through to the patient's
  // facility and say so rather than inventing a code.
  if (isTelehealth && telehealthFacilityId && byId.has(String(telehealthFacilityId))) {
    const f = byId.get(String(telehealthFacilityId));
    return { facilityId: String(f.id), posCode: f.pos_code ? String(f.pos_code) : null,
      facilityName: f.name || null, source: 'telehealth_appointment',
      warning: f.pos_code ? null : `The telehealth facility "${f.name || f.id}" has no POS on its record in OpenEMR.` };
  }

  if (!patientFacilityId) {
    return { facilityId: null, posCode: null, facilityName: null, source: 'unassigned',
      error: FACILITY_UNASSIGNED,
      warning: 'This patient is not assigned to an OpenEMR facility, so the place of service on their claim cannot be derived. An admin assigns it on the patient record.' };
  }
  const f = byId.get(String(patientFacilityId));
  if (!f) {
    return { facilityId: String(patientFacilityId), posCode: null, facilityName: null, source: 'patient_stale',
      error: FACILITY_UNASSIGNED,
      warning: `This patient is assigned to OpenEMR facility ${patientFacilityId}, which no longer exists. An admin re-assigns it.` };
  }
  return {
    facilityId: String(f.id),
    posCode: f.pos_code ? String(f.pos_code) : null,
    facilityName: f.name || null,
    source: isTelehealth ? 'patient_facility_no_telehealth_record' : 'patient_facility',
    warning: f.pos_code
      ? (isTelehealth ? 'This visit is telehealth but no telehealth facility record exists, so the patient\'s usual place of service was used. Add a telehealth facility (POS 10) in OpenEMR.' : null)
      : `Facility "${f.name || f.id}" has no place-of-service code on its record in OpenEMR. An admin sets it on the facility, not here.`
  };
};

// ---- Phase 6B charge payloads (Session 4.5) ----
//
// One charge line per service code, each carrying the encounter's diagnosis
// pointers. The controller stores them X12-shaped ("ICD10|E11.9:ICD10|I10:").
//
// THE FAILURE THIS GUARDS AGAINST: Phase 6B's acceptance took three runs, and
// the second defect was introduced by the fix for the first — a loop reused
// the variable holding the CPT, so the charge billed the diagnosis code. It
// returned 201 and looked correct in Billing Manager; it would have surfaced
// weeks later as a denial. So `code` is read from the SERVICE and `diagnoses`
// only ever from the diagnosis list, and buildChargePayloads is pure and unit
// tested for exactly that separation.
//
// billing_facility is deliberately absent: addBilling() has no such parameter
// and the billing table no such column. It lives on form_encounter (Scope D).
//
// TWO KEYS WERE WRONG HERE AND BOTH FAILED SILENTLY (found 2026-09-23, fixed
// with the encounter type). This function read `svc.modifier` and
// `svc.linkedDiagnoses`; `buildEncounterServices` stores `modifiers` (an
// array) and `dxLinks`. So EVERY modifier a clinician entered was dropped from
// the charge — the field is on the form, validated, stored, and never reached
// a claim — and the per-service diagnosis pointers NEVER fired, so every
// service was billed against every encounter diagnosis. The second is the
// worse one: a visit coded for diabetes and a separate service coded for
// hypertension both went out pointing at both, which is a medical-necessity
// misstatement. Same key-mismatch class that cost Phase 6B three acceptance
// runs, and it returned 201 and looked right in Billing Manager either way.
//
// THE TELEHEALTH MODIFIER IS DERIVED, NOT TYPED. A telehealth encounter type
// bills at POS 10 and carries modifier 95 (synchronous audio-video). It is
// added from the encounter type for the same reason the POS is: a clinician
// who forgets it produces a claim that reads as an in-person visit. GQ and 93
// are deliberately NOT derived — the app cannot observe whether a visit was
// store-and-forward or audio-only, and asserting audio-only about a video
// visit is a false claim, so those stay a clinician's own entry.
const TELEHEALTH_MODIFIER = '95';
const modifiersForCharge = (svc, visit) => {
  const own = Array.isArray(svc && svc.modifiers) ? svc.modifiers : [];
  // Off the MODALITY, which is the fact that decides it. A telehealth visit
  // carries the modifier wherever the patient was sitting.
  const derived = isTelehealthVisit(visit) ? [TELEHEALTH_MODIFIER] : [];
  // The clinician's own entry first: modifier ORDER is meaningful on a claim
  // line, and a pricing modifier they put first must stay first.
  const all = [];
  for (const m of [...own, ...derived]) {
    const v = String(m || '').trim().toUpperCase();
    if (/^[A-Z0-9]{2}$/.test(v) && !all.includes(v)) all.push(v);
  }
  // X12 carries at most four modifiers on a line; OpenEMR stores them as one
  // colon-joined string, the same shape its own Fee Sheet writes.
  return all.slice(0, 4).join(':');
};
const buildChargePayloads = (record, { providerId, visit } = {}) => {
  const diagnoses = (record && record.diagnoses) || [];
  const services = (record && record.services) || [];
  const dxPointers = diagnoses.map(d => ({ code_type: 'ICD10', code: d.code }));
  return services.map(svc => ({
    code_type: svc.codeType === 'HCPCS' ? 'HCPCS' : 'CPT4',
    code: svc.code,                       // NEVER a diagnosis code
    code_text: String(svc.description || svc.label || '').slice(0, 255),
    units: svc.units && svc.units > 0 ? svc.units : 1,
    modifier: modifiersForCharge(svc, visit),
    provider_id: providerId != null ? Number(providerId) : undefined,
    // Link only the diagnoses this service was coded against. `dxLinks` is
    // what buildEncounterServices stores and it is never empty — it refuses a
    // service with no link — so the fallback is for a record written before
    // that rule, not a routine path.
    diagnoses: (Array.isArray(svc.dxLinks) && svc.dxLinks.length
      ? svc.dxLinks.map(c => ({ code_type: 'ICD10', code: c }))
      : dxPointers),
    authorized: 1
  }));
};

// ---- NCCI/MUE bundling check (sign-time gate) ----
//
// Two CMS reference tables decide whether two codes on one encounter may be
// billed together at all (Procedure-to-Procedure edits) and whether a code's
// daily unit count exceeds Medicare's cap (Medically Unlikely Edits). Neither
// is this app's own judgment — both are CMS's published rules, loaded
// quarterly by scripts/load_ncci_tables.js into gfc_ncci_ptp_edits /
// gfc_ncci_mue / gfc_ncci_source_version (KV collections — see that script's
// header for why these are not literal SQL tables).
//
// PURE, like everything else in this file: it takes the loaded reference data
// as an argument and does no I/O. The caller decides whether that data is
// fresh enough to trust; this function only judges what it is handed.
//
// A CALLER THAT NEVER MENTIONS ncci AT ALL gets no check — ok:true,
// unconditionally (see the guard at the top). This is the same graceful
// degradation `visit` already has in checkSignReadiness (an absent visit
// means requiredSectionsForVisit asks for nothing either), and it is what
// keeps every existing checkSignReadiness call in this repo's test suite
// working unchanged. server.js's REAL call sites always resolve and pass a
// concrete sourceVersion — even an "unloaded" one, via
// normalizeNcciSourceVersion, which never returns undefined — so production
// never silently skips this; only a caller that predates NCCI does.
const NCCI_STALE_DAYS = 100;
// The six CMS-recognized PTP bypass modifiers, PLUS 95. 95 (synchronous
// telehealth) is not a documented NCCI bypass modifier — it is included here
// as a pragmatic allowance because it is the ONLY modifier
// `modifiersForCharge` ever DERIVES rather than accepts from the clinician,
// and a bundling check that reads modifiers before that derivation runs
// would false-block a valid telehealth encounter whose only "extra" modifier
// is the one this app itself added. Worth a billing-consultant review before
// this is treated as permanent rather than a stopgap.
const NCCI_UNBUNDLING_MODIFIERS = ['25', '59', 'XE', 'XS', 'XP', 'XU', '95'];

const normalizeNcciSourceVersion = (stored) => {
  const s = stored || {};
  const half = (h) => ({ quarter: (h && h.quarter) || 'UNLOADED', loadedAt: (h && h.loadedAt) || null });
  return { ptp: half(s.ptp), mue: half(s.mue) };
};

const daysSince = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
};

// One blocking reason, or none. Run BEFORE the pair/unit checks — a stale
// table that passes everything is worse than an honest refusal to sign.
const ncciStaleness = (sourceVersion) => {
  const v = normalizeNcciSourceVersion(sourceVersion);
  for (const [label, half] of [['PTP edits', v.ptp], ['MUE table', v.mue]]) {
    if (half.quarter === 'UNLOADED') {
      return { code: 'NCCI_DATA_STALE', error: `the ${label} reference table has never been loaded. Run scripts/load_ncci_tables.js before this encounter can be signed.` };
    }
    const age = Math.floor(daysSince(half.loadedAt));
    if (age > NCCI_STALE_DAYS) {
      return { code: 'NCCI_DATA_STALE', error: `the ${label} reference table (${half.quarter}) was loaded ${age} days ago, over the ${NCCI_STALE_DAYS}-day limit. Run scripts/load_ncci_tables.js before this encounter can be signed.` };
    }
  }
  return null;
};

// CMS's file is directional (a pair appears once, as column1/column2) but a
// service line does not know which of the two it is, so both orders are
// tried.
const findPtpEdit = (edits, codeA, codeB) => {
  for (const e of edits) {
    if (e.column1Code === codeA && e.column2Code === codeB) return e;
    if (e.column1Code === codeB && e.column2Code === codeA) return e;
  }
  return null;
};
const resolvedModifierSet = (svc, visit) => new Set(modifiersForCharge(svc, visit).split(':').filter(Boolean));
const hasUnbundlingModifier = (mods) => NCCI_UNBUNDLING_MODIFIERS.some(m => mods.has(m));

const NCCI_NO_CHECK = Object.freeze({ ok: true, message: null, codes: [], missing: [], warnings: [] });

// checkNcciBundling(services, visit, ncci) — ncci is { ptpEdits, mueByCode,
// sourceVersion }, all pre-resolved by the caller (see the module comment
// above for why an absent `ncci`/`sourceVersion` is a deliberate no-op).
const checkNcciBundling = (services, visit, ncci) => {
  if (!ncci || ncci.sourceVersion === undefined) return NCCI_NO_CHECK;
  const list = Array.isArray(services) ? services : [];
  if (!list.length) return NCCI_NO_CHECK; // nursing documentation, no charge — nothing to bundle-check

  const stale = ncciStaleness(ncci.sourceVersion);
  if (stale) return { ok: false, message: `Cannot sign: the NCCI/MUE reference data is stale — ${stale.error}`, codes: [stale.code], missing: ['ncci_bundling'], warnings: [] };

  const ptpEdits = Array.isArray(ncci.ptpEdits) ? ncci.ptpEdits : [];
  const mueByCode = (ncci.mueByCode && typeof ncci.mueByCode === 'object') ? ncci.mueByCode : {};

  const blocked = [];        // indicator 0 — no modifier fixes this
  const modifierNeeded = []; // indicator 1 — fixable, but nothing did
  const warnings = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      if (!a || !b || a.code === b.code) continue; // same code twice is a units question, not a pairing one
      const edit = findPtpEdit(ptpEdits, a.code, b.code);
      if (!edit) continue;
      const indicator = Number(edit.modifierIndicator);
      if (indicator === 9) continue; // not applicable — treat as no match
      if (indicator === 0) { blocked.push([a.code, b.code]); continue; }
      if (indicator === 1) {
        const unlocked = hasUnbundlingModifier(resolvedModifierSet(a, visit)) || hasUnbundlingModifier(resolvedModifierSet(b, visit));
        if (unlocked) {
          warnings.push(`${a.code} and ${b.code} required a modifier to bill together, and one was present — confirm this pair is genuinely separately identifiable before this claim goes out.`);
        } else {
          modifierNeeded.push([a.code, b.code]);
        }
      }
    }
  }

  const unitsByCode = new Map();
  for (const s of list) { if (s && s.code) unitsByCode.set(s.code, (unitsByCode.get(s.code) || 0) + (Number(s.units) > 0 ? Number(s.units) : 1)); }
  const mueExceeded = [];
  for (const [code, units] of unitsByCode) {
    const mue = mueByCode[code];
    if (!mue || mue.mueValue == null) continue;
    if (units > Number(mue.mueValue)) mueExceeded.push({ code, units, cap: Number(mue.mueValue), mai: mue.mai || null });
  }

  const codes = []; const sentences = [];
  if (blocked.length) {
    codes.push('NCCI_PTP_BLOCKED');
    sentences.push(`Cannot sign: ${blocked.map(([x, y]) => `${x} and ${y}`).join('; ')} cannot be billed together on this encounter — no modifier resolves this pair.`);
  }
  if (modifierNeeded.length) {
    codes.push('NCCI_PTP_MODIFIER_REQUIRED');
    sentences.push(`Cannot sign: ${modifierNeeded.map(([x, y]) => `${x} and ${y}`).join('; ')} may only be billed together with an unbundling modifier (25, 59, XE, XS, XP or XU) on one of the two lines.`);
  }
  if (mueExceeded.length) {
    codes.push('MUE_EXCEEDED');
    sentences.push(`Cannot sign: ${mueExceeded.map(m => `${m.code} is billed at ${m.units} unit${m.units === 1 ? '' : 's'}, over its ${m.cap}-unit Medicare cap${m.mai ? ` (MAI ${m.mai})` : ''}`).join('; ')}.`);
  }
  if (!codes.length) return { ok: true, message: null, codes: [], missing: [], warnings };
  return { ok: false, message: sentences.join(' '), codes, missing: ['ncci_bundling'], warnings };
};

// The app's order lifecycle is ordered → sent → resulted (or cancelled); the
// 6B route's procedure_order table uses OpenEMR's own vocabulary. Map at the
// boundary rather than bending either side.
const ORDER_STATUS_TO_EMR = Object.freeze({
  ordered: 'pending', sent: 'routed', resulted: 'complete', cancelled: 'canceled'
});
const orderStatusToEmr = (s) => ORDER_STATUS_TO_EMR[String(s || '').toLowerCase()] || 'pending';

// A 6B order payload from an app order record.
const buildOrderPayload = (order, { providerId } = {}) => ({
  provider_id: providerId != null ? Number(providerId) : undefined,
  order_status: orderStatusToEmr(order && order.status),
  order_priority: (order && order.priority) === 'stat' ? 'high'
    : (order && order.priority) === 'urgent' ? 'high' : 'normal',
  procedure_order_type: (order && order.orderType) === 'imaging' ? 'radiology'
    : (order && order.orderType) === 'procedure' ? 'procedure' : 'laboratory_test',
  date_ordered: (order && order.date) || undefined,
  clinical_hx: String((order && order.clinicalHistory) || '').slice(0, 255) || undefined,
  patient_instructions: String((order && order.instructions) || '').slice(0, 255) || undefined,
  // `order.tests` is an array of STRINGS (buildOrder runs it through
  // sanitizeStringArray), and the diagnosis field on an order record is
  // `diagnosisCodes`, not `diagnoses`. Reading `t.name` off a string and
  // `order.diagnoses` off a record that has no such key both yield undefined,
  // which is how every order filed with a blank test name and no diagnosis
  // link while still returning 201 (shadow-data audit, 2026-09-08, G3).
  // Object entries are tolerated so a future coded-test picker needs no change
  // here. Unit tested for exactly this in test/clinical_completeness.test.js.
  codes: ((order && order.tests) || []).map(t => {
    const isObj = t && typeof t === 'object';
    const name = isObj ? String(t.name || t.description || '') : String(t || '');
    // NAME/TITLE vs CODE_TEXT: the 6B controller's charge half reads
    // `code_text`, but its ORDER half reads `name` and `title`
    // (GfcChargeRestController::postOrder → procedure_order_code). Sending only
    // code_text stored a blank test name, which was first misread as a server
    // defect; it is our own two halves disagreeing on a field name. All three
    // go out so the name lands on the patch as installed, with no OpenEMR
    // rebuild, and keeps landing if the controller is later made to prefer
    // code_text like its charge half does. Proven live both ways 2026-09-08.
    const label = name.slice(0, 255);
    return {
      code: (isObj && t.code) ? String(t.code) : undefined,
      code_text: label,
      name: label,
      title: label,
      diagnoses: ((order && order.diagnosisCodes) || []).map(c => ({ code_type: 'ICD10', code: c }))
    };
  })
});

// ---- Order capture (Scope D — labs / imaging / procedures; no HL7) ----
//
// SESSION 4.10 widened this. ORDER_TYPES now carries `referral` and `dme`, which
// are DOCUMENT orders: they carry a payload rather than a list of tests, they are
// built by their own builders in orderRequisitions.js, and a referral has its own
// lifecycle. `TEST_ORDER_TYPES` is what `buildOrder` below still owns.
const TEST_ORDER_TYPES = ['lab', 'imaging', 'procedure'];
const ORDER_TYPES = [...TEST_ORDER_TYPES, 'referral', 'dme'];
const ORDER_PRIORITIES = ['routine', 'urgent', 'stat'];
const ORDER_STATUSES = ['ordered', 'sent', 'scheduled', 'resulted', 'completed', 'cancelled'];
// Status is advanced manually by staff. Terminal states never move.
const ORDER_TRANSITIONS = Object.freeze({
  ordered: ['sent', 'resulted', 'cancelled'],
  sent: ['resulted', 'cancelled'],
  resulted: [],
  cancelled: []
});
// A REFERRAL IS NOT A LAB. It is sent, the specialist's office schedules it, and
// it completes when the consult note comes back. Declared in orderRequisitions.js
// with the rest of the referral payload; resolved here so every consumer asks one
// function which transitions apply to the order in front of it rather than
// assuming the lab map.
const transitionsFor = (order) => {
  if (order && order.orderType === 'referral') return require('./orderRequisitions').REFERRAL_TRANSITIONS;
  return ORDER_TRANSITIONS;
};

// ── Session 4.10: THREE STATUSES ARE NO LONGER CLICKABLE ──────────────────
// `sent` used to be a bare button. Clicking it recorded that somebody believed
// the order had gone — not where, not to which fax number, not on what channel.
// `resulted` was the same: a label with no result behind it. `scheduled` needs an
// appointment date or it says nothing.
//
// Each of those now has a route that captures the EVIDENCE, and the generic
// status route refuses them BY NAME rather than dropping them as unknown —
// naming the route to use is the difference between a refusal somebody can act
// on and one that reads as a bug.
const EVIDENCE_BACKED_STATUSES = Object.freeze({
  sent: 'Record the send with "Mark as faxed", which captures who it went to, the fax number and the channel.',
  resulted: 'Attach the result document — an order cannot be marked resulted without one.',
  completed: 'A referral completes when its consult note is attached.',
  scheduled: 'Record the appointment date with "Mark as scheduled".'
});

const buildOrder = ({ id, clientId, puuid, encounterUuid, input, actor, encounterDiagnoses, at, orderReference }) => {
  const i = input || {};
  if (!TEST_ORDER_TYPES.includes(i.orderType)) {
    return ORDER_TYPES.includes(i.orderType)
      ? { error: `A ${i.orderType} order carries its own details rather than a list of tests — it is built by its own route.`, code: 'ORDER_WRONG_BUILDER' }
      : { error: `orderType must be one of ${ORDER_TYPES.join(', ')}`, code: 'ORDER_BAD_TYPE' };
  }
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
      // 4.10: the reference printed on the requisition. It is how an inbound fax
      // finds its way back to this order, so it is minted with the order rather
      // than at print time — a reference that changes between two printings
      // cannot match anything.
      orderReference: orderReference || require('./orderRequisitions').buildOrderReference(),
      notes: String(i.notes || '').trim().slice(0, 2000),
      orderingClinician: actorRecord(actor),
      status: 'ordered',
      statusHistory: [{ status: 'ordered', at: now, by: actorRecord(actor), note: null }],
      sends: [],
      transmission: 'manual', // Quest HL7 deferred by owner decision
      createdAt: now,
      updatedAt: now
    }
  };
};
const advanceOrderStatus = (order, next, actor, note, at) => {
  if (!order) return { error: 'Order not found', code: 'ORDER_NOT_FOUND' };
  if (!ORDER_STATUSES.includes(next)) return { error: `Status must be one of ${ORDER_STATUSES.join(', ')}`, code: 'ORDER_BAD_STATUS' };
  // Refused BY NAME, with the route that does carry the evidence.
  if (EVIDENCE_BACKED_STATUSES[next]) {
    return { error: EVIDENCE_BACKED_STATUSES[next], code: 'ORDER_STATUS_NEEDS_EVIDENCE', status: 409 };
  }
  const allowed = transitionsFor(order)[order.status] || [];
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

// Session 4.5: the structured note is now ONLY the sign-and-close record.
//
// The [GFC CODING], [GFC ORDERS] and [GFC RX] blocks are retired. They existed
// because OpenEMR 7.0.4 had no billing, order or prescription write API, so the
// note was the only in-chart copy (spec §2.4 interim). On 8.4 all three are
// native: charges are in the billing table via the Phase 6B route, orders in
// procedure_order, prescriptions in prescriptions. Keeping a second copy in a
// note would mean two records that can disagree — and the note is the one no
// biller reads.
//
// [GFC ATTESTATION] and [GFC ADDENDA] STAY. Sign-and-close is still app-side
// because 8.4 has no encounter sign/close concept at all, so the note remains
// the only place the attestation and its addenda exist inside the chart. That
// is not a workaround; it is the record.
//
// Removing [GFC RX] goes one step past the letter of the 4.5 brief, which named
// CODING and ORDERS. Prescriptions became native in Scope A of the same
// session, so leaving RX would have left exactly the duplicate the brief is
// removing elsewhere. Flagged rather than done quietly.
const buildStructuredNote = ({ attestation, addenda }) => ({
  subjective: '[GFC STRUCTURED RECORD v2] The sign-and-close record for this encounter, written by the GFC Care Platform. OpenEMR has no encounter sign/close concept, so the attestation and any addenda live here. Coding, orders and prescriptions are NOT here — they are native OpenEMR records (billing, procedure_order, prescriptions). The clinician\'s narrative is the separate SOAP note on this encounter. Do not edit this note by hand — it is regenerated on every change.',
  objective: 'Coding, orders and prescriptions are recorded natively in OpenEMR — see the Fee Sheet, Procedure Orders and the medication list. This note carries the attestation only.',
  assessment: 'See the encounter diagnoses and services on the Fee Sheet.',
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

// ---- Patient-link duplicate guard (identity safety) ----
// The link step used to POST a new OpenEMR Patient unconditionally, so every
// retry minted another chart for the same person (the eight duplicate "Demo
// Client" rows found on the dev instance). These helpers let the route look
// for an existing chart FIRST and hand candidates back for a human to confirm.
//
// Deliberately NOT auto-linking: two different people can share a surname and
// a date of birth, and a wrong link writes clinical data into someone else's
// record. The system proposes, the clinician disposes.

// Fold case, accents and punctuation so "O'Brien" matches "OBrien" and "Jose"
// matches "Jose" with an accent. Separators are dropped rather than spaced, so
// "Smith-Jones" and "SmithJones" are the same surname for matching.
const normNamePart = (s) => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// A birthDate is only usable for matching when it is a real YYYY-MM-DD.
const normBirthDate = (s) => {
  const t = String(s == null ? '' : s).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
};

// Identity key for an app client, derived the way clientToFhirPatient() derives
// the record it would create — so the search looks for exactly the patient the
// create would otherwise have made.
const patientMatchKey = (client) => {
  const intake = (client && client.intake) || {};
  const parts = String((client && client.name) || '').trim().split(/\s+/).filter(Boolean);
  const family = intake.lastName || parts.slice(-1)[0] || '';
  const given = intake.firstName || parts.slice(0, -1).join(' ') || (parts.length === 1 ? parts[0] : '');
  return {
    family: normNamePart(family),
    given: normNamePart(given),
    birthDate: normBirthDate(intake.dob || (client && client.dob))
  };
};

// Comparable identity out of a FHIR Patient resource. FHIR allows several name
// entries; prefer the official one, else the first.
const fhirPatientIdentity = (resource) => {
  const names = Array.isArray(resource && resource.name) ? resource.name : [];
  const pick = names.find(n => n && n.use === 'official') || names[0] || {};
  const givenRaw = Array.isArray(pick.given) ? pick.given.filter(Boolean).join(' ') : pick.given;
  return {
    id: (resource && (resource.id || resource.uuid)) || null,
    family: normNamePart(pick.family),
    given: normNamePart(givenRaw),
    birthDate: normBirthDate(resource && resource.birthDate),
    displayName: [givenRaw, pick.family].filter(Boolean).join(' ').trim() || null,
    displayBirthDate: (resource && resource.birthDate) || null
  };
};

// Confidence of one candidate against the key. The surname must always match —
// a shared first name and date of birth alone is not a patient match.
//   exact    — surname, given name and date of birth all agree
//   probable — surname and date of birth agree, given name differs (nickname,
//              middle name carried in the given field, name change)
//   possible — surname and given name agree but one side carries no date of
//              birth, so the strongest identifier is simply absent
// A surname match with two KNOWN and DIFFERENT dates of birth is not a
// candidate at all — that is a different person.
const MATCH_CONFIDENCE = { exact: 'exact', probable: 'probable', possible: 'possible' };
const CONFIDENCE_RANK = { exact: 0, probable: 1, possible: 2 };

const scorePatientMatch = (candidate, key) => {
  if (!candidate || !key || !candidate.family || !key.family) return null;
  if (candidate.family !== key.family) return null;
  const bothHaveDob = !!candidate.birthDate && !!key.birthDate;
  const dobAgrees = bothHaveDob && candidate.birthDate === key.birthDate;
  const givenAgrees = !!candidate.given && candidate.given === key.given;
  if (bothHaveDob && !dobAgrees) return null;
  if (dobAgrees && givenAgrees) return MATCH_CONFIDENCE.exact;
  if (dobAgrees) return MATCH_CONFIDENCE.probable;
  if (givenAgrees) return MATCH_CONFIDENCE.possible;
  return null;
};

// Candidates for the key, strongest first. `linkedIds` are OpenEMR ids already
// claimed by another app client — still returned, but flagged, because linking
// to one would point two app records at a single chart.
const findExistingPatientMatches = (resources, key, linkedIds) => {
  const claimed = linkedIds instanceof Set ? linkedIds : new Set((linkedIds || []).map(String));
  return (Array.isArray(resources) ? resources : [])
    .map(r => {
      const identity = fhirPatientIdentity(r);
      const confidence = scorePatientMatch(identity, key);
      if (!confidence || !identity.id) return null;
      return {
        openEmrPatientId: String(identity.id),
        name: identity.displayName,
        birthDate: identity.displayBirthDate,
        confidence,
        alreadyLinkedToAnotherClient: claimed.has(String(identity.id))
      };
    })
    .filter(Boolean)
    .sort((a, b) => (CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence])
      || a.openEmrPatientId.localeCompare(b.openEmrPatientId));
};

// FHIR Patient search params for the key. Searching on surname (plus birthdate
// when known) keeps the net wide enough to catch nickname and middle-name
// variants that an exact given-name search would miss.
const patientSearchParams = (key) => {
  if (!key || !key.family) return null;
  const params = { family: key.family };
  if (key.birthDate) params.birthdate = key.birthDate;
  return params;
};


// ============================================================
// Session 4.12 — the persistent patient banner
// ============================================================
// Owner-directed after a live home visit, 2026-09-23: name, age, DOB, MRN, MBI
// and allergies were buried inside a chart tab, so the first thing a clinician
// needs at a front door was the one thing the screen never showed. The banner
// is never a tab — it renders above every chart tab and every encounter step.
//
// THE DERIVATION LIVES HERE, NOT IN THE PAGE, for the reason every other rule
// in this repo does: a screen that decides what "no known allergies" means is a
// screen that drifts from the record. This function is pure — `today` is passed
// in rather than read, so age is computed against the PRACTICE clock (Georgia)
// and the tests are deterministic.

// An allergy strip has THREE states and collapsing them is the whole danger.
//   listed       — we read the chart and there are allergies; show them.
//   none_known   — we read the chart and it is empty; say so IN WORDS.
//   unavailable  — we could not read. Say THAT, and never "no known allergies".
// C2 is written as "the absence of the strip must never be what communicates
// 'none on file'". The inverse is worse and is the one a bug produces: a strip
// reading "No known allergies" on a patient whose allergy list simply failed to
// load tells a clinician something untrue at the moment it matters most.
const ALLERGY_STATE = Object.freeze({
  LISTED: 'listed',
  NONE_KNOWN: 'none_known',
  UNAVAILABLE: 'unavailable'
});

// An allergy that has been resolved or entered in error is not an active
// allergy and does not belong on a strip a clinician reads in two seconds.
const INACTIVE_ALLERGY_STATUSES = ['inactive', 'resolved', 'entered-in-error', 'refuted'];

const isActiveAllergy = (row) => {
  if (!row || typeof row !== 'object') return false;
  const status = String(row.status || row.clinicalStatus || '').trim().toLowerCase();
  if (!status) return true; // no status recorded is not evidence of resolution
  return !INACTIVE_ALLERGY_STATUSES.includes(status);
};

const buildAllergyStrip = ({ linked, emrAllergies, reportedAllergies }) => {
  // Not linked to a chart at all: the EMR has nothing to say, but the client's
  // own intake may. Report intake as intake — it is what the family told us,
  // not a reconciled allergy list, and the strip says which it is.
  const reported = String(reportedAllergies == null ? '' : reportedAllergies).trim();
  if (!linked || !emrAllergies || emrAllergies.ok !== true) {
    if (reported) {
      return {
        state: ALLERGY_STATE.LISTED, source: 'intake', rows: [reported],
        reason: !linked
          ? 'Not linked to an OpenEMR chart — this is what the client reported at intake, not a reconciled allergy list.'
          : 'The chart\'s allergy list could not be read, so this is what the client reported at intake.'
      };
    }
    return {
      state: ALLERGY_STATE.UNAVAILABLE, source: null, rows: [],
      reason: !linked
        ? 'Not linked to an OpenEMR chart, so no allergy list could be read.'
        : ((emrAllergies && emrAllergies.error) || 'The chart\'s allergy list could not be read.')
    };
  }
  const rows = (emrAllergies.rows || []).filter(isActiveAllergy)
    .map(r => String((r && (r.allergen || r.name || r.description)) || '').trim())
    .filter(Boolean);
  if (rows.length) return { state: ALLERGY_STATE.LISTED, source: 'chart', rows, reason: null };
  return { state: ALLERGY_STATE.NONE_KNOWN, source: 'chart', rows: [], reason: null };
};

// Age in whole years on `today`, both as YYYY-MM-DD in the practice timezone.
// Never `new Date()` here: for four hours of every evening UTC is already
// tomorrow, which would age a patient a day early on their birthday.
const isCalendarDate = (v) => {
  // The shape AND the ranges. `1948-13-99` passes a YYYY-MM-DD regex and then
  // reads as "the birthday has not happened yet", which turns garbage into a
  // plausible age — and an age on a banner is read at a glance and never
  // questioned. A wrong one is worse than none.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
  const [y, m, d] = String(v).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1800) return false;
  // Round-tripping through Date catches 31 February and the like. Built in UTC
  // deliberately: this is a calendar question with no zone in it.
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

const ageOn = (dob, today) => {
  // No slicing: `'1948-13-99x'` must be refused, not trimmed into something
  // that parses.
  const d = String(dob == null ? '' : dob).trim();
  const t = String(today == null ? '' : today).trim();
  if (!isCalendarDate(d) || !isCalendarDate(t)) return null;
  const [by, bm, bd] = d.split('-').map(Number);
  const [ty, tm, td] = t.split('-').map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 && age < 150 ? age : null;
};

// The most recent encounter date on the chart. Used by the banner and the
// pre-visit packet. Rows with no usable date are skipped rather than sorted to
// the top as an empty string, which is what makes "last visit: —" read as a
// data gap instead of as today.
//
// It lives ABOVE the standing-facts region deliberately: this IS an
// encounter-derived value, and the guard on that region asserts nothing
// inside it reads an encounter at all.
const lastVisitDateOf = (encounters) => {
  const dates = (encounters || [])
    .map(e => String((e && (e.date || e.start || e.period_start)) || '').slice(0, 10))
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
};


// ============================================================
// Session 4.12 Scope D5 — the chart TIMELINE
// ============================================================
// One chronological thread of everything that happened to this patient. For
// somebody seen repeatedly at home this is how a clinician reconstructs the
// interval since the last visit — which is otherwise reassembled by opening
// five tabs and holding the dates in your head.
//
// PURE. Every source is passed in already read; this decides only what a row
// looks like and what order the rows go in.

const TIMELINE_KINDS = Object.freeze([
  'visit', 'message', 'medication', 'order', 'result', 'referral', 'document', 'hospitalization'
]);

const TIMELINE_ICONS = Object.freeze({
  visit: 'home', message: 'message', medication: 'pill', order: 'flask',
  result: 'report-medical', referral: 'share', document: 'file', hospitalization: 'building-hospital'
});

// A row with no usable date cannot be placed on a timeline. It is COUNTED and
// reported rather than dropped silently or sorted to the top as an empty
// string — "there is nothing here" and "we could not place four things" are
// different facts, and only one of them is a data gap worth chasing.
const timelineDate = (v) => {
  const d = String(v == null ? '' : v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

const buildTimeline = ({
  encounters, appointments, messages, prescriptions, orders, results, documents, kinds
}) => {
  const rows = [];
  let undated = 0;
  const push = (kind, date, title, detail, id) => {
    const d = timelineDate(date);
    if (!d) { undated += 1; return; }
    rows.push({ kind, date: d, title, detail: detail || null, id: id || null, icon: TIMELINE_ICONS[kind] });
  };

  (encounters || []).forEach(e => push('visit', e.date || e.start,
    e.type || 'Visit', [e.provider, e.status].filter(Boolean).join(' · '), e.id));
  // An appointment that produced an encounter is already on the thread as a
  // visit. Adding it again would show every documented visit twice — the trap
  // the portal's "upcoming and recent" merge already paid for.
  (appointments || []).filter(a => a && !a.encounterUuid).forEach(a => push('visit', a.date,
    a.title || 'Appointment', [a.state, a.location].filter(Boolean).join(' · '), a.eid));
  (messages || []).forEach(m => push('message', m.date || m.createdAt,
    m.subject || 'Message', m.channel || null, m.id));
  (prescriptions || []).forEach(rx => push('medication', rx.date || rx.createdAt,
    rx.drug || rx.name || 'Medication', [rx.dose, rx.kind].filter(Boolean).join(' · '), rx.id));
  (orders || []).forEach(o => {
    const kind = o.orderType === 'referral' ? 'referral' : 'order';
    push(kind, o.createdAt || o.orderedAt,
      kind === 'referral' ? `${o.specialty || 'Referral'} referral` : ((o.tests && o.tests[0]) || o.orderType || 'Order'),
      o.status || null, o.id);
  });
  (results || []).forEach(r => push('result', r.receivedAt || r.createdAt,
    r.label || r.documentName || 'Result', r.interpretation || null, r.id));
  // BUG (found 2026-09-23, live screenshot): every document on the timeline
  // read "Document / app". `buildChartDocumentIndex` rows carry `title` and
  // `category`, not `description` and `source` — `source` exists too, but it
  // is `CHART_DOC_SOURCE.APP`/`'app'`, the internal enum that tells the reader
  // whether OpenEMR or the app holds the file, never a human label. Reading it
  // as if it were one put the literal word "app" on every row a client, a
  // consent or a care plan actually produced.
  (documents || []).forEach(d => push('document', d.date,
    d.title || 'Document', d.category || null, d.id));

  const wanted = Array.isArray(kinds) && kinds.length
    ? new Set(kinds.filter(k => TIMELINE_KINDS.includes(k)))
    : null;
  const filtered = wanted ? rows.filter(r => wanted.has(r.kind)) : rows;
  // Newest first: on a timeline the question is almost always "what has
  // happened since I last saw them", and that is read from the top.
  filtered.sort((a, b) => b.date.localeCompare(a.date));
  return { rows: filtered, undated, kinds: TIMELINE_KINDS };
};

// ---- Home-visit standing facts (Scope F4) --------------------------------
// "Use the side entrance." "Daughter Angela will be present." These are facts
// about the PATIENT, not about one visit, and they live on the patient record
// for exactly that reason: re-entering the side entrance every visit is how it
// stops being entered at all. Surfaced in three places — the My Day row, the
// banner, and the pre-visit packet — all reading this one field. The encounter
// records only what DIFFERED today.
const HOME_VISIT_FIELDS = Object.freeze([
  ['accessInstructions', 'Access instructions'],
  ['caregiverPresent', 'Who will be there'],
  ['patientPreferences', 'Patient preferences'],
  ['safetyNotes', 'Safety / environment']
]);
const HOME_VISIT_MAX = 600;

const sanitizeHomeVisitNotes = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  HOME_VISIT_FIELDS.forEach(([k]) => {
    const v = String(src[k] == null ? '' : src[k]).trim().slice(0, HOME_VISIT_MAX);
    if (v) out[k] = v;
  });
  return out;
};

const homeVisitNotesOf = (client) => sanitizeHomeVisitNotes(client && client.homeVisit);

const hasHomeVisitNotes = (notes) => !!notes && HOME_VISIT_FIELDS.some(([k]) => !!notes[k]);

// ---- Insurance, as a clinician needs to read it at a front door -----------
// Not the whole payer block: the primary, the secondary, and the two flags that
// change what can be ordered — a Medicare Advantage plan (prior authorization)
// and QMB status (the patient may not be billed cost-share at all).
const summarizePayerForBanner = (client) => {
  const intake = (client && client.intake) || {};
  const payer = (client && client.payer) || {};
  const medicare = intake.medicare || {};
  const medicaid = intake.medicaid || {};
  const commercial = intake.commercial || {};
  const types = Array.isArray(intake.insuranceTypes) ? intake.insuranceTypes : [];
  const label = (name, id) => {
    const n = String(name || '').trim();
    const i = String(id || '').trim();
    if (!n && !i) return null;
    return i ? `${n || 'Coverage'} · ${i}` : n;
  };
  const candidates = [
    medicare.id || medicare.type ? label(medicare.advantagePlan || medicare.type || 'Medicare', medicare.advMemberId || medicare.id) : null,
    medicaid.memberId || medicaid.plan ? label(medicaid.plan || 'Medicaid', medicaid.memberId) : null,
    commercial.carrier || commercial.memberId ? label(commercial.carrier || commercial.planName, commercial.memberId) : null
  ].filter(Boolean);
  return {
    primary: candidates[0] || payer.summary || payer.type || null,
    secondary: candidates[1] || null,
    medicareAdvantage: !!String(medicare.advantagePlan || '').trim(),
    // QMB is not asked as its own question, so it is reported only when it is
    // actually recorded. Inferring it from "has Medicare and Medicaid" would
    // tell a clinician the patient cannot be billed when we do not know that.
    qmb: payer.qmb === true || intake.qmb === true,
    types
  };
};

// `careTierLabel` is PASSED IN, not derived: the label lives in server.js and
// this module is pure. Reaching for it here compiles and then throws a
// ReferenceError the first time a chart is opened.
const buildPatientBanner = ({ client, linked, emrAllergies, facility, lastVisitAt, today, careTierLabel }) => {
  const c = client || {};
  const intake = c.intake || {};
  const medicare = intake.medicare || {};
  const advance = intake.advanceDirective || {};
  const team = intake.medicalTeam || {};
  const contact = intake.primaryContact || {};
  const dob = intake.dob || c.dob || null;
  return {
    id: c.id || null,
    name: c.name || null,
    preferredName: c.preferredName || intake.preferredName || null,
    dob,
    age: ageOn(dob, today),
    sex: intake.gender || null,
    // The OpenEMR record number. We hold the patient's uuid; the numeric record
    // number is resolved by the caller where the EMR is reachable and is null
    // rather than invented when it is not — a made-up MRN is worse than none.
    mrn: c.openEmrRecordNumber || null,
    openEmrPatientId: c.openEmrPatientId || null,
    mbi: String(medicare.id || '').trim() || null,
    codeStatus: String(advance.status || '').trim() || null,
    allergies: buildAllergyStrip({
      linked: linked !== false && !!c.openEmrPatientId,
      emrAllergies,
      reportedAllergies: c.allergies || intake.allergies || null
    }),
    phone: intake.phone || c.phone || null,
    address: intake.address || null,
    addressLine: intake.addressLine1 || null,
    homeVisit: homeVisitNotesOf(c),
    responsibleParty: {
      name: String(contact.name || '').trim() || null,
      relationship: String(contact.relationship || '').trim() || null,
      phone: String(contact.phone || '').trim() || null,
      authority: String(intake.decisionAuthority || '').trim() || null
    },
    pcp: {
      name: String(team.pcpName || '').trim() || null,
      practice: String(team.pcpPractice || '').trim() || null,
      phone: String(team.pcpPhone || '').trim() || null
    },
    insurance: summarizePayerForBanner(c),
    facility: facility
      ? { id: facility.facilityId || null, name: facility.facilityName || null,
        posCode: facility.posCode || null, warning: facility.warning || null }
      : null,
    lastVisitAt: lastVisitAt || null,
    serviceLine: c.serviceLine || null,
    careTierLabel: careTierLabel || null,
    activatedAt: c.activatedAt || null
  };
};

module.exports = {
  // Session 4.12 — the persistent patient banner and the home-visit facts
  ALLERGY_STATE,
  buildAllergyStrip,
  isActiveAllergy,
  ageOn,
  isCalendarDate,
  HOME_VISIT_FIELDS,
  sanitizeHomeVisitNotes,
  homeVisitNotesOf,
  hasHomeVisitNotes,
  summarizePayerForBanner,
  buildPatientBanner,
  TIMELINE_KINDS,
  buildTimeline,
  timelineDate,
  lastVisitDateOf,
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
  buildChartDocumentIndex,
  CHART_DOC_SOURCE,
  summarizeVitalObservation,
  buildHpWrites,
  sanitizeNoteDraft,
  buildNoteDraft,
  noteDraftId,
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
  TELEHEALTH_MODIFIER, modifiersForCharge,
  RISK_LEVELS, RISK_NEEDS_PLAN, RISK_DOMAINS, buildRiskAssessment,
  latestRiskAssessment, riskAssessmentRequired, highestRisk,
  ATTESTATION_TEXT,
  buildAttestation,
  isEncounterClosed,
  buildAddendum,
  deriveEncounterState,
  RX_ROUTES,
  RX_KINDS,
  buildPrescription,
  prescriptionToEmrRow,
  resolveEncounterFacility,
  normalizeVisit, visitLabel, checkVisitAgainstPos, requiredSectionsForVisit,
  isBehavioralVisit, isTelehealthVisit, VISIT_POS_DISAGREES,
  FACILITY_UNASSIGNED,
  resolveBillingFacility,
  BILLING_FACILITY_UNRESOLVED,
  buildChargePayloads,
  // NCCI/MUE sign-time bundling check
  NCCI_STALE_DAYS, NCCI_UNBUNDLING_MODIFIERS,
  normalizeNcciSourceVersion,
  checkNcciBundling,
  buildOrderPayload,
  orderStatusToEmr,
  TEST_ORDER_TYPES,
  ORDER_TYPES,
  ORDER_PRIORITIES,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  transitionsFor,
  EVIDENCE_BACKED_STATUSES,
  buildOrder,
  advanceOrderStatus,
  buildCandidateDiagnoses,
  mergeCandidateSources,
  CODE_SETS,
  recordCodeUsage,
  rankFavorites,
  buildStructuredNote,
  parseGfcBlocks,
  MATCH_CONFIDENCE,
  patientMatchKey,
  fhirPatientIdentity,
  scorePatientMatch,
  findExistingPatientMatches,
  patientSearchParams
};
