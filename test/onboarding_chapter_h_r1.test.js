'use strict';
// Chapter H (student) and Reference R1 (supervising physician, Georgia).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('../onboarding/chapterH');
const R1 = require('../onboarding/chapterR1');
const T = require('../onboarding/track');
const R = require('../onboarding/renewals');
const staffFolders = require('../onboarding/staffFolders');

test('H.1: a student is not an employee: no Handbook, no I-9 or W-4, no offer, no time clock, no payroll duty', () => {
  const ackIds = H.ACKNOWLEDGMENTS.map(a => a.id);
  assert.ok(!ackIds.includes('EMPLOYEE_HANDBOOK'));
  H.ITEMS.forEach(it => {
    const rows = (it.elements || []).join(' | ');
    assert.doesNotMatch(rows, /I-9|W-4|direct deposit|pay rate/i, it.id);
    assert.doesNotMatch(it.title, /offer|employment agreement|time record|payroll/i, it.id);
  });
  assert.strictEqual(H.RECURRING.length, 0);
  assert.strictEqual(H.CHAPTER.relationship, 'PLACEMENT');
});

test('H.2/H.5: student hours are never billed and student documentation is countersigned', () => {
  const lim = H.ITEMS.find(i => i.id === 'H.5.02');
  assert.ok(lim.elements.some(e => /never billed/.test(e)));
  assert.ok(lim.elements.some(e => /countersigned/.test(e)));
  assert.ok(lim.classifications.some(c => c.phrase === 'Statutory' && c.row === 'Billing restriction'));
});

test('H.3: the affiliation agreement names the coverage position; the Field Addendum only for a residence placement', () => {
  assert.ok(H.ITEMS.find(i => i.id === 'H.3.02').elements.some(e => /liability coverage/i.test(e)));
  const ids = (inputs) => T.composeChecklist(Object.assign({ chapter: 'H' }, inputs)).map(i => i.id);
  assert.ok(!ids({}).includes('H.3.04'));
  assert.ok(ids({ entersResidence: true }).includes('H.3.04'));
  assert.ok(R.EXPIRING_ITEMS['H.4.03'], 'BLS expiration is recorded (H.4)');
});

test('R1 is Georgia only: the delegation limit is eight and no other state is built', () => {
  assert.strictEqual(R1.CHAPTER.state, 'GA');
  assert.strictEqual(R1.GA_DELEGATION_LIMIT, 8);
  const all = JSON.stringify(R1.ITEMS) + JSON.stringify(R1.RECURRING);
  assert.doesNotMatch(all, /North Carolina|Alabama/);
  assert.match(R1.ITEMS.find(i => i.id === 'R1.2.02').elements[0], /eight|8/);
});

test('R1.3: every recurring obligation is there, each with its Georgia citation', () => {
  assert.deepStrictEqual(R1.RECURRING.map(r => r.id), ['R1.3.R1', 'R1.3.R2', 'R1.3.R3', 'R1.3.R4', 'R1.3.R5', 'R1.3.R6', 'R1.3.R7']);
  R1.RECURRING.forEach(r => assert.match(r.requirement, /(Rule 360-32|O\.C\.G\.A\. § 43-34-25)/, r.id));
  assert.deepStrictEqual(R1.RECURRING.filter(r => r.days === 90).map(r => r.id), ['R1.3.R1', 'R1.3.R2']);
  assert.deepStrictEqual(R1.RECURRING.filter(r => r.days === 365).map(r => r.id), ['R1.3.R4', 'R1.3.R5', 'R1.3.R6']);
  assert.deepStrictEqual(R1.RECURRING.filter(r => r.days === null).map(r => r.id), ['R1.3.R3', 'R1.3.R7']);
  // R1.3 has no classification column; nothing is assigned.
  R1.RECURRING.forEach(r => assert.strictEqual(r.classification, null));
  R1.ITEMS.forEach(i => assert.deepStrictEqual(i.classifications, []));
  assert.strictEqual(R.recordRecurring('R1.3.R1', {}, '2026-11-09', { name: 'Office' }, 'now').recurring['R1.3.R1'].lastDoneOn, '2026-11-09');
});

test('R1.1: fair market value compensation is documented as its own item', () => {
  const fmv = R1.ITEMS.find(i => i.id === 'R1.1.01');
  assert.ok(fmv && fmv.elements.some(e => /basis for the rate/.test(e)));
});

test('both tracks build with no Training Library modules, a Drive folder, and the right defaults and choices', () => {
  for (const c of ['H', 'R1']) {
    const t = T.buildTrack({ inputs: { chapter: c }, record: {}, audience: 'office' });
    assert.strictEqual(t.chapter.id, c);
    // A student gets only the general modules (owner, 2026-11-10); a
    // supervising physician under agreement gets none.
    assert.deepStrictEqual(t.modules.map(m => m.id).sort(), c === 'H' ? [...require('../onboarding/libraryTrainings').SHARED_MODULE_IDS].sort() : []);
    assert.ok(staffFolders.folderForChapter(c));
  }
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(routes, /if \(t === 'provider' && u && \['MD', 'DO'\]\.includes\(u\.prescriberCredential\)\) return 'R1';/);
  assert.match(routes, /\{ id: 'H', label:/);
  assert.match(routes, /\{ id: 'R1', label:/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /\['H', 'Student or extern/);
  assert.match(page, /\['R1', 'Supervising \(delegating\) physician, Georgia'\]/);
});
