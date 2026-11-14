'use strict';
// The office's People list names only the paperwork a person actually owes
// (2026-11-11): a 1099 contractor is never listed as missing a W-4, G-4 or I-9.
const test = require('node:test');
const assert = require('node:assert');
const pp = require('../payrollProfiles');

test('a contractor owes a W-9, an employee the employee forms, a hybrid both', () => {
  const c = pp.missingForPerson({ workerType: '1099', payType: 'hourly' });
  assert.ok(c.includes('W-9'));
  for (const f of ['W-4', 'G-4', 'I-9 Section 1 (theirs)', 'I-9 Section 2 (the office)', 'SSN']) assert.ok(!c.includes(f), f);
  const e = pp.missingForPerson({ workerType: 'W2', payType: 'hourly', isCaregiver: true });
  for (const f of ['W-4', 'G-4', 'I-9 Section 1 (theirs)', 'I-9 Section 2 (the office)', 'SSN']) assert.ok(e.includes(f), f);
  assert.ok(!e.includes('W-9'));
  const h = pp.missingForPerson({ workerType: 'HYBRID', payType: 'hourly', isCaregiver: true });
  assert.ok(h.includes('W-4') && h.includes('W-9'));
  assert.strictEqual(h.filter(x => /How they are paid/.test(x)).length, 1, 'listed once');
});

test('the People list uses it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'payroll.js'), 'utf8');
  assert.match(src, /missing: pp\.missingForPerson\(profile\)/);
});
