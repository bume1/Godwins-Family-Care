'use strict';
// Follow-up notes are SOAP notes (owner, 2026-10-12).
//
// "The note breakdown for visits is confusing." Three things were wrong:
//   - Start visit saved EVERY visit type as an H&P, so a follow-up (even by
//     video) could not be signed without BP in both arms, and stamped the
//     patient's initial visit as done;
//   - the same follow-up looked different from each of three buttons;
//   - the same idea had several names across the templates.
// Follow-up, Acute / Sick and Psych Follow-up now share one core —
// Chief Complaint · Subjective · Objective (med rec, vitals, exam) ·
// Assessment · Plan — with each type's own questions after it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const A = require('../appointmentTypes');
const N = require('../clinicalNotes');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const CORE = ['chiefComplaint', 'subjective', 'medReconciliation', 'vitals', 'physicalExam', 'assessment', 'plan', 'ordersRxReferrals', 'followUp', 'mdmOrTime'];
const CORE_GROUPS = ['cc', 's', 'o', 'o', 'o', 'a', 'p', 'p', 'p', 'p'];
const SOAP_TYPES = ['pc_follow_up', 'pc_acute', 'bh_follow_up'];

const rows = (type, modality = 'in_person') => A.sectionsFor(type, { modality });
const requiredKeys = (type, modality) => rows(type, modality).filter(r => r.required).map(r => r.key);

test('the three follow-up types share the SOAP core, in order, with the owner\'s titles', () => {
  for (const type of SOAP_TYPES) {
    const r = rows(type);
    assert.deepEqual(r.slice(0, CORE.length).map(x => x.key), CORE, `${type} core order`);
    assert.deepEqual(r.slice(0, CORE.length).map(x => x.group), CORE_GROUPS, `${type} core groups`);
    assert.ok(r.slice(CORE.length).every(x => x.group === 'extra'), `${type}: everything after the core is its own extra`);
    assert.equal(A.isSoapLayout(type), true);
  }
  const labels = Object.fromEntries(rows('pc_follow_up').map(r => [r.key, r.label]));
  assert.equal(labels.chiefComplaint, 'Chief Complaint');
  assert.equal(labels.subjective, 'Subjective');
  assert.equal(labels.medReconciliation, 'Medication Reconciliation');
  assert.equal(labels.physicalExam, 'Physical Exam');
  assert.equal(labels.plan, 'Plan');
});

test('each type keeps its own questions after the core, and nothing else', () => {
  const extras = (type) => rows(type).filter(r => r.group === 'extra').map(r => r.key);
  assert.deepEqual(extras('pc_follow_up'), []);
  assert.deepEqual(extras('pc_acute'), ['pertinentRos', 'returnPrecautions']);
  assert.deepEqual(extras('bh_follow_up'),
    ['medicationAdherence', 'mentalStatusExam', 'riskAssessment', 'screeningScores', 'safetyPlan', 'psychotherapyTime']);
});

// The move to a shared core must not quietly tighten a sign rule: Acute and
// Psych FU never required medication reconciliation, and Psych FU never had
// vitals or an exam at all.
test('in person, the required sections match what each type demanded before', () => {
  assert.deepEqual(requiredKeys('pc_follow_up', 'in_person'),
    ['chiefComplaint', 'subjective', 'medReconciliation', 'vitals', 'physicalExam', 'assessment', 'plan', 'followUp', 'mdmOrTime']);
  assert.deepEqual(requiredKeys('pc_acute', 'in_person'),
    ['chiefComplaint', 'subjective', 'vitals', 'physicalExam', 'assessment', 'plan', 'mdmOrTime', 'pertinentRos', 'returnPrecautions']);
  assert.deepEqual(requiredKeys('bh_follow_up', 'in_person'),
    ['chiefComplaint', 'subjective', 'assessment', 'plan', 'followUp', 'medicationAdherence', 'mentalStatusExam', 'riskAssessment']);
});

test('telehealth has the SAME sections as in person; only vitals and exam become optional and patient-reported', () => {
  for (const type of SOAP_TYPES) {
    assert.deepEqual(rows(type, 'telehealth').map(r => r.key), rows(type, 'in_person').map(r => r.key), `${type} layout`);
    const tele = Object.fromEntries(rows(type, 'telehealth').map(r => [r.key, r]));
    for (const k of ['vitals', 'physicalExam']) {
      assert.equal(tele[k].required, false, `${type}.${k} not required by video`);
    }
  }
  const tele = Object.fromEntries(rows('pc_follow_up', 'telehealth').map(r => [r.key, r]));
  assert.equal(tele.vitals.patientReported, true);
  assert.equal(tele.physicalExam.patientReported, true);
});

