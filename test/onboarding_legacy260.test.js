'use strict';

// #260's records carried onto the Playbook v3.0 checklist: shown, never
// counted as completing a new item.

const test = require('node:test');
const assert = require('node:assert');

const { ITEM_LIBRARY } = require('../clinicianItems');
const { LEGACY_MAP, carryOver } = require('../onboarding/legacy260');
const T = require('../onboarding/track');
const C = require('../onboarding/chapterC');
const { MODULES } = require('../onboarding/modules');

test('every #260 item is accounted for: a Chapter C item, a module, or a stated reason', () => {
  for (const it of ITEM_LIBRARY) {
    const m = LEGACY_MAP[it.id];
    assert.ok(m, `${it.id} (${it.title}) is not mapped`);
    if (m.item) assert.ok(C.ITEMS.some(x => x.id === m.item), `${it.id} -> unknown item ${m.item}`);
    else if (m.module) assert.ok(MODULES.some(x => x.id === m.module), `${it.id} -> unknown module ${m.module}`);
    else assert.ok(typeof m.none === 'string' && m.none.length > 10, `${it.id} has no reason`);
  }
  for (const id of Object.keys(LEGACY_MAP)) assert.ok(ITEM_LIBRARY.some(x => x.id === id), `${id} is not a #260 item`);
});

test('carried records are shown as evidence and never complete the new item', () => {
  const titles = Object.fromEntries(ITEM_LIBRARY.map(i => [i.id, i.title]));
  const legacy = { titles, items: {
    'CORE-06': { status: 'complete', completedAt: '2026-11-06', byName: 'Office Admin', proofFiles: [{ id: 'f1', name: 'i9.pdf', uploadedAt: '2026-11-06', driveFileId: 'SECRET' }] },
    'CORE-07': { status: 'complete', completedAt: '2026-11-06' },
    'CLIN-12': { status: 'complete', completedAt: '2026-11-06' },
    'CLIN-17': { status: 'submitted', at: '2026-11-07' },
    'CLIN-03': { status: 'not_started' }
  } };
  const t = T.buildTrack({ inputs: { serviceLines: ['PRIVATE_PAY'] }, legacy, audience: 'office' });
  const i9 = t.items.find(x => x.id === 'C.5.03');
  assert.strictEqual(i9.status, T.STATUS.NOT_STARTED);
  assert.deepStrictEqual(i9.carriedOver.map(e => e.oldId), ['CORE-06', 'CORE-07']);
  assert.strictEqual(i9.carriedOver[0].title, 'Form I-9');
  assert.strictEqual(i9.carriedOver[0].proofFiles[0].driveFileId, undefined);
  assert.deepStrictEqual(t.modules.find(m => m.id === 'TRN-006').carriedOver.map(e => e.oldId), ['CLIN-17']);
  assert.strictEqual(t.items.find(x => x.id === 'C.4.02').carriedOver.length, 0);
  const tb = t.legacyUnmapped.find(e => e.oldId === 'CLIN-12');
  assert.match(tb.reason, /16\.5/);
});

test('the office sees what has no Chapter C home; her view does not carry that list', () => {
  const legacy = { items: { 'MD-01': { status: 'complete' } } };
  assert.strictEqual(T.buildTrack({ inputs: {}, legacy, audience: 'office' }).legacyUnmapped.length, 1);
  assert.strictEqual(T.buildTrack({ inputs: {}, legacy }).legacyUnmapped, undefined);
  assert.deepStrictEqual(carryOver(null).unmapped, []);
});
