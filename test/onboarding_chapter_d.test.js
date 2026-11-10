'use strict';
// Chapter D · Clinician, Contracted (Playbook v3.0 D.1-D.8). The D.2 table is
// a classification guard: anything in its right-hand column, built into the
// checklist, is evidence the contractor is an employee.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const D = require('../onboarding/chapterD');
const C = require('../onboarding/chapterC');
const T = require('../onboarding/track');
const R = require('../onboarding/renewals');

const D_INPUTS = { chapter: 'D', serviceLines: ['IME', 'PRIVATE_PAY', 'INSURED', 'BEHAVIORAL'], payers: ['Medicare'],
  controlledSubstances: true, prescribes: true, drives: true, telehealth: true, residenceUnderPhc: true, baaRequired: true };

test('D is a 1099 chapter that does not train clinically', () => {
  assert.strictEqual(D.CHAPTER.relationship, '1099');
  assert.strictEqual(D.CHAPTER.trainsClinically, false);
  assert.strictEqual(T.CHAPTERS.D, D);
});

test('D.2 / D.8: no Employee Handbook, no Code of Conduct, no I-9 or W-4', () => {
  const ackIds = D.ACKNOWLEDGMENTS.map(a => a.id);
  assert.ok(!ackIds.includes('EMPLOYEE_HANDBOOK'));
  assert.ok(!ackIds.includes('CODE_OF_CONDUCT'));
  D.ITEMS.forEach(it => {
    (it.acknowledges || []).forEach(a => assert.ok(ackIds.includes(a), `${it.id} acknowledges ${a}, which D does not issue`));
    const rows = (it.elements || []).map(e => (typeof e === 'string' ? e : e.row)).join(' | ');
    assert.doesNotMatch(rows, /I-9|W-4|direct deposit/i, `${it.id} collects employment tax paperwork`);
  });
  assert.ok(D.ITEMS.some(it => (it.elements || []).includes('Form W-9')));
});

test('D.2: no training, competency, orientation, probation or scheduling item', () => {
  // The one named exception is non-clinical training the owner chose, proven
  // by a certificate she submits (HIPAA on CareScout). It may not be observed.
  const NON_CLINICAL = ['D.6.04'];
  D.ITEMS.filter(it => !NON_CLINICAL.includes(it.id)).forEach(it => assert.doesNotMatch(it.title, /train|competenc|orientation|probation|schedul|shift/i, it.id));
  NON_CLINICAL.forEach(id => {
    const it = D.ITEMS.find(x => x.id === id);
    assert.doesNotMatch(it.title, /clinical|competenc|skill|orientation|probation/i, id);
    assert.ok(it.steps.some(s => s.actor === 'NEW_HIRE' && s.action === 'SUBMIT'), `${id} is proven by her certificate`);
  });
  D.ITEMS.forEach(it => it.steps.forEach(s => assert.notStrictEqual(s.action, 'OBSERVE', `${it.id} supervises her practice`)));
});

test('a D track carries only its named non-clinical modules, in D.6, and its service lines open without them', () => {
  const t = T.buildTrack({ inputs: D_INPUTS, record: {}, audience: 'office' });
  assert.strictEqual(t.chapter.id, 'D');
  const named = D.TRAINING.map(x => x.id);
  assert.ok(t.modules.length > 0);
  // Plus the general modules every role gets (owner, 2026-11-10), in the same phase.
  const shared = require('../onboarding/libraryTrainings').SHARED_MODULE_IDS;
  t.modules.forEach(m => { assert.ok(named.includes(m.id) || shared.includes(m.id), `${m.id} is not on D's list or shared`); assert.strictEqual(m.phase, 'D.6', m.id); });
  t.phases.filter(p => p.id !== 'D.6').forEach(p => assert.strictEqual(p.requiredModules.length, 0, p.id));
  assert.deepStrictEqual(t.phases.find(p => p.id === 'D.6').requiredModules.sort(), t.modules.map(m => m.id).sort());
  assert.deepStrictEqual(t.determinations.map(d => d.id).sort(), ['BEHAVIORAL', 'IME', 'INSURED', 'PRIVATE_PAY']);
  t.determinations.forEach(d => { assert.strictEqual(d.requiredModules.length, 0, d.id); assert.strictEqual(d.eligible, true, d.id); });
  // The same lines under C do wait on modules, so the difference is the chapter.
  const c = T.buildTrack({ inputs: Object.assign({}, D_INPUTS, { chapter: 'C' }), record: {}, audience: 'office' });
  assert.ok(c.determinations.some(d => d.requiredModules.length > 0));
});

test('D.2: every contractor module is non-clinical — signed off as attestation, certificate or none, never observed or countersigned', () => {
  const { MODULES } = require('../onboarding/modules');
  D.TRAINING.forEach(t => {
    const m = MODULES.find(x => x.id === t.id);
    assert.ok(m, `${t.id} is not in the Training Library`);
    assert.ok(['ATTEST', 'CERTIFICATE', 'NONE'].includes(m.signoff), `${t.id} signs off as ${m.signoff}`);
    (m.unlocksAfter || []).forEach(u => assert.ok(D.TRAINING.some(x => x.id === u), `${t.id} waits on ${u}, which a contractor never gets`));
  });
  assert.deepStrictEqual(D.TRAINING.map(x => x.id).sort(), ['TRN-002', 'TRN-003', 'TRN-004', 'TRN-005', 'TRN-008', 'TRN-103', 'TRN-205']);
});

