'use strict';

// SOP 1 is the app tour's material (owner, 2026-11-10), seeded once.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const TM = require('../onboarding/trainingMaterial');
const { findModule } = require('../onboarding/modules');

test('TRN-004 gets SOP 1 as material, so staff can open and complete it', () => {
  const { all, seeded } = TM.seedDefaults({}, '2026-11-10T00:00:00Z');
  assert.deepStrictEqual(seeded, ['TRN-004']);
  const mat = TM.materialFor(findModule('TRN-004'), all['TRN-004'], null);
  assert.strictEqual(mat.ready, true);
  assert.match(mat.links[0].url, /^https:\/\/docs\.google\.com\/document\/d\//);
  assert.match(mat.links[0].label, /SOP 1/);
  assert.ok(['NONE', 'ATTEST'].includes(findModule('TRN-004').signoff), 'staff can mark it complete themselves');
});

test('the seed never overrides the office: not twice, not after removal, not over their own material', () => {
  const first = TM.seedDefaults({}, 'T1').all;
  assert.deepStrictEqual(TM.seedDefaults(first, 'T2').seeded, [], 'once only');
  const removed = TM.remove(first['TRN-004'], 'links', 'default-TRN-004', { id: 'a', name: 'Admin' }, 'T3');
  assert.deepStrictEqual(TM.seedDefaults({ 'TRN-004': removed }, 'T4').seeded, [], 'a removal stays removed');
  const own = TM.addLink(null, { label: 'Our tour video', url: 'https://example.com/v', kind: 'video' }, { id: 'a', name: 'Admin' }, 'T0', 'x1');
  const kept = TM.seedDefaults({ 'TRN-004': own }, 'T5');
  assert.deepStrictEqual(kept.seeded, []);
  assert.strictEqual(kept.all['TRN-004'].links.length, 1, 'the office link is the only one');
});

test('the server runs the seed at boot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /\n\s+await seedDefaultTrainingMaterial\(\);/);
});
