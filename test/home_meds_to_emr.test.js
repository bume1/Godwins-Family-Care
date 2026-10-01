'use strict';
// Owner, 2026-09-29: every medication the family reported at enrollment and a
// clinician kept or added at reconciliation is written to OpenEMR's
// prescriptions, once, and marked as a home medication, not a GFC order.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const repo = require('../clinicalRepository');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const route = SERVER.slice(SERVER.indexOf("app.post('/api/clinical/patients/:clientId/medrec'"), SERVER.indexOf("res.json({ message: 'Medications reconciled'"));

test('a kept or added medication with no OpenEMR row is sent; discontinued and linked ones are not', () => {
  const out = repo.homeMedsToSend([
    { action: 'keep', med: { name: 'Amlodipine', dose: '5 mg' } },
    { action: 'add', med: { name: 'Vitamin D' } },
    { action: 'keep', med: { name: 'Lisinopril' }, emrUuid: 'u1' },
    { action: 'discontinue', med: { name: 'Ibuprofen' } }
  ], []);
  assert.deepEqual(out.map(m => m.name), ['Amlodipine', 'Vitamin D']);
});

test('a name already on OpenEMR\'s prescription list is never sent twice', () => {
  const out = repo.homeMedsToSend([
    { action: 'keep', med: { name: 'Amlodipine' } }, { action: 'keep', med: { name: 'amlodipine besylate' } }, { action: 'keep', med: { name: 'Furosemide' } }
  ], ['Furosemide 20 mg']);
  assert.deepEqual(out.map(m => m.name), ['Amlodipine']);
});

test('the OpenEMR row says it is a home medication, carries the dose and frequency, and names who reconciled it', () => {
  const row = repo.homeMedicationToEmrRow({ name: 'Carbamazepine', dose: '200 mg', route: 'oral', frequency: 'twice daily', prescriber: 'Dr. Lee', pharmacy: 'CVS' },
    { byName: 'Bethel Godwins', credential: 'NP', day: '2026-09-29' });
  assert.equal(row.drug, 'Carbamazepine');
  assert.equal(row.dosage, '200 mg');
  assert.equal(row.interval, 'twice daily');
  assert.equal(row.route, 'oral');
  assert.equal(row.date_added, '2026-09-29');
  assert.match(row.note, /^Home medication, reported at enrollment and reconciled by Bethel Godwins, NP on 2026-09-29\. Not a new GFC prescription\./);
  assert.match(row.note, /Sig: 200 mg oral twice daily\./);
  assert.match(row.note, /Prescriber: Dr\. Lee\./);
  assert.ok(row.note.length <= 255);
});

test('the route reads OpenEMR\'s list first and sends nothing when that read fails', () => {
  const read = route.indexOf('emr.getPrescriptions(client.openEmrPatientId)');
  const send = route.indexOf('emr.createPrescription(');
  assert.ok(read > 0 && send > read, 'the list is read before anything is written');
  assert.match(route, /if \(existingRx\) \{/);
  assert.match(route, /clinicalRepo\.homeMedsToSend\(req\.body\.decisions, existingRx\)/);
});

test('an added medication goes to prescriptions, not the old medication-list write', () => {
  assert.doesNotMatch(route, /emr\.addMedication\(/);
});

test('the app row remembers its OpenEMR prescription across saves', () => {
  assert.match(route, /emrPrescriptionId: link/);
  assert.match(route, /priorLink/);
});