test('which note each type produces is declared on the type', () => {
  const hp = ['pc_new_patient', 'bh_initial', 'ime_exam'];
  for (const t of A.APPOINTMENT_TYPES) {
    assert.equal(A.noteFormFor(t.key), hp.includes(t.key) ? 'hp' : 'followup', t.key);
  }
  assert.equal(A.noteFormFor('nope'), null);
});

test('a follow-up visit is saved as a follow-up whatever the page sent, and H&P boxes it holds are kept', () => {
  const { note } = N.sanitizeNote({
    kind: 'hp', chiefConcern: 'Knee pain', subjective: 'Worse on stairs',
    vitals: { bpSys: '130', bpDia: '80' }, hp: { systemsExam: { general: 'NAD' } },
    visit: { appointmentType: 'pc_follow_up', modality: 'in_person', location: 'home' }
  });
  assert.equal(note.kind, 'followup');
  assert.deepEqual(note.hp, { systemsExam: { general: 'NAD' } }, 'typed H&P text is never dropped');
  assert.equal(note.vitals.bpSys, '130');

  const np = N.sanitizeNote({ kind: 'hp', chiefConcern: 'New', visit: { appointmentType: 'pc_new_patient', modality: 'in_person', location: 'home' } }).note;
  assert.equal(np.kind, 'hp', 'New Patient stays an H&P');
});

test('a follow-up signs with NO two-arm BP — including a draft saved as an H&P before this change', () => {
  const legacy = { kind: 'hp', chiefConcern: 'x', vitals: {}, visit: { appointmentType: 'pc_follow_up', modality: 'telehealth', location: 'home' } };
  assert.equal(N.effectiveNoteKind(legacy), 'followup');
  assert.equal(N.checkNoteForSigning(legacy).ok, true);
  for (const type of ['pc_acute', 'bh_follow_up', 'pc_awv', 'pc_tcm']) {
    assert.equal(N.checkNoteForSigning({ ...legacy, visit: { ...legacy.visit, appointmentType: type } }).ok, true, type);
  }
});

test('New Patient and Psych Initial still need BP in both arms', () => {
  for (const type of ['pc_new_patient', 'bh_initial']) {
    const r = N.checkNoteForSigning({ kind: 'hp', vitals: {}, visit: { appointmentType: type, modality: 'in_person', location: 'home' } });
    assert.equal(r.code, 'HP_BP_BOTH_ARMS', type);
  }
});

test('Subjective is answered by the note\'s own Subjective field, and med rec goes to OpenEMR\'s Objective', () => {
  assert.deepEqual(N.FIELD_FOR_SECTION.subjective, ['subjective']);
  assert.ok(N.deriveCompletedSections({ subjective: 'Doing better' }).includes('subjective'));
  assert.equal(N.slotForSection('medReconciliation'), 'objective');
});

// ---- The page lays it out the same way --------------------------------------
// noteLayout is lifted out of the page and RUN, so what is asserted is the
// order a clinician sees, not the presence of a string.
const layoutSrc = (() => {
  const a = page.indexOf('const FIXED_BLOCK_FOR_SECTION = ');
  const b = page.indexOf('// One section\'s own box', a);
  assert.ok(a > 0 && b > a, 'noteLayout not found');
  return page.slice(a, b);
})();
const sandbox = { NF: { isBlank: (v) => !String(v || '').trim() } };
vm.createContext(sandbox);
vm.runInContext(`${layoutSrc}; this.noteLayout = noteLayout; this.FIXED = FIXED_BLOCK_FOR_SECTION;`, sandbox);
const served = (type, modality = 'in_person') => A.sectionsFor(type, { modality })
  .map(s => ({ ...s, ownField: N.sectionHasOwnField(s.key) }));
const SOAP_BLOCKS = ['chiefConcern', 'subjective', 'vitals', 'exam', 'assessment', 'plan'];
const shape = (items) => items.map(i => i.kind === 'heading' ? `# ${i.label}` : i.kind === 'fixed' ? `[${i.block}] ${i.label}` : i.kind === 'pointer' ? `-> ${i.section.key}` : i.section.key);

test('the page mirrors the server: Subjective is a fixed field, not a second box', () => {
  assert.equal(sandbox.FIXED.subjective, 'subjective');
});

