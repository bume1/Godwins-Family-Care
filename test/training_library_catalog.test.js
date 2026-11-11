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
  // A caregiver works under the PHC manual, not the Clinical Manual (2026-11-10).
  assert.match(mine.policy.document, /Private Home Care|PHC/i);
  assert.strictEqual(mine.host, 'EXECUTIVE_DIRECTOR');
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

test('the office can edit the policy line a training ties to, and staff see the edit', async (t) => {
  const h = await mount(t);
  assert.strictEqual((await h.call('PUT', `/api/onboarding/admin/people/${CG.id}/inputs`, { chapter: 'A' })).status, 200);
  const url = '/api/onboarding/admin/library/TRN-216/office';
  const pol = { document: 'Mandatory Reporting Policy v1', sections: '4.1 to 4.3', url: 'https://docs.google.com/document/d/abc' };
  const libRow = async () => (await h.call('GET', '/api/onboarding/admin/library')).data.modules.find(m => m.id === 'TRN-216');
  const staffRow = async () => { h.as(CG); const r = (await h.call('GET', '/api/onboarding/me')).data.track.modules.find(m => m.id === 'TRN-216'); h.as(OFFICE); return r; };
  const original = (await libRow()).policy;
  const staffOriginal = (await staffRow()).policy; // a caregiver's own line can differ (Private Home Care manual)
  assert.strictEqual((await libRow()).policyEdited, false);

  // Bad input is refused and nothing is stored.
  assert.strictEqual((await h.call('PUT', url, { policy: { document: 'x', url: 'http://plain.example' } })).status, 400);
  assert.strictEqual((await h.call('PUT', url, { policy: { document: 'x', url: 'javascript:alert(1)' } })).status, 400);
  assert.strictEqual((await h.call('PUT', url, { policy: { document: '  ', sections: '1' } })).status, 400);
  assert.strictEqual((await libRow()).policyEdited, false);

  // Only the office can change it.
  h.as(CG);
  assert.strictEqual((await h.call('PUT', url, { policy: pol })).status, 403);
  h.as(OFFICE);

  assert.strictEqual((await h.call('PUT', url, { policy: pol })).status, 200);
  const row = await libRow();
  assert.deepStrictEqual(row.policy, { document: pol.document, sections: pol.sections, url: pol.url });
  assert.strictEqual(row.policyEdited, true);
  assert.deepStrictEqual(row.catalogPolicy, original, 'the original is kept for "Use the Original"');
  assert.strictEqual((await staffRow()).policy.document, pol.document, 'staff see the edited line');

  // Saving only a next step or note leaves the policy edit in place.
  assert.strictEqual((await h.call('PUT', url, { nextStep: 'write', note: 'n' })).status, 200);
  assert.strictEqual((await libRow()).policy.document, pol.document);

  // null goes back to the catalog's line.
  assert.strictEqual((await h.call('PUT', url, { policy: null })).status, 200);
  assert.deepStrictEqual((await libRow()).policy, original);
  assert.strictEqual((await libRow()).policyEdited, false);
  assert.deepStrictEqual((await staffRow()).policy, staffOriginal);
});

test('the app training and the office payroll SOP link the right Drive files (owner, 2026-11-11)', () => {
  const LC = require('../onboarding/libraryCatalog');
  const p = LC.policyFor('TRN-004');
  assert.match(p.document, /Administrative SOPs Set 1/);
  assert.strictEqual(p.url, 'https://drive.google.com/file/d/1vXFFEqeAJHGEidNdhB3atE59ZffHu7ma/view');
  assert.match(p.sections, /SOP-ACC-01.*SOP-ONB-01.*SOP-SIG-02/);
  assert.match(LC.entryFor('TRN-004').note, /SOP-SCH-01/, 'scheduling is still owed');
  const set3 = LC.referenceRows().find(r => r.id === 'SOP Set 3');
  assert.strictEqual(set3.policy.url, 'https://drive.google.com/file/d/15I0r9-OCLSQIdsLQwBFb4PuR1wTJ4QKY/view');
  assert.match(set3.title, /admins and managers/);
});

test('the Staff Pay Guide sits on the pay setup step of every onboarding list (owner, 2026-11-11)', () => {
  const URL = 'https://drive.google.com/file/d/1pdgksZaDfczISVC6uTV20bMT0MKaHWVv/view';
  const want = { A: 'A.5.02', B: 'B.5.02', C: 'C.5.03', D: 'D.4.03', E: 'E.2.02', F: 'F.5.03' };
  for (const [ch, id] of Object.entries(want)) {
    const mod = require(`../onboarding/chapter${ch}`);
    const items = Object.values(mod).filter(Array.isArray).flat();
    const it = items.find(x => x && x.id === id);
    assert.ok(it, `${id} exists`);
    assert.strictEqual(it.guide && it.guide.url, URL, `${id} carries the pay guide`);
  }
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'onboarding.html'), 'utf8');
  assert.match(html, /item\.guide && <div[^>]*><a [^>]*href=\{item\.guide\.url\}/, 'the onboarding page shows it');
});
