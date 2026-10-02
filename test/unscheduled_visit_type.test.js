'use strict';
// "Document unscheduled visit" opens FollowUpModal. It had no visit-type
// picker, so a Phone Call / Care Management note (or any other type) could
// not be started from it (owner report, 2026-10-02).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const start = page.indexOf('const FollowUpModal = ');
const end = page.indexOf('const RxForm = ', start);
const modal = page.slice(start, end).replace(/^\s*\/\/.*$/gm, '');

test('the unscheduled-visit form reads the served visit catalog', () => {
  assert.ok(start > 0 && end > start, 'FollowUpModal not found');
  assert.match(modal, /api\.placeOfService\(patient\.id\)/);
  assert.match(modal, /catalog\.appointmentTypes\) \|\| \[\]\)\.map\(t => <option key=\{t\.key\} value=\{t\.key\}>/);
});

test('it only offers a modality the chosen type allows, and phone only when allowed', () => {
  assert.match(modal, /allowedModalities \? allowedModalities\.includes\(m\.key\) : m\.key !== 'phone'/);
});

test('the chosen visit is sent with the note', () => {
  assert.match(modal, /visit\.appointmentType \? \{ visit: \{ \.\.\.visit, location: isPhone \? '' : visit\.location \} \}/);
});

test('a phone call is one open note box: no SOAP parts, vitals or exam', () => {
  assert.match(modal, /vitals: \{\}, sections: \{ callNote: f\.callNote \}/);
  assert.match(modal, /\{isPhone\s*\? <FormattedField label="Call note"/);
  for (const label of ['Subjective', 'Objective', 'Assessment', 'Plan']) {
    assert.match(modal, new RegExp(`\\{!isPhone && <FormattedField label="${label}"`), `${label} hidden on a call`);
  }
  assert.match(modal, /\{!isPhone && <div>\s*<span className="lblu block mb-1">Vitals/);
});
