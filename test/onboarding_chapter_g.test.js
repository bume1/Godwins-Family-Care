'use strict';
// Chapter G · Community Care Liaison (Playbook v3.0 G.1-G.7). "Chapter F
// governs screening, documentation, and work-state registration; this chapter
// covers what is specific to the role."

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('../onboarding/chapterF');
const G = require('../onboarding/chapterG');
const T = require('../onboarding/track');
const { SOURCES } = require('../onboarding/sources');

test('G carries F\'s screening, paperwork and payroll items unchanged, and none of F\'s systems or review items', () => {
  F.ITEMS.filter(it => ['F.4', 'F.5', 'F.6'].includes(it.phase)).forEach(it => assert.ok(G.ITEMS.includes(it), `${it.id} missing`));
  F.ITEMS.filter(it => ['F.7', 'F.9'].includes(it.phase)).forEach(it => assert.ok(!G.ITEMS.includes(it), `${it.id} should be replaced by G`));
  assert.ok(G.ITEMS.find(x => x.id === 'F.5.03').elements.includes('Form W-4'));
});

test('G.2 provisions every system in the table and the four approved collateral pieces', () => {
  const titles = G.OWN_ITEMS.map(x => x.title).join(' | ');
  ['Google Workspace', 'Main line extension', 'Sales portal', 'System of record'].forEach(s => assert.match(titles, new RegExp(s)));
  assert.deepStrictEqual(G.OWN_ITEMS.find(x => x.id === 'G.2.05').elements,
    ['Facility brochure', 'Continuous Care Program flyer', 'Records release', 'Service differentiation explainer']);
});

test('G.5: the counsel review of the commission plan is always on for a liaison', () => {
  const ids = (inputs) => T.composeChecklist(Object.assign({ chapter: 'G' }, inputs)).map(x => x.id);
  assert.ok(ids({}).includes('G.5.01'));
  assert.ok(!G.OWN_ITEMS.find(x => x.id === 'G.5.01').when);
});

test('G.4: three review points at days 30, 60 and 90, verified by the supervisor', () => {
  const pts = G.OWN_ITEMS.filter(x => x.phase === 'G.4');
  assert.deepStrictEqual(pts.map(x => x.dueDay), [30, 60, 90]);
  pts.forEach(p => assert.ok(p.steps.some(s => s.actor === 'SUPERVISOR' && s.action === 'VERIFY'), p.id));
});

test('G.1: a liaison gets no clinical step, no Training Library module and no readiness gate', () => {
  const t = T.buildTrack({ inputs: { chapter: 'G' }, record: {}, audience: 'office' });
  // Only the general modules every role gets (owner, 2026-11-10), in G.2.
  assert.deepStrictEqual(t.modules.map(m => m.id).sort(), [...require('../onboarding/libraryTrainings').SHARED_MODULE_IDS].sort());
  t.modules.forEach(m => assert.strictEqual(m.phase, 'G.2', m.id));
  assert.strictEqual(t.determinations.length, 0);
  G.ITEMS.forEach(it => it.steps.forEach(s => assert.ok(!['CLINICAL_DIRECTOR', 'DELEGATING_PHYSICIAN', 'CREDENTIALING_OWNER'].includes(s.actor) || it.chapter !== 'G', it.id)));
});

test('the Liaison Playbook is linked by its canonical Drive copy and acknowledged', () => {
  const ack = G.ACKNOWLEDGMENTS.find(a => a.id === 'LIAISON_PLAYBOOK');
  assert.deepStrictEqual(ack.driveFileIds, [SOURCES.LIAISON_PLAYBOOK.driveFileId]);
  assert.deepStrictEqual(G.OWN_ITEMS.find(x => x.id === 'G.2.06').acknowledges, ['LIAISON_PLAYBOOK', 'LIAISON_TRAINING_PLAN']);
});

test('weekly check-ins and the per-period commission review recur', () => {
  const ids = G.RECURRING.map(r => r.id);
  assert.ok(ids.includes('G.4.R1') && ids.includes('G.5.R1') && ids.includes('F.9.R1'));
  const R = require('../onboarding/renewals');
  assert.strictEqual(R.recordRecurring('G.4.R1', {}, '2026-11-09', { name: 'Office' }, 'now').recurring['G.4.R1'].lastDoneOn, '2026-11-09');
});

test('a liaison defaults to G, and the page offers it', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'onboarding.js'), 'utf8');
  assert.match(routes, /if \(t === 'liaison'\) return 'G';/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /\['G', 'Community Care Liaison \(remote business development\)'\]/);
});
