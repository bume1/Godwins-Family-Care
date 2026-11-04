'use strict';
// An unscheduled visit used to start from its own popup (FollowUpModal). On
// 2026-11-04 the owner folded every way of starting a visit into ONE: New
// Visit opens the visit screen (HpTab), which asks for the appointment, or
// none, and the visit type. These are the popup's rules, repointed at the one
// screen that now carries them: a guard that disappears with the code it was
// aimed at is a guard lost.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'clinical.html'), 'utf8');
const start = page.indexOf('const HpTab = (');
const end = page.indexOf('const MedRecTab', start);
const screen = page.slice(start, end).replace(/^\s*\/\/.*$/gm, '');

test('there is one way to start a visit, and the popup is gone', () => {
  assert.ok(start > 0 && end > start, 'HpTab not found');
  assert.doesNotMatch(page, /const FollowUpModal = \(/, 'the Document a Visit popup is folded into the visit screen');
  assert.doesNotMatch(page, /Document Unscheduled Visit|Document Follow-Up/, 'no second button starts a note');
  assert.match(page, /\{draftOpen \? 'Resume Draft' : 'New Visit'\}/, 'the banner starts it');
});

test('a visit opened without an appointment asks which one it is for, or none', () => {
  assert.match(screen, /\{!embedded && !givenEid && !sn\.euuid && !encounterUuid && <VisitAppointmentPicker /);
  assert.match(screen, /const appointmentEid = givenEid \|\| pickedEid;/);
  assert.match(page, /<option value="">Unscheduled visit \(no appointment\)<\/option>/);
  // Only appointments that are due and have no note yet.
  assert.match(page, /filter\(a => !a\.encounterUuid && a\.date <= today && \['scheduled', 'needs_documentation'\]\.includes\(a\.state\)\)/);
});

test('the visit screen reads the served visit catalog, and offers only the types this clinician may write', () => {
  assert.match(screen, /api\.placeOfService\(patient\.id\)/);
  assert.match(screen, /\.filter\(t => t\.service === svc\.key && t\.canDocument !== false\)/);
});

test('it only offers a modality the chosen type allows, and phone only when allowed', () => {
  assert.match(screen, /\.filter\(m => m\.key !== 'phone' \|\| \(allowedModalities && allowedModalities\.includes\('phone'\)\)\)/);
  assert.match(screen, /disabled=\{allowedModalities \? !allowedModalities\.includes\(m\.key\)/);
});

test('the chosen visit is sent with the note', () => {
  assert.match(screen, /confirmedFields: confirmed, visit: \{ \.\.\.visit, location: isPhone \? '' : visit\.location \}/);
  assert.match(screen, /confirmedFields: confirmed, visit\n/);
});

test('a phone call or social work note is only its template sections: no SOAP parts, vitals or exam', () => {
  assert.match(screen, /const sectionsOnly = isPhone \|\| isSocialWorker \|\| !!\(visitType && visitType\.noteShape === 'sections'\)/);
  assert.match(screen, /assessment: '', plan: '', sections: f\.sections, vitals: \{\},/);
});

test('Follow-up is the default visit type once the initial visit is done, so a follow-up never saves as an H&P', () => {
  assert.match(screen, /t\.key === 'pc_follow_up' && t\.canDocument !== false/);
  assert.match(screen, /if \(fu && patient\.initialVisitAt && !\['lcsw', 'lmsw'\]\.includes\(myRole\)\) setVisit\(v => v\.appointmentType \? v : \{ \.\.\.v, appointmentType: fu\.key \}\);/,
    'only when no type is set yet, so a saved draft keeps its own');
});
