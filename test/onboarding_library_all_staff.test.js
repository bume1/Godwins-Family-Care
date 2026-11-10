'use strict';

// The Training Library for every team member (owner, 2026-11-10): clinical
// modules stay with clinicians, six general modules go to every role, and a
// training the office adds is required for the roles it is scoped to.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const T = require('../onboarding/track');
const LT = require('../onboarding/libraryTrainings');
const VF = require('../onboarding/versionFlags');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const SW = { id: 's1', name: 'Sam Worker', role: 'user', accountType: 'lcsw', clinicalRole: 'lcsw', hasClinicalAccess: true };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const USERS = [OFFICE, CG, SW, RN];

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const sourceLoader = {
    manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }),
    checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] })
  };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => USERS,
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive: {}, detectFileType: () => null, uuidv4: () => Math.random().toString(36).slice(2), sourceLoader,
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

test('a caregiver gets the six general modules in their training phase, and no clinical curriculum', () => {
  const t = T.buildTrack({ inputs: { chapter: 'A' }, record: { userId: 'c1' }, accountType: 'caregiver' });
  assert.deepStrictEqual(t.modules.map(m => m.id).sort(), [...LT.SHARED_MODULE_IDS].sort());
  t.modules.forEach(m => assert.strictEqual(m.phase, 'A.7', m.id));
  assert.deepStrictEqual(t.phases.find(p => p.id === 'A.7').requiredModules.sort(), [...LT.SHARED_MODULE_IDS].sort(), 'they count toward the phase');
});

test('a clinician already carries the general modules once, not twice', () => {
  const t = T.buildTrack({ inputs: { chapter: 'C', serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'] }, record: { userId: 'n1' }, accountType: 'provider' });
  const ids = t.modules.map(m => m.id);
  assert.strictEqual(ids.length, new Set(ids).size, 'no module twice');
  LT.SHARED_MODULE_IDS.forEach(id => assert.ok(ids.includes(id), id));
});

test('a training the office adds reaches exactly the roles it is scoped to, as a required module', async (t) => {
  const h = await mount(t);
  for (const [u, chapter] of [[CG, 'A'], [SW, 'C'], [RN, 'B']]) {
    assert.strictEqual((await h.call('PUT', `/api/onboarding/admin/people/${u.id}/inputs`, { chapter })).status, 200);
  }
  const bad = await h.call('POST', '/api/onboarding/admin/library/trainings', { title: 'No roles', types: [] });
  assert.strictEqual(bad.status, 400, 'a training must say who it is for');
  assert.strictEqual((await h.call('POST', '/api/onboarding/admin/library/trainings', { title: 'x', types: ['client'] })).status, 400, 'clients are not staff');
  const added = await h.call('POST', '/api/onboarding/admin/library/trainings', { title: 'Grief support basics', types: ['lcsw', 'caregiver'] });
  assert.strictEqual(added.status, 200);
  const id = added.data.training.id;

  const trackOf = async (u) => { h.as(u); return (await h.call('GET', '/api/onboarding/me')).data.track; };
  const cg = await trackOf(CG); const sw = await trackOf(SW); const rn = await trackOf(RN);
  assert.ok(cg.modules.some(m => m.id === id), 'the caregiver gets it');
  assert.ok(sw.modules.some(m => m.id === id), 'the LCSW gets it');
  assert.ok(!rn.modules.some(m => m.id === id), 'the RN does not');
  assert.ok(cg.phases.find(p => p.id === 'A.7').requiredModules.includes(id), 'required in the caregiver training phase');
  assert.ok(sw.phases.find(p => p.id === 'C.7').requiredModules.includes(id), 'required in the clinician training phase');

  // No material yet: greyed out for staff, refused on the server.
  h.as(CG);
  assert.strictEqual((await h.call('POST', `/api/onboarding/me/modules/${id}/complete`)).status, 409);
  h.as(OFFICE);
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/library/${id}/material/links`, { url: 'https://docs.google.com/document/d/abc', label: 'Guide', kind: 'document' })).status, 200);
  h.as(CG);
  assert.strictEqual((await h.call('POST', `/api/onboarding/me/modules/${id}/complete`)).status, 200, 'she completes it herself');
  assert.ok((await trackOf(CG)).modules.find(m => m.id === id).complete);

  // The office's library lists it with who it is for; removing takes it off everyone's onboarding.
  h.as(OFFICE);
  const lib = (await h.call('GET', '/api/onboarding/admin/library')).data;
  const row = lib.modules.find(m => m.id === id);
  assert.strictEqual(row.audience, 'LCSW, Caregiver');
  assert.strictEqual(lib.modules.find(m => m.id === 'TRN-206').audience, 'Clinicians');
  assert.strictEqual(lib.modules.find(m => m.id === 'TRN-005').audience, 'Everyone');
  assert.strictEqual((await h.call('DELETE', `/api/onboarding/admin/library/trainings/${id}`)).status, 200);
  assert.ok(!(await trackOf(SW)).modules.some(m => m.id === id));
  assert.ok(h.store.onboarding_library_trainings.find(r => r.id === id).removedAt, 'kept, never deleted');
});

test('only the office adds or removes a training', async (t) => {
  const h = await mount(t);
  h.as(CG);
  assert.strictEqual((await h.call('POST', '/api/onboarding/admin/library/trainings', { title: 'x', types: ['caregiver'] })).status, 403);
});
