'use strict';

// The Training Library matches the owner's Training Material Tracker
// (2026-11-10): one catalog entry per module, policy references staff can see,
// next steps and notes only the office can see.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const T = require('../onboarding/track');
const LC = require('../onboarding/libraryCatalog');
const TM = require('../onboarding/trainingMaterial');
const VF = require('../onboarding/versionFlags');
const { MODULES } = require('../onboarding/modules');
const { SOURCES } = require('../onboarding/sources');

test('the catalog covers every module and nothing else, and every policy resolves to a Drive link', () => {
  const ids = MODULES.map(m => m.id).sort();
  assert.deepStrictEqual(Object.keys(LC.CATALOG).sort(), ids);
  for (const [id, c] of Object.entries(LC.CATALOG)) {
    assert.ok(LC.GROUPS.includes(c.group), id);
    assert.ok(Object.keys(LC.NEXT).includes(c.next), id);
    assert.deepStrictEqual(Object.keys(LC.NEXT).sort(), [...TM.NEXT_STEPS].sort(), 'one vocabulary for next steps');
    if (c.policy) {
      assert.ok(SOURCES[c.policy.doc], `${id} names a known document`);
      assert.match(LC.policyFor(id).url, /^https:\/\/drive\.google\.com\/file\/d\//);
    }
  }
  assert.ok(!ids.includes('TRN-101'), 'TRN-101 was retired');
});

test('TRN-009 reaches clinicians and care coordinators, the caregiver videos reach caregivers only', () => {
  const mods = (chapter, accountType) => T.buildTrack({ inputs: { chapter, serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'] }, record: { userId: 'x' }, accountType }).modules.map(m => m.id);
  for (const [ch, t] of [['C', 'provider'], ['B', 'rn'], ['C', 'lcsw'], ['C', 'lmsw'], ['F', 'coordinator']]) {
    assert.ok(mods(ch, t).includes('TRN-009'), t);
    assert.ok(!mods(ch, t).some(id => /^TRN-50/.test(id)), `${t} gets no caregiver video`);
  }
  for (const [ch, t] of [['A', 'caregiver'], ['G', 'liaison'], ['F', 'manager']]) assert.ok(!mods(ch, t).includes('TRN-009'), t);
  assert.deepStrictEqual(mods('A', 'caregiver').filter(id => /^TRN-50/.test(id)).sort(), ['TRN-501', 'TRN-502', 'TRN-503']);
  const c7 = T.buildTrack({ inputs: { chapter: 'C', serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'] }, record: { userId: 'x' }, accountType: 'provider' }).phases.find(p => p.id === 'C.7');
  assert.ok(c7.requiredModules.includes('TRN-009'), 'required in the training phase');
});

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const app = express();
  app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, CG],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive: {}, detectFileType: () => null, uuidv4: () => Math.random().toString(36).slice(2),
    sourceLoader: { manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }), checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }) },
    notify: () => null, getAppBaseUrl: async () => 'https://app.test.local'
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };
  return { store, call, as: (u) => { current = u; } };
}

test('staff see why a training matters; only the office sees the next step and the note', async (t) => {
  const h = await mount(t);
  assert.strictEqual((await h.call('PUT', `/api/onboarding/admin/people/${CG.id}/inputs`, { chapter: 'A' })).status, 200);
  const lib = (await h.call('GET', '/api/onboarding/admin/library')).data;
  const t216 = lib.modules.find(m => m.id === 'TRN-216');
  assert.strictEqual(t216.group, 'Every role');
  assert.strictEqual(t216.nextStep, 'write');
  assert.match(t216.officeNote, /Hole: 19\.2/);
  assert.match(t216.policy.document, /Clinical Policies and Procedures Manual/);
  assert.ok(lib.referenceRows.some(r => /Care Courses/.test(r.title)));

  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/library/TRN-216/office', { nextStep: 'nope' })).status, 400);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/library/TRN-216/office', { nextStep: 'attach', note: 'Draft in review with counsel' })).status, 200);
  const again = (await h.call('GET', '/api/onboarding/admin/library')).data.modules.find(m => m.id === 'TRN-216');
  assert.strictEqual(again.nextStep, 'attach');
  assert.strictEqual(again.officeNote, 'Draft in review with counsel');
  assert.strictEqual(again.officeEditedBy, 'Office Admin');
  assert.strictEqual(again.material.ready, false, 'office fields never make a training ready');

  h.as(CG);
  const track = (await h.call('GET', '/api/onboarding/me')).data.track;
  const mine = track.modules.find(m => m.id === 'TRN-216');
  assert.match(mine.policy.sections, /19\.1/);
  const payload = JSON.stringify(track.modules);
  assert.ok(!/officeNote|nextStep|counsel|Hole:/.test(payload), 'no office field reaches staff');
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/library/TRN-216/office', { note: 'x' })).status, 403);
});

test('a training whose next step is "attach" reads covered once material is attached', async (t) => {
  const h = await mount(t);
  const before = (await h.call('GET', '/api/onboarding/admin/library')).data.modules.find(m => m.id === 'TRN-001');
  assert.strictEqual(before.nextStep, 'attach', 'nothing attached yet in a fresh store');
  await h.call('POST', '/api/onboarding/admin/library/TRN-001/material/links', { label: 'Team Roles', url: 'https://drive.google.com/file/d/abc/view', kind: 'document' });
  const after = (await h.call('GET', '/api/onboarding/admin/library')).data.modules.find(m => m.id === 'TRN-001');
  assert.strictEqual(after.nextStep, 'done');
  assert.strictEqual(after.material.ready, true);
});