test('a Follow-up note reads Chief Complaint, Subjective, Objective (med rec, vitals, exam), Assessment, Plan', () => {
  const out = sandbox.noteLayout({ sections: served('pc_follow_up'), fixedBlocks: SOAP_BLOCKS, extraBlocks: [], extraLabel: 'More', stored: {}, typeLabel: 'Follow-up' });
  assert.deepEqual(shape(out), [
    '[chiefConcern] Chief Complaint', '[subjective] Subjective',
    '# Objective', 'medReconciliation', '[vitals] Vitals', '[exam] Physical Exam',
    '[assessment] Assessment / Diagnoses', '[plan] Plan', '-> ordersRxReferrals', 'followUp', 'mdmOrTime'
  ]);
});

test('an Acute and a Psych follow-up put their own questions after the core, under their own heading', () => {
  const acute = shape(sandbox.noteLayout({ sections: served('pc_acute'), fixedBlocks: SOAP_BLOCKS, extraBlocks: [], stored: {}, typeLabel: 'Acute / Sick' }));
  assert.deepEqual(acute.slice(-3), ['# Acute / Sick — additional', 'pertinentRos', 'returnPrecautions']);
  const psych = shape(sandbox.noteLayout({ sections: served('bh_follow_up'), fixedBlocks: SOAP_BLOCKS, extraBlocks: [], stored: {}, typeLabel: 'Psych Follow-up / Med Mgmt' }));
  const at = psych.indexOf('# Psych Follow-up / Med Mgmt — additional');
  assert.ok(at > psych.indexOf('mdmOrTime'), 'extras come after the whole core');
  assert.deepEqual(psych.slice(at + 1), ['medicationAdherence', 'mentalStatusExam', 'riskAssessment', 'screeningScores', 'safetyPlan', 'psychotherapyTime']);
});

test('a telehealth follow-up has the identical layout, with vitals and exam marked patient-reported', () => {
  const inPerson = sandbox.noteLayout({ sections: served('pc_follow_up', 'in_person'), fixedBlocks: SOAP_BLOCKS, stored: {} });
  const video = sandbox.noteLayout({ sections: served('pc_follow_up', 'telehealth'), fixedBlocks: SOAP_BLOCKS, stored: {} });
  assert.deepEqual(shape(video), shape(inPerson));
  const pr = Object.fromEntries(video.filter(i => i.kind === 'fixed').map(i => [i.block, i.patientReported]));
  assert.equal(pr.vitals, true);
  assert.equal(pr.exam, true);
  assert.equal(pr.assessment, false);
});

test('templates that are not SOAP get no SOAP headings', () => {
  const awv = shape(sandbox.noteLayout({ sections: served('pc_awv'), fixedBlocks: SOAP_BLOCKS, stored: {}, typeLabel: 'Annual Wellness Visit' }));
  assert.ok(!awv.includes('# Objective'));
  assert.ok(!awv.some(x => /— additional/.test(x)));
});

// ---- One SOAP screen, whichever button starts the visit ----------------------
test('the Visit tab saves a follow-up type as a follow-up and shows the SOAP note, not the H&P blocks', () => {
  assert.match(page, /const followupForm = !sectionsOnly && !!\(visitType && visitType\.noteForm === 'followup'\);/);
  assert.match(page, /\} : followupForm \? \{\s*kind: 'followup',/);
  assert.match(page, /: followupForm \? SOAP_BLOCKS/);
  // The home-visit assessment is offered only on the H&P itself.
  assert.match(page, /: followupForm \? legacyHpParts\.map\(k => HP_BLOCK_FOR_PART\[k\]\)\s*: \['skinWound', 'pain', 'hazards', 'triage'\]/);
});

test('both editors draw follow-up blocks from the ONE shared renderer', () => {
  assert.equal((page.match(/const soapBlock = /g) || []).length, 1);
  assert.equal((page.match(/soapBlock\(\{ block: item\.block/g) || []).length, 2, 'Visit tab and encounter editor');
  assert.doesNotMatch(page, /const fuBlock = /, 'the encounter editor\'s private copy is gone');
});

test('a draft still holding H&P boxes opens where they are shown, so nothing typed is hidden', () => {
  assert.match(page, /=== 'hp' \|\| noteHasHpContent\(ns\.note\)\)\s*\?\s*<HpTab/);
});

test('the catalog serves which note a type produces and whether it is SOAP', () => {
  assert.match(server, /noteForm: apptTypes\.noteFormFor\(t\.key\),/);
  assert.match(server, /layout: apptTypes\.isSoapLayout\(t\.key\) \? 'soap' : null,/);
  assert.match(server, /noteTypeLabel: \(apptTypes\.typeByKey\(\(record\.visit \|\| \{\}\)\.appointmentType\) \|\| \{\}\)\.label \|\| null,/);
});
