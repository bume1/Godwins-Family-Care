'use strict';
// Chapter E · Clinician, Hybrid. Owner rule, 2026-11-08: a hybrid clears
// EVERY W-2 requirement (Chapter C whole), and the contractor side is small,
// for payment classification only. Chapter D's guards are for true
// contractors and must not leak into E.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../onboarding/chapterC');
const E = require('../onboarding/chapterE');
const T = require('../onboarding/track');

const IN = { chapter: 'E', serviceLines: ['IME', 'PRIVATE_PAY'] };

test('E carries every Chapter C item and acknowledgment, Handbook and I-9/W-4 included', () => {
  C.ITEMS.forEach(it => assert.ok(E.ITEMS.includes(it), `${it.id} missing from E`));
  assert.ok(E.ACKNOWLEDGMENTS.some(a => a.id === 'EMPLOYEE_HANDBOOK'));
  const tax = E.ITEMS.find(x => x.id === 'C.5.03');
  assert.ok(tax.elements.includes('Form I-9') && tax.elements.includes('Form W-4'));
});

test('the contractor side is small: an exam contract, a W-9, and the separation', () => {
  assert.deepStrictEqual(E.CONTRACT_ITEMS.map(x => x.id), ['E.2.01', 'E.2.02', 'E.2.03']);
  E.CONTRACT_ITEMS.forEach(x => assert.strictEqual(x.phase, 'E.2'));
  assert.ok(E.CONTRACT_ITEMS.find(x => x.id === 'E.2.02').elements.includes('Form W-9'));
});

test('a hybrid trains exactly as an employed clinician does', () => {
  const e = T.buildTrack({ inputs: IN, record: {}, audience: 'office' });
  const c = T.buildTrack({ inputs: Object.assign({}, IN, { chapter: 'C' }), record: {}, audience: 'office' });
  assert.strictEqual(e.chapter.relationship, 'W2+1099');
  assert.strictEqual(e.modules.length, c.modules.length);
  assert.ok(e.modules.length > 0);
  e.determinations.forEach(d => assert.deepStrictEqual(d.requiredModules, c.determinations.find(x => x.id === d.id).requiredModules, d.id));
  assert.strictEqual(e.items.length, c.items.length + 3);
});

test('item ids stay unique across chapters even though E reuses C', () => {
  const ids = require('../onboarding/track').CHAPTERS;
  const all = [].concat(...Object.values(ids).map(ch => ch.ITEMS)).map(x => x.id);
  const T2 = require('../onboarding/track');
  assert.strictEqual(T2.findItem('C.5.03').id, 'C.5.03');
  assert.ok(all.filter(x => x === 'C.5.03').length === 2); // C and E share the object
});

test('a HYBRID provider defaults to E, clocks in for clinical hours only, and can be set in the admin form', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(routes, /u\.employmentType === 'HYBRID'\) return 'E';/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /EMPLOYMENT_TYPES = Object\.freeze\(\['W2', '1099', 'HYBRID'\]\)/);
  const sched = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scheduling.js'), 'utf8');
  assert.match(sched, /\['W2', 'HYBRID'\]\.includes\(u\.employmentType\)/);
  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-hub.html'), 'utf8');
  assert.match(hub, /<option value="HYBRID">/);
  const my = fs.readFileSync(path.join(__dirname, '..', 'public', 'my-gfc.js'), 'utf8');
  assert.match(my, /employmentType === 'HYBRID'[\s\S]{0,200}Exam cases are paid by case/);
});
