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
  D.ITEMS.forEach(it => assert.doesNotMatch(it.title, /train|competenc|orientation|probation|schedul|shift/i, it.id));
  D.ITEMS.forEach(it => it.steps.forEach(s => assert.notStrictEqual(s.action, 'OBSERVE', `${it.id} supervises her practice`)));
});

test('a D track carries no Training Library modules and its service lines open without them', () => {
  const t = T.buildTrack({ inputs: D_INPUTS, record: {}, audience: 'office' });
  assert.strictEqual(t.chapter.id, 'D');
  assert.strictEqual(t.modules.length, 0);
  t.phases.forEach(p => assert.strictEqual(p.requiredModules.length, 0, p.id));
  assert.deepStrictEqual(t.determinations.map(d => d.id).sort(), ['BEHAVIORAL', 'IME', 'INSURED', 'PRIVATE_PAY']);
  t.determinations.forEach(d => { assert.strictEqual(d.requiredModules.length, 0, d.id); assert.strictEqual(d.eligible, true, d.id); });
  // The same lines under C do wait on modules, so the difference is the chapter.
  const c = T.buildTrack({ inputs: Object.assign({}, D_INPUTS, { chapter: 'C' }), record: {}, audience: 'office' });
  assert.ok(c.determinations.some(d => d.requiredModules.length > 0));
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

test('the page offers D, hides the Training tab for it, and names it Contracted (1099)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(src, /\['D', 'Clinician \(NP, PA\), contracted \(1099\)'\]/);
  assert.match(src, /k === 'training' \? t\.chapter\.id === 'C'/);
  assert.match(src, /Contracted \(1099\)/);
});
