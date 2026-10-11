'use strict';
// Social work documentation (owner, 2026-10-11). An LMSW or LCSW could get
// into the app but every note template was primary care or psychiatry, the
// visit timer refused them, screenings had nowhere to go, and several buttons
// offered them actions the server refuses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const A = require('../appointmentTypes');
const notes = require('../clinicalNotes');
const repo = require('../clinicalRepository');
const S = require('../screenings');
const roles = require('../clinicalRoles');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'clinical.html'), 'utf8');
const strip = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

// ---- 1. The note types ---------------------------------------------------
const SW = ['sw_psychosocial', 'sw_therapy', 'sw_follow_up'];
const MEDICAL_SECTIONS = ['vitals', 'awvVitals', 'physicalExam', 'focusedExam', 'medReconciliation', 'ordersRx', 'ordersRxReferrals', 'medicationsRx'];

test('three social work note types exist, each only its own sections, with no vitals or exam', () => {
  for (const k of SW) {
    const t = A.typeByKey(k);
    assert.ok(t, `${k} must exist`);
    assert.equal(t.noteShape, 'sections');
    for (const m of ['in_person', 'telehealth', 'phone']) {
      const keys = A.sectionsFor(k, { modality: m }).map(s => s.key);
      for (const bad of MEDICAL_SECTIONS) assert.ok(!keys.includes(bad), `${k} must not carry ${bad}`);
    }
    assert.ok(A.modalitiesForType(k).includes('phone'), `${k} may be a call`);
  }
});

test('each social work note requires the minutes and a plan', () => {
  assert.ok(A.requiredSectionKeys('sw_therapy', { modality: 'in_person' }).includes('sessionTime'),
    'psychotherapy is billed on time, so the session minutes are required');
  for (const k of ['sw_psychosocial', 'sw_follow_up']) {
    assert.ok(A.requiredSectionKeys(k, { modality: 'in_person' }).includes('contactTime'), `${k} needs the minutes`);
  }
  for (const k of SW) assert.ok(A.requiredSectionKeys(k, { modality: 'phone' }).includes('swPlan'), `${k} needs a plan`);
  // The psychosocial assessment covers the full picture.
  const ps = A.requiredSectionKeys('sw_psychosocial', { modality: 'in_person' });
  for (const k of ['referralReason', 'livingSituation', 'familySupport', 'financialBenefits', 'legalPlanning', 'sdohNeeds', 'swAssessment']) {
    assert.ok(ps.includes(k), `psychosocial assessment needs ${k}`);
  }
});

test('a safety plan becomes required on a social work note once risk is positive', () => {
  for (const k of SW) {
    assert.equal(A.requiredSectionKeys(k, { modality: 'in_person', riskPositive: false }).includes('safetyPlan'), false);
    assert.equal(A.requiredSectionKeys(k, { modality: 'in_person', riskPositive: true }).includes('safetyPlan'), true, k);
  }
});

