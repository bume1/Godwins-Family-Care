'use strict';
// Patients edit their own contact details (owner, 2026-10-13).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../portalProfile');

test('PE1: only contact fields get through; identity, insurance and clinical fields do not', () => {
  const { edits, ignored } = P.pickPatientEdits({
    phone: '404', 'address.city': 'Decatur', primaryContact: { phone: '1' },
    dob: '1999-01-01', clientLast: 'X', payerType: 'Self-pay', medications: [], allergies: 'none'
  });
  assert.deepStrictEqual(edits, { phone: '404', address: { city: 'Decatur' }, primaryContact: { phone: '1' } });
  assert.deepStrictEqual(ignored.sort(), ['allergies', 'clientLast', 'dob', 'medications', 'payerType']);
  for (const p of P.PATIENT_EDITABLE_PATHS) assert.ok(!/dob|clientFirst|clientLast|payer|insurance|medic|allerg/i.test(p), p);
});

test('PE2: the greeting uses a preferred name whole and skips a title', () => {
  assert.strictEqual(P.greetingName({ name: 'Ms Juanita Guess' }), 'Juanita');
  assert.strictEqual(P.greetingName({ name: 'Dr. Ann Lee' }), 'Ann');
  assert.strictEqual(P.greetingName({ name: 'Ms Juanita Guess', intake: { preferredName: 'Ms. Guess' } }), 'Ms. Guess');
  assert.strictEqual(P.greetingName({ name: 'X Y', intake: { clientFirst: 'Juanita' } }), 'Juanita');
  assert.strictEqual(P.greetingName({}), 'there');
});

test('PE3: OpenEMR gets the contact fields in its own names', () => {
  const c = P.emrContactFrom({ phone: '404', address: { line1: '22 New St', line2: 'Apt 4', city: 'Decatur', state: 'GA', zip: '30030' } }, 'a@b.c');
  assert.deepStrictEqual(c, { phone_home: '404', street: '22 New St Apt 4', city: 'Decatur', state: 'GA', postal_code: '30030', email: 'a@b.c' });
  assert.strictEqual(P.composedAddress({ line1: '22 New St', city: 'Decatur', state: 'GA', zip: '30030' }), '22 New St, Decatur, GA 30030');
});

test('PE4: the route narrows, a POA cannot change the email, and OpenEMR waits for a clinician', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const at = src.indexOf("app.put('/api/gfc/profile'");
  const route = src.slice(at, src.indexOf('\n});', at));
  assert.match(route, /const \{ edits \} = portalProfile\.pickPatientEdits\(body\);/);
  assert.match(route, /applyEnrollmentEdits\(next, edits, rejectedValues\)/);
  assert.match(route, /if \(!isClient\) return res\.status\(403\)\.json\(\{ error: 'Only the client can change their own sign-in email\.'/);
  assert.ok(!/openemr\.forActor\(/.test(route), 'the patient route never calls OpenEMR');
  const chart = src.slice(src.indexOf("app.get('/api/clinical/patients/:clientId/chart'"));
  assert.match(chart.slice(0, chart.indexOf('const puuid')), /\n\s+syncPendingContactToEmr\(client\.id, req\.user\);/);
  const sync = src.slice(src.indexOf('const syncPendingContactToEmr'), src.indexOf('// The catch-up pass'));
  assert.ok(sync.includes('clinicalRoles.canClinicalWrite(user)'));
  assert.ok(sync.includes('emrAuth.statusFor(user.id)'));
});

test('PE5: the openemr client checks the update was accepted, not just the status', () => {
  const src = fs.readFileSync(path.join(__dirname, '../openemr.js'), 'utf8');
  const fn = src.slice(src.indexOf('async updatePatientContact'), src.indexOf('async uploadPatientDocument'));
  assert.match(fn, /const ve = data && data\.validationErrors;/);
  assert.match(fn, /throw new OpenEmrError\(`OpenEMR did not accept the contact update/);
});
