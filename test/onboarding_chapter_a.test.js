'use strict';
// Chapter A · Caregiver (Playbook v3.0 A.1-A.13), connected to the welcome
// packet. Owner rule: nothing is recreated — a Playbook item the packet
// already proves READS the packet's own derived checklist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../onboarding/chapterA');
const T = require('../onboarding/track');
const wp = require('../welcomePacketRepository');

const blank = () => wp.buildChecklist({}, [], {}, []);
const allDone = () => blank().map(r => Object.assign({}, r, { status: 'complete' }));
const build = (rows, inputs) => T.buildTrack({ inputs: Object.assign({ chapter: 'A' }, inputs || {}), record: {}, audience: 'office', packetRows: rows });

test('every welcome packet entry is mapped to a Playbook item, and every mapped kind exists', () => {
  const kinds = new Set(blank().map(r => r.kind));
  const used = new Set([].concat(...A.ITEMS.map(i => i.packet || [])));
  used.forEach(k => assert.ok(kinds.has(k), `${k} is not a welcome packet entry`));
  kinds.forEach(k => assert.ok(used.has(k), `packet entry ${k} is not read by any Chapter A item`));
});

test('Chapter A collects no document the packet already collects: no upload step duplicates a packet item', () => {
  A.ITEMS.filter(i => i.packet).forEach(i => i.steps.forEach(s => assert.ok(!(s.actor === 'NEW_HIRE' && s.action === 'SUBMIT'), `${i.id} asks her to submit again`)));
  const ackIds = A.ACKNOWLEDGMENTS.map(a => a.id);
  ['EMPLOYEE_HANDBOOK', 'CODE_OF_CONDUCT', 'HIPAA_ACK'].forEach(id => assert.ok(!ackIds.includes(id), `${id} comes through the packet`));
});

test('a packet-only item completes when the packet entry is done, never before', () => {
  assert.strictEqual(build(blank()).items.find(i => i.id === 'A.6.03').status, 'NOT_STARTED');
  const review = blank().map(r => (r.kind === 'tb_test' ? Object.assign({}, r, { status: 'in_review' }) : r));
  assert.strictEqual(build(review).items.find(i => i.id === 'A.6.03').status, 'SUBMITTED');
  assert.strictEqual(build(allDone()).items.find(i => i.id === 'A.6.03').status, 'COMPLETE');
  // No packet at all fails closed.
  assert.strictEqual(build(undefined).items.find(i => i.id === 'A.6.03').status, 'NOT_STARTED');
});

test('an item with a step the packet does not cover waits for that step even when the packet is done', () => {
  const t = build(allDone());
  const tax = t.items.find(i => i.id === 'A.5.02');
  assert.notStrictEqual(tax.status, 'COMPLETE');
  assert.ok(tax.elements.some(e => e.row === 'Form W-4'));
});

test('a packet entry the packet marks not required does not hold an item open', () => {
  const rows = allDone().map(r => (r.kind === 'immunization_record' ? Object.assign({}, r, { status: 'missing', required: false }) : r));
  assert.strictEqual(build(rows).items.find(i => i.id === 'A.6.08').status, 'COMPLETE');
});

test('her missing packet entry reads as waiting on her; a sent-in one does not', () => {
  assert.strictEqual(build(blank()).items.find(i => i.id === 'A.6.04').waitingOnHer, true);
  const sent = blank().map(r => (r.kind === 'drug_screen' ? Object.assign({}, r, { status: 'in_review' }) : r));
  assert.strictEqual(build(sent).items.find(i => i.id === 'A.6.04').waitingOnHer, false);
});

test('the qualifying route shows the chosen class only, or all three before one is set', () => {
  const rows = (t) => t.items.find(i => i.id === 'A.6.06').elements.map(e => e.row);
  assert.strictEqual(rows(build(blank())).length, 3);
  const pca = rows(build(blank(), { caregiverClass: 'PCA' }));
  assert.strictEqual(pca.length, 1);
  assert.match(pca[0], /^Personal care assistant/);
  assert.ok(!build(blank()).items.some(i => i.id === 'A.6.07'));
  assert.ok(build(blank(), { fortyHourRoute: true }).items.some(i => i.id === 'A.6.07'));
});

test('A.10 is copied with its classifications, and the registry attestation stands in for the ANE attestation', () => {
  assert.deepStrictEqual(A.RECURRING.map(r => r.id), ['A.10.R1', 'A.10.R2', 'A.10.R3', 'A.10.R4', 'A.10.R5', 'A.10.R6']);
  A.RECURRING.forEach(r => assert.ok(r.classification && r.classification.from, r.id));
  assert.ok(A.ITEMS.find(i => i.id === 'A.5.04').packet.includes('registry_attestation'));
});

test('a caregiver defaults to A, the office reads the packet, and the caregiver app links to the policies', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(routes, /if \(t === 'caregiver'\) return 'A';/);
  assert.match(routes, /packetRows: await packetRowsFor\(rec\)/);
  assert.match(routes, /packetRows: packets\[rec\.userId\]/);
  assert.match(routes, /wpRepo\.buildChecklist\(\(packet \|\| \{\}\)\.data, docs, \(packet \|\| \{\}\)\.office, atts\)/);
  const cg = fs.readFileSync(path.join(__dirname, '..', 'public', 'caregiver.html'), 'utf8');
  assert.match(cg, /href="\/onboarding"[^>]*>Open My Onboarding/);
});
