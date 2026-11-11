'use strict';

// Material the app ships with, seeded once per file (owner, 2026-11-10).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const TM = require('../onboarding/trainingMaterial');
const { findModule } = require('../onboarding/modules');

const ACTOR = { id: 'a', name: 'Admin' };

test('existing Drive material is attached and those trainings read ready', () => {
  const { all, seeded } = TM.seedDefaults({}, '2026-11-10T00:00:00Z');
  assert.deepStrictEqual(seeded.sort(), ['TRN-001', 'TRN-002', 'TRN-004', 'TRN-501', 'TRN-502', 'TRN-503']);
  for (const id of seeded) {
    const mat = TM.materialFor(findModule(id), all[id], null);
    assert.strictEqual(mat.ready, true, id);
    mat.links.forEach(l => assert.match(l.url, /^https:\/\/(docs|drive)\.google\.com\//, id));
  }
  assert.deepStrictEqual(all['TRN-004'].links.map(l => l.url), [
    'https://drive.google.com/file/d/1vXFFEqeAJHGEidNdhB3atE59ZffHu7ma/view',
    'https://drive.google.com/file/d/1fLC9VWBJ3uzzjMgKUUtRThtF3M3m4P5j/view',
    'https://drive.google.com/file/d/1pdgksZaDfczISVC6uTV20bMT0MKaHWVv/view'
  ], 'Set 1, Set 2 and the staff pay guide, in that order');
  assert.ok(all['TRN-503'].links.some(l => /1pdgksZaDfczISVC6uTV20bMT0MKaHWVv/.test(l.url)), 'caregivers get the pay guide');
  assert.ok(!all['TRN-503'].links.some(l => /15I0r9-OCLSQIdsLQwBFb4PuR1wTJ4QKY/.test(l.url)), 'the office payroll SOP never reaches staff');
  assert.strictEqual(all['TRN-501'].links[0].kind, 'video');
  assert.ok(['NONE', 'ATTEST'].includes(findModule('TRN-004').signoff), 'staff can mark the app training complete themselves');
});

test('the seed never overrides the office: not twice, not after removal, not over their own link', () => {
  const first = TM.seedDefaults({}, 'T1').all;
  assert.deepStrictEqual(TM.seedDefaults(first, 'T2').seeded, [], 'once only');
  const removed = TM.remove(first['TRN-004'], 'links', 'default-TRN-004-sop-set1', ACTOR, 'T3');
  assert.ok(!TM.seedDefaults(Object.assign({}, first, { 'TRN-004': removed }), 'T4').seeded.includes('TRN-004'), 'a removal stays removed');
  const own = TM.addLink(null, { label: 'Our copy of Set 1', url: 'https://drive.google.com/file/d/1vXFFEqeAJHGEidNdhB3atE59ZffHu7ma/view', kind: 'document' }, ACTOR, 'T0', 'x1');
  const kept = TM.seedDefaults({ 'TRN-004': own }, 'T5').all['TRN-004'];
  assert.strictEqual(kept.links.filter(l => /1vXFFEqeAJHG/.test(l.url)).length, 1, 'the same document is never added twice');
  assert.strictEqual(kept.links[0].label, 'Our copy of Set 1', 'the office label stays');
});

const OLD_SOP1 = 'https://docs.google.com/document/d/1Bs-wgsurXK3SbJt2aLFD1AtmUEqp2FPqapqM_OA0oFw/view';

test('a deployment that already has the old SOP 1 gets it retired and the SOP sets added', () => {
  const live = { 'TRN-004': { links: [{ id: 'default-TRN-004-sop1', url: OLD_SOP1, label: 'SOP 1: Signing In and Onboarding', kind: 'document' }], files: [], defaultKeysSeeded: ['sop1'], defaultSeededAt: 'T0' } };
  const before = JSON.stringify(live);
  const { all, seeded } = TM.seedDefaults(live, 'T1');
  assert.ok(seeded.includes('TRN-004'));
  assert.strictEqual(JSON.stringify(live), before, 'the stored copy is not changed in place');
  const old = all['TRN-004'].links.find(l => l.url === OLD_SOP1);
  assert.ok(old.removedAt, 'the old link is taken off');
  assert.strictEqual(old.removedAt, 'T1');
  const mat = TM.materialFor(findModule('TRN-004'), all['TRN-004'], null);
  assert.ok(!mat.links.some(l => l.url === OLD_SOP1), 'staff no longer see it');
  assert.strictEqual(mat.links.length, 3);
  assert.deepStrictEqual(TM.seedDefaults(all, 'T2').seeded, [], 'once only');
});

test('a module seeded before keys existed still gets the retirement and the new sets', () => {
  const legacy = { 'TRN-004': { links: [{ id: 'default-TRN-004', url: OLD_SOP1, label: 'SOP 1', kind: 'document' }], files: [], defaultSeededAt: 'T0' } };
  const mat = TM.materialFor(findModule('TRN-004'), TM.seedDefaults(legacy, 'T1').all['TRN-004'], null);
  assert.deepStrictEqual(mat.links.map(l => l.label.slice(0, 26)), ['Administrative SOPs Set 1:', 'Administrative SOPs Set 2:', 'Staff Guide: Setting Up Yo']);
});

test('one module holds several guides: the app training can carry a file per area of the app', () => {
  let e = TM.seedDefaults({}, 'T1').all['TRN-004'];
  e = TM.addLink(e, { label: 'App guide: Hours & Pay', url: 'https://docs.google.com/document/d/a', kind: 'document' }, ACTOR, 'T2', 'l2');
  e = TM.addLink(e, { label: 'App guide: Scheduling & Availability', url: 'https://docs.google.com/document/d/b', kind: 'document' }, ACTOR, 'T3', 'l3');
  assert.strictEqual(TM.materialFor(findModule('TRN-004'), e, null).links.length, 5);
  assert.match(findModule('TRN-004').title, /hours and pay, scheduling and availability/);
});

test('the server runs the seed at boot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /\n\s+await seedDefaultTrainingMaterial\(\);/);
});
