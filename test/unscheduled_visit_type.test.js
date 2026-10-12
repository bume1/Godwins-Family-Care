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
  // Only the types this clinician may write (served as canDocument).
  assert.match(modal, /catalog\.appointmentTypes\) \|\| \[\]\)\.filter\(t => t\.canDocument !== false\)\.map\(t => <option key=\{t\.key\} value=\{t\.key\}>/);
});

test('it only offers a modality the chosen type allows, and phone only when allowed', () => {
  assert.match(modal, /allowedModalities \? allowedModalities\.includes\(m\.key\) : m\.key !== 'phone'/);
});

test('the chosen visit is sent with the note', () => {
  assert.match(modal, /visit\.appointmentType \? \{ visit: \{ \.\.\.visit, location: isPhone \? '' : visit\.location \} \}/);
});

test('a phone call or social work note is only its template sections: no SOAP parts, vitals or exam', () => {
  // The phone type's template is the one Call note box, so the same path
  // renders it; the social work types render their own sections.
  assert.match(modal, /const sectionsOnly = isPhone \|\| !!\(visitType && visitType\.noteShape === 'sections'\)/);
  assert.match(modal, /vitals: \{\}, sections,/);
  assert.match(modal, /\{sectionsOnly && templateSections\.map\(sec => renderOwnSection\(/);
  for (const label of ['Subjective', 'Objective', 'Assessment', 'Plan']) {
    assert.match(modal, new RegExp(`\\{!sectionsOnly && <FormattedField label="${label}"`), `${label} hidden`);
  }
  assert.match(modal, /\{!sectionsOnly && <div>\s*<span className="lblu block mb-1">Vitals/);
});
