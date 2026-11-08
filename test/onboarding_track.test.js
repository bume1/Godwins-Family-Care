'use strict';

// The Chapter C track: composition, collaborative steps, acknowledgments at a
// version, modules held for review, and readiness determinations.

const test = require('node:test');
const assert = require('node:assert');

const T = require('../onboarding/track');
const C = require('../onboarding/chapterC');
const VF = require('../onboarding/versionFlags');

const NOW = '2026-11-08T15:00:00.000Z';
const HER = { id: 'u1', name: 'Test Clinician', isOffice: false };
const OFFICE = { id: 'a1', name: 'Office Admin', isOffice: true };
const item = (id) => T.findItem(id);

test('the checklist composes from her inputs: insured, controlled substances and outside work add their items', () => {
  const base = T.composeChecklist({ serviceLines: ['PRIVATE_PAY'] }).map(i => i.id);
  assert.ok(!base.includes('C.6.07'));
  assert.ok(!base.includes('C.6.05'));
  assert.ok(!base.includes('C.6.09'));
  const full = T.composeChecklist({ serviceLines: ['INSURED'], controlledSubstances: true, outsideEmployment: true }).map(i => i.id);
  for (const id of ['C.6.07', 'C.6.05', 'C.6.09']) assert.ok(full.includes(id), id);
});

test('a credentialing element with a condition shows only when it applies', () => {
  const rowsFor = (inputs) => T.buildTrack({ inputs }).items.find(i => i.id === 'C.6.01').elements.map(e => e.row);
  assert.ok(!rowsFor({ serviceLines: ['PRIVATE_PAY'] }).includes('Criminal records check'));
  assert.ok(rowsFor({ serviceLines: ['PRIVATE_PAY'], residenceUnderPhc: true }).includes('Criminal records check'));
});

test('she cannot complete an office step, a verification above all', () => {
  assert.throws(() => T.recordStep(item('C.4.05'), null, 1, HER, { source: 'x', verifiedOn: '2026-11-08' }, NOW),
    (e) => e.code === 'STEP_NOT_YOURS');
});

test('her submission reads SUBMITTED; the office verification makes it COMPLETE', () => {
  const it = item('C.4.05');
  let st = T.recordStep(it, null, 0, HER, {}, NOW);
  assert.strictEqual(T.itemStatus(it, st), T.STATUS.SUBMITTED);
  assert.strictEqual(st.steps[0].filedBy, 'SELF');
  st = T.recordStep(it, st, 1, OFFICE, { source: 'Prior employer, direct call', verifiedOn: '2026-11-08' }, NOW);
  assert.strictEqual(T.itemStatus(it, st), T.STATUS.COMPLETE);
  assert.strictEqual(st.steps[1].source, 'Prior employer, direct call');
});

test('the office can file her step on her behalf, and it is stamped that way', () => {
  const st = T.recordStep(item('C.4.05'), null, 0, OFFICE, {}, NOW);
  assert.strictEqual(st.steps[0].filedBy, 'OFFICE_ON_BEHALF');
  assert.strictEqual(st.steps[0].byName, 'Office Admin');
});

test('a verification needs a source and a date, and never precedes what it verifies', () => {
  const it = item('C.4.05');
  assert.throws(() => T.recordStep(it, null, 1, OFFICE, { source: 'Nursys', verifiedOn: '2026-11-08' }, NOW), (e) => e.code === 'VERIFY_BEFORE_SUBMISSION');
  const st = T.recordStep(it, null, 0, HER, {}, NOW);
  assert.throws(() => T.recordStep(it, st, 1, OFFICE, { verifiedOn: '2026-11-08' }, NOW), (e) => e.code === 'VERIFY_SOURCE_REQUIRED');
  assert.throws(() => T.recordStep(it, st, 1, OFFICE, { source: 'Nursys' }, NOW), (e) => e.code === 'VERIFY_DATE_REQUIRED');
});

test('a returned step reopens with its reason, takes the verification with it, and keeps the history', () => {
  const it = item('C.4.05');
  let st = T.recordStep(it, null, 0, HER, {}, NOW);
  st = T.recordStep(it, st, 1, OFFICE, { source: 'Employer', verifiedOn: '2026-11-08' }, NOW);
  assert.throws(() => T.returnStep(it, st, 0, OFFICE, '  ', NOW), (e) => e.code === 'RETURN_REASON_REQUIRED');
  assert.throws(() => T.returnStep(it, st, 0, HER, 'x', NOW), (e) => e.code === 'RETURN_OFFICE_ONLY');
  st = T.returnStep(it, st, 0, OFFICE, 'The 2019 gap needs an explanation.', NOW);
  assert.strictEqual(T.itemStatus(it, st), T.STATUS.RETURNED);
  assert.ok(!st.steps[0] && !st.steps[1]);
  assert.strictEqual(st.history[0].reason, 'The 2019 gap needs an explanation.');
  st = T.recordStep(it, st, 0, HER, {}, NOW);
  assert.strictEqual(T.itemStatus(it, st), T.STATUS.SUBMITTED);
});