test('a D readiness determination opens on the C.8 conditions with no training recorded', () => {
  const det = D.DETERMINATIONS.find(d => d.id === 'PRIVATE_PAY');
  const opened = T.openDetermination('PRIVATE_PAY', D_INPUTS, {}, { conditionsConfirmed: det.conditions, approvedScope: 'Private pay primary care' },
    { id: 'u1', name: 'Office', isOffice: true }, {}, '2026-11-08T12:00:00Z');
  assert.deepStrictEqual(opened.modulesComplete, []);
  assert.throws(() => T.openDetermination('PRIVATE_PAY', D_INPUTS, {}, { conditionsConfirmed: [], approvedScope: 'x' },
    { id: 'u1', isOffice: true }, {}, 'now'), /condition/);
});

test('D.5: C.2 applies without modification — credentialing rows and classifications are C.6\'s', () => {
  const pairs = [['D.5.01', 'C.6.01'], ['D.5.03', 'C.6.03'], ['D.5.05', 'C.6.05'], ['D.5.09', 'C.6.08']];
  pairs.forEach(([d, c]) => {
    const di = D.ITEMS.find(x => x.id === d); const ci = C.ITEMS.find(x => x.id === c);
    assert.deepStrictEqual(di.steps, ci.steps, d);
    assert.deepStrictEqual(di.classifications, ci.classifications, d);
  });
  D.ITEMS.forEach(it => it.classifications.forEach(k => assert.ok(k.from && k.from.source, `${it.id} has an uncited classification`)));
});

test('D.5: the certificate comes from the carrier and names GFC as additional insured', () => {
  const coi = D.ITEMS.find(x => x.id === 'D.5.06');
  assert.ok(coi.elements.some(e => /additional insured/.test(e)));
  assert.ok(!coi.steps.some(s => s.actor === 'NEW_HIRE' && s.action === 'SUBMIT'), 'a copy supplied by the clinician is not accepted');
  assert.ok(R.EXPIRING_ITEMS['D.5.06']);
});

test('the when keys narrow: examiner credentialing for IME, payer enrollment for insured, BAA when required', () => {
  const ids = (inputs) => T.composeChecklist(Object.assign({ chapter: 'D' }, inputs)).map(x => x.id);
  const bare = ids({ serviceLines: ['PRIVATE_PAY'] });
  ['D.5.07', 'D.5.08', 'D.4.04', 'D.5.05'].forEach(id => assert.ok(!bare.includes(id), id));
  const full = ids(D_INPUTS);
  ['D.5.07', 'D.5.08', 'D.4.04', 'D.5.05'].forEach(id => assert.ok(full.includes(id), id));
});

test('D.7: monitoring follows C.9 with malpractice renewal verified by certificate, and is recordable', () => {
  assert.strictEqual(D.RECURRING.length, C.RECURRING.length);
  const r5 = D.RECURRING.find(r => r.copiedFrom === 'C.9.R5');
  assert.match(r5.requirement, /verified by carrier certificate/);
  D.RECURRING.forEach(r => assert.match(r.id, /^D\.7\.R\d$/));
  const rec = R.recordRecurring('D.7.R1', {}, '2026-11-01', { name: 'Office' }, 'now');
  assert.strictEqual(rec.recurring['D.7.R1'].lastDoneOn, '2026-11-01');
});

test('a contracted provider defaults to D, and the record is stamped 1099', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(src, /if \(t === 'provider' && u && u\.employmentType === '1099'\) return 'D';/);
  assert.match(src, /CHAPTER\.relationship\) \|\| 'W2' \}\);/);
});

test('the page offers D, shows its Training tab, and names it Contracted (1099)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(src, /\['D', 'Clinician \(NP, PA\), contracted only \(1099\)'\]/);
  // Every chapter with trainings shows the tab (2026-11-10), D included.
  assert.match(src, /k === 'training' \? \(\(t\.modules \|\| \[\]\)\.length > 0/);
  assert.match(src, /Contracted \(1099\)/);
});

test('a contracted clinician takes the Care Courses HIPAA module, uploads the certificate, and renews it yearly', () => {
  const it = D.ITEMS.find(x => x.id === 'D.6.04');
  assert.ok(it && it.phase === 'D.6');
  assert.match(it.title, /HIPAA/);
  assert.strictEqual(it.link.url, 'https://www.care-courses.com/company/qj5dz/module-detail');
  assert.strictEqual(it.repeats, 'annually');
  assert.deepStrictEqual(it.steps.map(s => [s.actor, s.action]), [['NEW_HIRE', 'SUBMIT'], ['CREDENTIALING_OWNER', 'VERIFY']]);
  assert.ok(T.composeChecklist({ chapter: 'D' }).some(x => x.id === 'D.6.04'));
});
