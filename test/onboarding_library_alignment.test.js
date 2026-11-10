'use strict';

// The Training Library lined up with each role's onboarding (owner, 2026-11-10):
// a library training with no material doesn't hold a phase open, mandatory
// reporting and incidents read right for non-clinical staff, every role's
// trainings can be signed off, and the Library says who gets what by the same
// rule as the checklist.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const T = require('../onboarding/track');
const LT = require('../onboarding/libraryTrainings');
const VF = require('../onboarding/versionFlags');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const MGR = { id: 'm1', name: 'Mona Manager', role: 'user', accountType: 'manager', isManager: true };

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, CG, MGR],
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

// Every library training done except those with no material.
const notReady = new Set(['TRN-216', 'TRN-217']);
const ready = (id) => !notReady.has(id);

test('a library training with no material does not hold the phase open; once it has material, it does', () => {
  const training = {};
  for (const id of [...LT.SHARED_MODULE_IDS, 'TRN-501', 'TRN-502', 'TRN-503']) if (!notReady.has(id)) training[id] = { completedAt: '2026-11-10T12:00:00Z', version: '1' };
  const build = (materialReady) => T.buildTrack({ inputs: { chapter: 'A' }, record: { userId: 'c1', training }, accountType: 'caregiver', materialReady });
  const open = build(ready).phases.find(p => p.id === 'A.7').outstandingModules;
  assert.deepStrictEqual(open, [], 'TRN-216/217 have no material and do not count');
  assert.deepStrictEqual(build(() => true).phases.find(p => p.id === 'A.7').outstandingModules.sort(), ['TRN-216', 'TRN-217'], 'with material they count');
});

test('a clinician\'s own curriculum still holds the phase open without material', () => {
  const t = T.buildTrack({ inputs: { chapter: 'C', serviceLines: ['PRIVATE_PAY'], credentials: ['FNP'] }, record: { userId: 'n1' }, accountType: 'provider', materialReady: () => false });
  const c7 = t.phases.find(p => p.id === 'C.7');
  assert.ok(c7.outstandingModules.includes('TRN-005'), 'the chapter\'s own module still blocks');
});

test('mandatory reporting and incidents: the Executive Director for non-clinical staff, the Clinical Director for clinicians', () => {
  const cg = T.buildTrack({ inputs: { chapter: 'A' }, record: { userId: 'c1' }, accountType: 'caregiver' });
  const admin = T.buildTrack({ inputs: { chapter: 'F' }, record: { userId: 'f1' }, accountType: 'admin' });
  const np = T.buildTrack({ inputs: { chapter: 'C', serviceLines: ['IME'], credentials: ['FNP'] }, record: { userId: 'n1' }, accountType: 'provider' });
  for (const id of ['TRN-216', 'TRN-217']) {
    assert.strictEqual(cg.modules.find(m => m.id === id).host, 'EXECUTIVE_DIRECTOR', id);
    assert.strictEqual(admin.modules.find(m => m.id === id).host, 'EXECUTIVE_DIRECTOR', id);
    assert.strictEqual(np.modules.find(m => m.id === id).host, 'CLINICAL_DIRECTOR', id);
  }
  assert.strictEqual(admin.modules.find(m => m.id === 'TRN-005').title, 'Privacy and security in GFC systems');
  assert.match(cg.modules.find(m => m.id === 'TRN-005').title, /residence/, 'caregivers keep the home wording');
});

test('a contracted clinician never gets an office-added training the office signs off', () => {
  const rows = [{ id: 'LIB-1', title: 'Shadow a visit', types: ['provider'], signoff: 'OBSERVED' }, { id: 'LIB-2', title: 'Read this', types: ['provider'], signoff: 'ATTEST' }];
  const ids = LT.extrasFor({ chapterId: 'D', accountType: 'provider', rows, alreadyIds: [] }).map(x => x.module.id);
  assert.ok(!ids.includes('LIB-1'));
  assert.ok(ids.includes('LIB-2'));
  assert.ok(LT.extrasFor({ chapterId: 'C', accountType: 'provider', rows, alreadyIds: [] }).some(x => x.module.id === 'LIB-1'), 'an employed clinician still gets it');
});

