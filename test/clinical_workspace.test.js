// ============================================================
// Session 4.1 — clinician workspace invariants (build-fail guards)
//
// Pure-function tests over clinicalRepository.js + openemr.js internals:
//   1. Care-plan versioning starts at 1, increments, never regresses.
//   2. Activation requires EVERY clinical-enrollment step (v2 §6).
//   3. Med-rec merge never drops a row; resolution validates actions.
//   4. H&P mapping enforces BP-both-arms (§2C) and preserves both readings.
// Run: npm test
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCarePlanVersion,
  deriveClinicalChecklist,
  CLINICAL_ENROLLMENT_STEPS,
  MANUAL_CHECKLIST_STEPS,
  buildMedRecView,
  applyMedRecResolution,
  buildHpWrites,
  VALID_TRACKS
} = require('../clinicalRepository');

const openemr = require('../openemr');

const isConsentSatisfied = (s) => ['signed', 'signed_offline'].includes(s);
const AUTHOR = { name: 'Bethel Godwins, FNP-C', id: 'rn-1', at: '2026-08-17T12:00:00.000Z' };
const PLAN_INPUT = { problems: ['Hypertension'], goals: ['BP < 130/80'], visitFrequency: '2/wk' };

// ---- 1. Care-plan versioning ----
test('care plan versions start at 1 (the Session 3.5 contract)', () => {
  const { plan } = buildCarePlanVersion(null, PLAN_INPUT, AUTHOR);
  assert.equal(plan.version, 1);
  assert.equal(plan.authoredBy, AUTHOR.name);
});

test('re-authoring increments the version and never regresses', () => {
  const v1 = buildCarePlanVersion(null, PLAN_INPUT, AUTHOR).plan;
  const v2 = buildCarePlanVersion(v1, PLAN_INPUT, AUTHOR).plan;
  const v3 = buildCarePlanVersion(v2, PLAN_INPUT, AUTHOR).plan;
  assert.deepEqual([v1.version, v2.version, v3.version], [1, 2, 3]);
});

test('a corrupt existing plan (no integer version) restarts at 1, not NaN', () => {
  const { plan } = buildCarePlanVersion({ version: 'two' }, PLAN_INPUT, AUTHOR);
  assert.equal(plan.version, 1);
});

test('care plan requires at least one problem and one goal', () => {
  assert.ok(buildCarePlanVersion(null, { goals: ['g'] }, AUTHOR).error);
  assert.ok(buildCarePlanVersion(null, { problems: ['p'] }, AUTHOR).error);
});

// ---- 2. Clinical enrollment checklist / activation gate ----
const READY_CLIENT = {
  consents: { roiTransfer: 'signed', consentToTreat: 'signed', assignmentOfBenefits: 'signed_offline', practiceNpp: 'signed' },
  clinicalInitialVisit: { at: '2026-08-17T10:00:00Z', byName: 'Bethel' },
  carePlan: { version: 1 },
  carePlanCoSign: { v1: { at: '2026-08-17T11:00:00Z', name: 'Client' } }
};
const DONE_MANUAL = {
  payerVerification: { done: true, byName: 'Admin', at: '2026-08-17T09:00:00Z' },
  npaConfirmation: { done: true, byName: 'Admin', at: '2026-08-17T09:01:00Z' }
};

test('activation gate: allDone only when every step is complete', () => {
  const full = deriveClinicalChecklist({ client: READY_CLIENT, manualState: DONE_MANUAL, roiEvents: [], isConsentSatisfied });
  assert.equal(full.allDone, true);
  assert.equal(full.steps.length, CLINICAL_ENROLLMENT_STEPS.length);
});

test('any single missing step blocks activation', () => {
  // missing manual payer verification
  const noPayer = deriveClinicalChecklist({ client: READY_CLIENT, manualState: { ...DONE_MANUAL, payerVerification: { done: false } }, roiEvents: [], isConsentSatisfied });
  assert.equal(noPayer.allDone, false);
  // care plan authored but NOT co-signed
  const noCosign = deriveClinicalChecklist({ client: { ...READY_CLIENT, carePlanCoSign: {} }, manualState: DONE_MANUAL, roiEvents: [], isConsentSatisfied });
  assert.equal(noCosign.allDone, false);
  // an IHPC consent missing
  const noAob = deriveClinicalChecklist({
    client: { ...READY_CLIENT, consents: { ...READY_CLIENT.consents, assignmentOfBenefits: 'pending' } },
    manualState: DONE_MANUAL, roiEvents: [], isConsentSatisfied
  });
  assert.equal(noAob.allDone, false);
});

test('co-sign on an OLD version does not satisfy the care-plan step', () => {
  const stale = deriveClinicalChecklist({
    client: { ...READY_CLIENT, carePlan: { version: 2 } }, // co-sign only exists for v1
    manualState: DONE_MANUAL, roiEvents: [], isConsentSatisfied
  });
  assert.equal(stale.allDone, false);
});