test('therapy and the psychosocial assessment need the structured risk assessment; a follow-up does not', () => {
  assert.equal(repo.riskAssessmentRequired({ appointmentType: 'sw_therapy', modality: 'in_person', location: 'home' }), true);
  assert.equal(repo.riskAssessmentRequired({ appointmentType: 'sw_psychosocial', modality: 'in_person', location: 'home' }), true);
  assert.equal(repo.riskAssessmentRequired({ appointmentType: 'sw_follow_up', modality: 'phone' }), false);
  // Unchanged for the medical types.
  assert.equal(repo.riskAssessmentRequired({ appointmentType: 'bh_initial', modality: 'in_person', location: 'home' }), true);
  assert.equal(repo.riskAssessmentRequired({ appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' }), false);
});

test('social work bills the behavioral-health set or care management, never E/M', () => {
  for (const m of ['in_person', 'telehealth']) {
    const r = A.resolveCodeFamily({ modality: m, location: 'home', appointmentType: 'sw_therapy' });
    assert.equal(r.family.key, 'behavioral_health', `therapy ${m}`);
  }
  assert.equal(A.resolveCodeFamily({ modality: 'in_person', location: 'home', appointmentType: 'sw_follow_up' }).family.key, 'care_management');
  // A medical type still follows the location.
  assert.equal(A.resolveCodeFamily({ modality: 'in_person', location: 'home', appointmentType: 'pc_follow_up' }).family.key, 'home');
});

test('every new section lands in a sensible part of the OpenEMR note', () => {
  const soap = notes.composeNarrative({
    note: { kind: 'followup', chiefConcern: '', subjective: '', objective: '', assessment: '', plan: '', vitals: {}, hp: {},
      sections: { referralReason: 'Referred by PCP.', swAssessment: 'Caregiver strain.', swPlan: 'Refer to Meals on Wheels.' },
      visit: { appointmentType: 'sw_psychosocial', modality: 'in_person', location: 'home' } },
    revisions: [], screenLines: ['PHQ-9 12/27 (Moderate), item 9: 0']
  });
  assert.match(soap.subjective, /Referred by PCP/);
  assert.match(soap.assessment, /Caregiver strain/);
  assert.match(soap.plan, /Meals on Wheels/);
  assert.match(soap.objective, /SCREENINGS RECORDED[\s\S]*PHQ-9 12\/27/);
});

// ---- Who may write which note -------------------------------------------
test('an LMSW writes the psychosocial and follow-up notes; an LCSW also therapy; neither a medical note', () => {
  const can = (role) => A.APPOINTMENT_TYPES.filter(t => A.canDocumentType(t.key, role).ok).map(t => t.key);
  assert.deepEqual(can('lmsw'), ['sw_psychosocial', 'sw_follow_up']);
  assert.deepEqual(can('lcsw'), ['sw_psychosocial', 'sw_therapy', 'sw_follow_up']);
  assert.ok(!can('rn').includes('sw_therapy'), 'psychotherapy is outside RN scope');
  assert.ok(can('rn').includes('pc_follow_up'));
  assert.equal(can('provider').length, A.APPOINTMENT_TYPES.length);
  const r = A.canDocumentType('pc_new_patient', 'lmsw');
  assert.equal(r.code, 'SOCIAL_WORK_TYPE_ONLY');
  assert.match(r.error, /Psychosocial Assessment/);
});

test('canBookType admits a social worker by clinical role, and still refuses a social worker as a prescriber credential', () => {
  assert.equal(A.canBookType('sw_follow_up', { clinicalRole: 'lmsw' }).ok, true);
  assert.equal(A.canBookType('sw_therapy', { clinicalRole: 'lmsw' }).ok, false);
  assert.equal(A.canBookType('bh_initial', { clinicalRole: 'lcsw' }).code, 'SOCIAL_WORK_TYPE_ONLY');
  assert.equal(A.canBookType('sw_psychosocial', { prescriberCredential: 'NP' }).ok, true, 'a provider may write one too');
});

// Lifted out of server.js and run, not read: requiring server.js boots a server.
const liftNoteTypeRefusal = () => {
  const start = server.indexOf('const noteTypeRefusal = ');
  const end = server.indexOf('\n};\n', start);
  assert.ok(start > 0 && end > start, 'noteTypeRefusal not found');
  // eslint-disable-next-line no-new-func
  return new Function('clinicalRoles', 'apptTypes', `${server.slice(start, end + 3)}; return noteTypeRefusal;`)(roles, A);
};

test('the note routes refuse a social worker a note type outside their scope, and a note with no type', () => {
  const refuse = liftNoteTypeRefusal();
  const lmsw = { role: 'caseManager', clinicalRole: 'lmsw' };
  const note = (appointmentType) => ({ visit: appointmentType ? { appointmentType } : undefined });
  assert.equal(refuse(lmsw, note(null), null).status, 400);
  assert.equal(refuse(lmsw, note(null), null).body.code, 'VISIT_TYPE_REQUIRED');
  assert.equal(refuse(lmsw, note('pc_new_patient'), null).status, 403);
  assert.equal(refuse(lmsw, note('sw_follow_up'), null), null);
  // Editing text on a draft whose type is unchanged is never refused over it.
  assert.equal(refuse(lmsw, note('pc_follow_up'), { visit: { appointmentType: 'pc_follow_up' } }), null);
  // A provider with no type is fine (the follow-up default).
  assert.equal(refuse({ role: 'user', clinicalRole: 'provider' }, note(null), null), null);
  // Both note routes call it before writing.
  assert.equal((server.match(/const typeRefusal = noteTypeRefusal\(req\.user, /g) || []).length, 2);
});

test('a social work note is never saved as an H&P, whatever the page sends', () => {
  const r = notes.sanitizeNote({ kind: 'hp', vitals: { hr: '80', bpRightSys: '120' }, hp: { systemsExam: { heart: 'RRR' } },
    sections: { contactPurpose: 'Benefits follow-up.' }, visit: { appointmentType: 'sw_follow_up', modality: 'phone' } });
  assert.equal(r.note.kind, 'followup');
  assert.deepEqual(r.note.vitals, {});
  assert.deepEqual(r.note.hp, {});
  assert.equal(r.note.sections.contactPurpose, 'Benefits follow-up.');
  // A medical note keeps its vitals.
  const m = notes.sanitizeNote({ kind: 'followup', vitals: { hr: '80' }, chiefConcern: 'x', visit: { appointmentType: 'pc_follow_up', modality: 'in_person' } });
  assert.equal(m.note.vitals.hr, '80');
});

test('the visit-type picker offers only the types the server says this clinician may write', () => {
  assert.match(server, /canDocument: apptTypes\.canDocumentType\(t\.key, viewerRole\)\.ok/);
  assert.match(server, /noteShape: t\.noteShape \|\| null/);
  assert.match(page, /\.filter\(t => t\.service === svc\.key && t\.canDocument !== false\)/);
  assert.match(page, /\.filter\(t => t\.canDocument !== false\)\.map\(t => <option/);
  // A social worker never sees the H&P blocks while choosing.
  assert.match(page, /const sectionsOnly = isPhone \|\| isSocialWorker \|\|/);
  // The saved-note editor is told the shape by the server.
  assert.match(server, /sectionsOnly: apptTypes\.isSectionsOnly\(/);
});

// ---- 2. Visit times and buttons that would refuse ------------------------
test('an LCSW or LMSW can record visit times', () => {
  const at = server.indexOf("app.post('/api/clinical/visits/:eid/timing'");
  const head = server.slice(at, server.indexOf('async (req, res)', at));
  assert.match(head, /requireNoteWriter/);
  assert.doesNotMatch(head, /NURSING_NOTE/);
});

test('a social worker is not offered med rec, the problem list, order sends or a care-plan co-sign they cannot do', () => {
  const code = strip(page);
  assert.match(code, /const MedRecTab = \(\{ patient \}\) => \{\s*const canWrite = useCan\('medRec'\);/);
  assert.match(code, /setAddToProblemList && canWriteProblems && \(/);
  assert.match(code, /const canAdvance = useCan\('orderStatusAdvance'\);/);
  assert.equal((code.match(/\{canAdvance && /g) || []).length, 3, 'mark faxed, mark scheduled and attach result');
  assert.match(code, /\{providerPending && canCoSignPlan && \(/);
  assert.match(server, /canCoSignCarePlan: clinicalRoles\.canCoSignCarePlan\(req\.user\)/);
  // Screening-only ceilings get no Orders form.
  assert.match(code, /const canOrderStanding = useCan\('orderStanding'\) && ceiling\.some\(t => t !== 'screening'\);/);
});

test('the coding route never writes the problem list for someone who may not', () => {
  assert.match(server, /const mayWriteProblems = clinicalRoles\.can\(req\.user, clinicalRoles\.CAPABILITIES\.PROBLEM_LIST_WRITE\);/);
  assert.match(server, /\(billingEdit && !awaitingAddendum\) \|\| !mayWriteProblems \? \[\]/);
  assert.equal(roles.can({ role: 'user', clinicalRole: 'lcsw' }, 'problemListWrite'), false);
  assert.equal(roles.can({ role: 'user', clinicalRole: 'rn' }, 'problemListWrite'), true);
});

// ---- 3. Screenings -------------------------------------------------------
test('a PHQ-9 is scored and banded, and item 9 is required', () => {
  const base = { id: 's1', clientId: 'c', encounterUuid: 'e', actor: { id: 'u', name: 'Sam', clinicalRole: 'lmsw' } };
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'phq9', score: 12 } }).code, 'SCREENING_ITEM9_REQUIRED');
  const r = S.buildScreening({ ...base, input: { instrument: 'phq9', score: 12, item9: 0 } }).screening;
  assert.equal(r.interpretation, 'Moderate');
  assert.equal(r.positive, true);
  assert.equal(r.authority, 'direct');
  assert.equal(S.needsRiskAssessment(r), false);
  const risky = S.buildScreening({ ...base, input: { instrument: 'phq9', score: 6, item9: 1 } }).screening;
  assert.equal(S.needsRiskAssessment(risky), true, 'item 9 above 0 must call for a risk assessment');
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'phq9', score: 28, item9: 0 } }).code, 'SCREENING_BAD_SCORE');
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'phq9', score: 2, item9: 3 } }).code, 'SCREENING_BAD_ITEM9');
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'phq9', score: 4.5, item9: 0 } }).code, 'SCREENING_BAD_SCORE');
});