test('an acknowledgment counts only at the required version: Clinical P&P signed at 2.0 is not 2.2', () => {
  const it = item('C.5.04');
  let st = null;
  for (const a of C.ACKNOWLEDGMENTS) st = T.recordAcknowledgment(it, st, a.id, a.id === 'CLINICAL_MANUAL' ? '2.0' : a.version, OFFICE, NOW);
  assert.notStrictEqual(T.itemStatus(it, st), T.STATUS.COMPLETE);
  const row = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] }, record: { items: { 'C.5.04': st } } })
    .items.find(i => i.id === 'C.5.04').acknowledgments.find(a => a.id === 'CLINICAL_MANUAL');
  assert.strictEqual(row.stale, true);
  assert.strictEqual(row.signed, '2.0');
  assert.strictEqual(row.required, '2.2');
  assert.strictEqual(row.filedBy, 'OFFICE_ON_BEHALF');
  st = T.recordAcknowledgment(it, st, 'CLINICAL_MANUAL', '2.2', HER, NOW);
  assert.strictEqual(T.itemStatus(it, st), T.STATUS.COMPLETE);
});

test('an item the office marks not applicable stays out of the way and cannot take steps', () => {
  const it = item('C.4.03');
  const st = { notApplicable: { at: NOW, byName: 'Office Admin', reason: 'Prior GFC clinician' } };
  assert.strictEqual(T.itemStatus(it, st), T.STATUS.NOT_APPLICABLE);
  assert.throws(() => T.recordStep(it, st, 0, HER, {}, NOW), (e) => e.code === 'ITEM_NOT_APPLICABLE');
});

test('an annual item expires a year after its last step', () => {
  const it = item('C.7.05');
  let st = T.recordStep(it, null, 0, HER, {}, '2025-10-01T12:00:00Z');
  st = T.recordStep(it, st, 1, OFFICE, {}, '2025-10-01T12:00:00Z');
  assert.strictEqual(T.itemStatus(it, st, '2026-09-30'), T.STATUS.COMPLETE);
  assert.strictEqual(T.itemStatus(it, st, '2026-11-08'), T.STATUS.EXPIRED);
});

test('a module flagged by the manual reissue is held for a new learner, and kept for one who finished it', () => {
  const track = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] } });
  const m207 = track.modules.find(m => m.id === 'TRN-207');
  assert.strictEqual(m207.underReview, true);
  assert.strictEqual(m207.available, false);
  const done = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] }, record: { training: { 'TRN-207': { completedAt: NOW, version: '1' } } } });
  assert.strictEqual(done.modules.find(m => m.id === 'TRN-207').complete, true);
  const reviewed = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] }, moduleReviews: { 'TRN-207': { reviewedAgainst: '2.2' } } });
  assert.strictEqual(reviewed.modules.find(m => m.id === 'TRN-207').available, true);
});

test('a module whose version moved on re-checks the learner who completed the old one', () => {
  const t = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] }, record: { training: { 'TRN-209': { completedAt: NOW, version: '0' } } } });
  const m = t.modules.find(x => x.id === 'TRN-209');
  assert.strictEqual(m.complete, false);
  assert.strictEqual(m.recheckForNewVersion, true);
});

test('modules follow the lanes and credentials: exams modules for IME, psychiatric ones for a PMHNP', () => {
  const ids = (inputs) => T.buildTrack({ inputs }).modules.map(m => m.id);
  assert.ok(!ids({ serviceLines: ['PRIVATE_PAY'] }).includes('TRN-101'));
  assert.ok(ids({ serviceLines: ['IME'] }).includes('TRN-101'));
  assert.ok(!ids({ serviceLines: ['IME'] }).includes('TRN-205'));
  assert.ok(!ids({ serviceLines: ['BEHAVIORAL'] }).includes('TRN-211'));
  assert.ok(ids({ serviceLines: ['BEHAVIORAL'], credentials: ['PMHNP'] }).includes('TRN-211'));
});

