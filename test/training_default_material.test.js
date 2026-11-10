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
  assert.match(all['TRN-004'].links[0].label, /SOP 1/);
  assert.strictEqual(all['TRN-501'].links[0].kind, 'video');
  assert.ok(['NONE', 'ATTEST'].includes(findModule('TRN-004').signoff), 'staff can mark the app training complete themselves');
});

test('the seed never overrides the office: not twice, not after removal, not over their own link', () => {
  const first = TM.seedDefaults({}, 'T1').all;
  assert.deepStrictEqual(TM.seedDefaults(first, 'T2').seeded, [], 'once only');
  const removed = TM.remove(first['TRN-004'], 'links', 'default-TRN-004-sop1', ACTOR, 'T3');
  assert.ok(!TM.seedDefaults(Object.assign({}, first, { 'TRN-004': removed }), 'T4').seeded.includes('TRN-004'), 'a removal stays removed');
  const own = TM.addLink(null, { label: 'Our tour', url: 'https://docs.google.com/document/d/1Bs-wgsurXK3SbJt2aLFD1AtmUEqp2FPqapqM_OA0oFw/view', kind: 'document' }, ACTOR, 'T0', 'x1');
  const kept = TM.seedDefaults({ 'TRN-004': own }, 'T5').all['TRN-004'];
  assert.strictEqual(kept.links.length, 1, 'the same document is never added twice');
});

test('a module seeded before keys existed is not re-seeded', () => {
  const legacy = { 'TRN-004': { links: [{ id: 'default-TRN-004', url: 'https://docs.google.com/x', label: 'SOP 1', kind: 'document' }], files: [], defaultSeededAt: 'T0' } };
  assert.strictEqual(TM.seedDefaults(legacy, 'T1').all['TRN-004'].links.length, 1);
});

test('one module holds several guides: the app training can carry a file per area of the app', () => {
  let e = TM.seedDefaults({}, 'T1').all['TRN-004'];
  e = TM.addLink(e, { label: 'App guide: Hours & Pay', url: 'https://docs.google.com/document/d/a', kind: 'document' }, ACTOR, 'T2', 'l2');
  e = TM.addLink(e, { label: 'App guide: Scheduling & Availability', url: 'https://docs.google.com/document/d/b', kind: 'document' }, ACTOR, 'T3', 'l3');
  assert.strictEqual(TM.materialFor(findModule('TRN-004'), e, null).links.length, 3);
  assert.match(findModule('TRN-004').title, /hours and pay, scheduling and availability/);
});

test('the server runs the seed at boot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /\n\s+await seedDefaultTrainingMaterial\(\);/);
});