test('a revoked transfer-ROI event alone does not satisfy records/ROI', () => {
  const client = { ...READY_CLIENT, consents: { ...READY_CLIENT.consents, roiTransfer: 'pending' } };
  const revoked = deriveClinicalChecklist({ client, manualState: DONE_MANUAL, roiEvents: [{ id: 'e1', revoked_at: '2026-08-01' }], isConsentSatisfied });
  assert.equal(revoked.allDone, false);
  const live = deriveClinicalChecklist({ client, manualState: DONE_MANUAL, roiEvents: [{ id: 'e2', revoked_at: null, signed_at: '2026-08-01' }], isConsentSatisfied });
  assert.equal(live.allDone, true);
});

test('only payer verification and NPA are manually markable', () => {
  assert.deepEqual(MANUAL_CHECKLIST_STEPS.sort(), ['npaConfirmation', 'payerVerification']);
});

// ---- 3. Medication reconciliation ----
test('med-rec merge buckets every row exactly once — nothing dropped', () => {
  const fam = [{ name: 'Lisinopril 10mg' }, { name: 'Metformin' }, { name: 'Vitamin D3' }];
  const emrRows = [{ title: 'Lisinopril 10 mg tablet' }, { title: 'Atorvastatin 20mg' }];
  const { matched, familyOnly, emrOnly } = buildMedRecView(fam, emrRows);
  assert.equal(matched.length, 1);                 // lisinopril matches by name prefix
  assert.equal(familyOnly.length, 2);              // metformin, vitamin d3
  assert.equal(emrOnly.length, 1);                 // atorvastatin
  assert.equal(matched.length + familyOnly.length, fam.length);
  assert.equal(matched.length + emrOnly.length, emrRows.length);
});

test('med-rec resolution: discontinue removes from app rows, unknown action rejected', () => {
  const ok = applyMedRecResolution([
    { action: 'keep', med: { name: 'Metformin', dose: '500 mg' } },
    { action: 'discontinue', med: { name: 'Old drug' } },
    { action: 'add', med: { name: 'Atorvastatin', dose: '20 mg' } }
  ]);
  assert.equal(ok.rows.length, 2);
  assert.ok(!ok.rows.find(r => r.name === 'Old drug'));
  assert.ok(applyMedRecResolution([{ action: 'zap', med: { name: 'x' } }]).error);
  assert.ok(applyMedRecResolution([{ action: 'keep', med: {} }]).error);
});

// ---- 4. H&P mapping (§2C) ----
test('H&P refuses to write without BP in BOTH arms', () => {
  const oneArm = buildHpWrites({ vitals: { bpRightSys: '142', bpRightDia: '86' } }, 'RN');
  assert.equal(oneArm.code, 'HP_BP_BOTH_ARMS');
});

test('H&P records the higher-reading arm in the vitals form and both arms in the note', () => {
  const { encounter, vitals, soapNote } = buildHpWrites({
    chiefConcern: 'New patient',
    vitals: { bpRightSys: '142', bpRightDia: '86', bpLeftSys: '150', bpLeftDia: '90', hr: '78' },
    triage: { track: 'B', rationale: 'skilled needs' }
  }, 'Bethel Godwins, FNP-C');
  assert.equal(vitals.bps, '150');                          // higher (left) arm wins
  assert.match(vitals.note, /right arm 142\/86/);
  assert.match(vitals.note, /left arm 150\/90/);
  assert.equal(encounter.class_code, 'HH');
  assert.match(soapNote.plan, /Track assignment: B/);
  assert.match(soapNote.plan, /Documented by Bethel Godwins/);
});

test('track vocabulary is the canonical A1–A4/B enum (Intake Spec v1.1 §3.2)', () => {
  assert.deepEqual(VALID_TRACKS, ['A1', 'A2', 'A3', 'A4', 'B']);
});

// ---- openemr.js internals ----
test('openemr url builders target the configured site apis', () => {
  const { fhirUrl, apiUrl } = openemr._internal;
  assert.match(fhirUrl('Patient/abc'), /\/apis\/[^/]+\/fhir\/Patient\/abc$/);
  assert.match(apiUrl('patient/abc/encounter'), /\/apis\/[^/]+\/api\/patient\/abc\/encounter$/);
});

test('openemr response helpers unwrap standard-API and FHIR bundle shapes', () => {
  const { bundleResources, unwrapApi } = openemr._internal;
  assert.deepEqual(bundleResources({ entry: [{ resource: { id: 1 } }, {}] }), [{ id: 1 }]);
  assert.deepEqual(bundleResources(null), []);
  assert.deepEqual(unwrapApi({ validationErrors: [], data: { uuid: 'x' } }), { uuid: 'x' });
  assert.deepEqual(unwrapApi([1, 2]), [1, 2]);
});