test('the office sees who acts and on what basis, and the version flags; her view does not', () => {
  const office = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] }, audience: 'office' });
  const hers = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] } });
  assert.ok(office.items[0].steps[0].actorBasis);
  assert.strictEqual(hers.items[0].steps[0].actorBasis, undefined);
  assert.ok(office.modules.find(m => m.id === 'TRN-207').versionFlag);
  assert.strictEqual(hers.modules.find(m => m.id === 'TRN-207').versionFlag, undefined);
  assert.deepStrictEqual(office.moduleFlags.flagged.slice().sort(), ['TRN-006', 'TRN-206', 'TRN-207', 'TRN-208']);
  assert.ok(office.moduleFlags.pending.includes('TRN-210'));
  assert.strictEqual(hers.moduleFlags, undefined);
});

test('readiness: eligible is not opened, and opening needs every condition, the scope and (for insured) the payer', () => {
  const inputs = { serviceLines: ['IME'] };
  const allIme = ['TRN-101', 'TRN-102', 'TRN-103', 'TRN-104', 'TRN-105'];
  const det = C.DETERMINATIONS.find(d => d.id === 'IME');
  assert.throws(() => T.openDetermination('IME', inputs, {}, {}, HER, {}, NOW), (e) => e.code === 'DETERMINATION_OFFICE_ONLY');
  assert.throws(() => T.openDetermination('PRIVATE_PAY', inputs, {}, {}, OFFICE, {}, NOW), (e) => e.code === 'DETERMINATION_NOT_IN_SCOPE');
  assert.throws(() => T.openDetermination('IME', inputs, {}, {}, OFFICE, {}, NOW), (e) => e.code === 'DETERMINATION_NOT_READY' && e.outstanding.length === 5);
  const record = { training: Object.fromEntries(allIme.map(id => [id, { completedAt: NOW, version: '1' }])) };
  const t = T.buildTrack({ inputs, record });
  const st = t.determinations.find(d => d.id === 'IME');
  assert.strictEqual(st.eligible, true);
  assert.strictEqual(st.opened, null);
  assert.strictEqual(st.openItem, 'NON_PRESCRIBING_PROTOCOL');
  assert.throws(() => T.openDetermination('IME', inputs, record, { conditionsConfirmed: det.conditions.slice(1), approvedScope: 'C&P' }, OFFICE, {}, NOW),
    (e) => e.code === 'DETERMINATION_CONDITIONS' && e.missing.length === 1);
  assert.throws(() => T.openDetermination('IME', inputs, record, { conditionsConfirmed: det.conditions }, OFFICE, {}, NOW), (e) => e.code === 'DETERMINATION_SCOPE_REQUIRED');
  const opened = T.openDetermination('IME', inputs, record, { conditionsConfirmed: det.conditions, approvedScope: 'C&P examinations' }, OFFICE, {}, NOW);
  assert.strictEqual(opened.reviewedBy.name, 'Office Admin');
  assert.deepStrictEqual(opened.modulesComplete.sort(), allIme.sort());

  const ins = C.DETERMINATIONS.find(d => d.id === 'INSURED');
  const insRecord = { training: { 'TRN-208': { completedAt: NOW, version: '1' }, 'TRN-215': { completedAt: NOW, version: '1' } } };
  assert.throws(() => T.openDetermination('INSURED', { serviceLines: ['INSURED'] }, insRecord, { conditionsConfirmed: ins.conditions, approvedScope: 'x' }, OFFICE, {}, NOW),
    (e) => e.code === 'DETERMINATION_PAYER_REQUIRED');
});

test('insured billing carries private pay\'s training too', () => {
  const t = T.buildTrack({ inputs: { serviceLines: ['INSURED'] } });
  const d = t.determinations.find(x => x.id === 'INSURED');
  assert.ok(d.requiredModules.includes('TRN-215'));
  assert.ok(d.requiredModules.includes('TRN-208'));
});

test('Phase C.6 is marked as its own credentialing record', () => {
  const t = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] } });
  assert.strictEqual(t.phases.find(p => p.id === 'C.6').separateRecord, 'CREDENTIALING');
});

test('a flag status the engine does not produce is never read as under review', () => {
  const m = require('../onboarding/modules').findModule('TRN-209');
  assert.strictEqual(T.moduleState(m, null, { status: VF.STATUS.PENDING }).available, true);
});

test('an acknowledgment item cannot be ticked off as a whole, only document by document', () => {
  assert.throws(() => T.recordStep(item('C.5.04'), null, 0, OFFICE, {}, NOW), (e) => e.code === 'ACK_PER_DOCUMENT');
});