test('the Library says who gets each training by the checklist\'s own rule', async (t) => {
  const h = await mount(t);
  const lib = (await h.call('GET', '/api/onboarding/admin/library')).data.modules;
  const who = (id) => (lib.find(m => m.id === id) || {}).forTypes || [];
  assert.deepStrictEqual(who('TRN-501'), ['caregiver']);
  assert.ok(who('TRN-009').includes('coordinator'));
  assert.ok(!who('TRN-201').includes('rn'), 'an RN gets no clinician curriculum');
  assert.ok(who('TRN-201').includes('provider'));
  assert.strictEqual(who('TRN-216').length, LT.STAFF_TYPES.length);
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /const forThis = \(m\) => !forRole \|\| \(m\.forTypes \|\| \[\]\)\.includes\(forRole\);/);
});

test('the office signs off any role\'s training, but only one on that person\'s checklist', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${MGR.id}/inputs`, { chapter: 'F' });
  assert.strictEqual((await h.call('POST', `/api/onboarding/admin/people/${MGR.id}/modules/TRN-001/complete`, {})).status, 200);
  const off = await h.call('POST', `/api/onboarding/admin/people/${MGR.id}/modules/TRN-201/complete`, {});
  assert.strictEqual(off.data.code, 'MODULE_NOT_ON_TRACK');
});

test('the page shows the Training tab for every role with trainings, and every open training', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /k === 'training' \? \(\(t\.modules \|\| \[\]\)\.length > 0/);
  assert.doesNotMatch(page, /filter\(m => !m\.complete\)\.slice\(0, 8\)/);
});

test('through the real route: a training with no material is not counted against the phase, on her screen and the office overview', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${CG.id}/inputs`, { chapter: 'A' });
  h.as(CG);
  const mine = (await h.call('GET', '/api/onboarding/me')).data.track;
  const a7 = mine.phases.find(p => p.id === 'A.7');
  assert.ok(a7.requiredModules.includes('TRN-216'), 'still listed');
  assert.ok(!a7.outstandingModules.includes('TRN-216'), 'but not holding the phase open');
  assert.strictEqual(mine.modules.find(m => m.id === 'TRN-216').available, false, 'still Coming Soon');
});

test('the office rewrites an item\'s or a training\'s instructions; staff see them; blank goes back', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${CG.id}/inputs`, { chapter: 'A' });
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/instructions/A.5.02', { text: 'Upload your I-9 photo and your W-4.' })).status, 200);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/instructions/TRN-001', { text: 'Watch the welcome video.' })).status, 200);
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/instructions/NOPE', { text: 'x' })).status, 404);
  h.as(CG);
  let tr = (await h.call('GET', '/api/onboarding/me')).data.track;
  assert.strictEqual(tr.items.find(i => i.id === 'A.5.02').description, 'Upload your I-9 photo and your W-4.');
  assert.strictEqual(tr.modules.find(m => m.id === 'TRN-001').description, 'Watch the welcome video.');
  assert.strictEqual((await h.call('PUT', '/api/onboarding/admin/instructions/A.5.02', { text: 'x' })).status, 403, 'only the office edits');
  h.as(OFFICE);
  await h.call('PUT', '/api/onboarding/admin/instructions/A.5.02', { text: '' });
  h.as(CG);
  tr = (await h.call('GET', '/api/onboarding/me')).data.track;
  assert.notStrictEqual(tr.items.find(i => i.id === 'A.5.02').description, 'Upload your I-9 photo and your W-4.', 'blank restores the default');
});

test('onboarding greys out only what the Library says is waiting on an SOP', async (t) => {
  const h = await mount(t);
  await h.call('PUT', `/api/onboarding/admin/people/${CG.id}/inputs`, { chapter: 'A' });
  const lib = (await h.call('GET', '/api/onboarding/admin/library')).data.modules;
  h.as(CG);
  const mine = (await h.call('GET', '/api/onboarding/me')).data.track.modules;
  for (const m of mine) {
    const step = (lib.find(x => x.id === m.id) || {}).nextStep;
    const waiting = !(m.material && m.material.ready) && ['write', 'gap'].includes(step);
    assert.strictEqual(!!m.waitingOnSop, waiting, `${m.id}: Library says ${step}`);
  }
});

test('the page greys a training out by the server\'s waitingOnSop, and the office can edit instructions', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(page, /if \(!office && m\.waitingOnSop\) \{/);
  assert.match(page, /\{office && <InstructionsEditor id=\{item\.id\}/);
  assert.match(page, /\{office && <InstructionsEditor id=\{m\.id\}/);
});
