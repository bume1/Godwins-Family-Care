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
  // Every note now carries its type (Follow-up is the default), so the visit
  // is always sent rather than only when a type was picked (owner, 2026-10-12).
  assert.match(modal, /const visitOut = \{ \.\.\.visit, location: isPhone \? '' : visit\.location \}/);
  assert.equal((modal.match(/visit: visitOut/g) || []).length, 2, 'both note shapes send the visit');
});

test('a phone call or social work note is only its template sections: no SOAP parts, vitals or exam', () => {
  // The phone type's template is the one Call note box, so the same path
  // renders it; the social work types render their own sections.
  assert.match(modal, /const sectionsOnly = isPhone \|\| !!\(visitType && visitType\.noteShape === 'sections'\)/);
  assert.match(modal, /vitals: \{\}, sections,/);
  assert.match(modal, /\{sectionsOnly && templateSections\.map\(sec => renderOwnSection\(/);
});

// Owner, 2026-10-12: the popup is a short starter. The note itself is written
// on the encounter, in the same SOAP layout the Visit tab shows, so the popup
// must not grow a third copy of it again.
test('the popup is a starter: no S/O/A/P boxes, no vitals, no coding — the note opens on its encounter', () => {
  for (const label of ['Subjective', 'Objective', 'Assessment', 'Plan']) {
    assert.doesNotMatch(modal, new RegExp(`<FormattedField label="${label}"`), `${label} box is back in the popup`);
  }
  assert.doesNotMatch(modal, /FollowUpVital/, 'vitals are back in the popup');
  assert.doesNotMatch(modal, /<DxEditor|<SvcEditor/, 'coding is back in the popup');
  assert.match(modal, /<FormattedField label="Chief Complaint"/);
});

test('Follow-up is the default visit type, so every follow-up opens with its SOAP template', () => {
  assert.match(modal, /t\.key === 'pc_follow_up' && t\.canDocument !== false/);
  assert.doesNotMatch(modal, /no specific type/);
});