test('GAD-7, PHQ-2 and the social-needs screen record what they mean', () => {
  const base = { id: 's', clientId: 'c', encounterUuid: 'e' };
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'gad7', score: 15 } }).screening.interpretation, 'Severe');
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'phq2', score: 3 } }).screening.positive, true);
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'phq2', score: 2 } }).screening.positive, false);
  const sd = S.buildScreening({ ...base, input: { instrument: 'sdoh', needs: ['food', 'transportation'] } }).screening;
  assert.equal(sd.positive, true);
  assert.match(S.describe(sd), /Food, Transportation/);
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'sdoh', needs: [] } }).screening.positive, false);
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'sdoh', needs: ['rent'] } }).code, 'SCREENING_BAD_NEED');
  assert.equal(S.buildScreening({ ...base, input: { instrument: 'cssrs', score: 1 } }).code, 'SCREENING_BAD_INSTRUMENT');
});

test('screenings are recorded on the encounter, count for the note section, reach OpenEMR and gate signing on item 9', () => {
  const at = server.indexOf("app.post('/api/clinical/patients/:clientId/encounters/:euuid/screenings'");
  assert.ok(at > 0);
  const route = server.slice(at, server.indexOf('\n  });\n', at));
  assert.match(route, /requireCapability\(clinicalRoles\.CAPABILITIES\.SCREENING_INSTRUMENT\)/);
  assert.match(route, /refuseIfClosed\(ctx, res\)/);
  // Under a protocol, the same authorization an order gets, as a 'screening'.
  assert.match(route, /standingOrders\.authorizeExecution\(\{[\s\S]*orderType: 'screening'/);
  assert.match(route, /standing_order_executions/);
  // The audit carries the instrument, never the score or the notes.
  const audit = route.slice(route.indexOf("'screening_recorded'"));
  assert.doesNotMatch(audit.slice(0, 400), /score|notes/);
  assert.match(server, /screeningScores: \(ctx\.screenings \|\| \[\]\)\.length > 0/);
  assert.match(server, /screenLines = \(await loadRows\('clinical_screenings'\)\)/);
  assert.match(server, /code: 'SIGN_SCREENING_NEEDS_RISK'/);
  const registry = require('../dataMigration').COLLECTION_REGISTRY || [];
  const entry = registry.find(r => r.key === 'clinical_screenings');
  assert.ok(entry && entry.phi === true, 'the collection is registered as PHI');
});

test('the standing-order ceiling lets a social worker run a screening protocol and nothing else', () => {
  for (const r of ['lmsw', 'lcsw']) {
    assert.equal(roles.withinCredentialCeiling(r, ['screening']).ok, true);
    assert.equal(roles.withinCredentialCeiling(r, ['lab']).ok, false);
  }
  // The order form leaves screening out; the Screenings card picks it up.
  assert.match(page, /const orderTypesOf = \(o\) => \(o\.executableOrderTypes \|\| \[\]\)\.filter\(t => t !== 'screening'\);/);
  assert.match(page, /\.filter\(o => \(o\.executableOrderTypes \|\| \[\]\)\.includes\('screening'\)\)/);
  assert.match(page, /<ScreeningCard d=\{d\}/);
});
