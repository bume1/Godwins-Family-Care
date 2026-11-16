'use strict';

// The Training Library is open to every staff member (owner, 2026-11-16):
// "opening training library to employees where they can see all trainings,
// with those greyed out that are pending training material ... directing
// employees to this library to view SOPs with the direct link as supplement."
// Through the real router over HTTP, with a fake store, Drive and SOP reader.
// Document Links moved to the Admin Hub as Policy & SOP Files.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const VF = require('../onboarding/versionFlags');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const NP = { id: 'n1', name: 'Jordan Ellis', role: 'user', hasClinicalAccess: true };
const CAREGIVER = { id: 'c1', name: 'Sam Carter', role: 'vendor', accountType: 'caregiver' };
const CLIENT = { id: 'p1', name: 'Test Client', role: 'client' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WRITTEN = ['SOP-SYS-01', 'SOP-ESC-01', 'SOP-VIS-01', 'SOP-DOC-01', 'SOP-ORD-01', 'SOP-ORD-02', 'SOP-RX-01', 'SOP-EXM-01'];
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE; const log = [];
  const sections = Object.fromEntries(WRITTEN.map(id => [id, { id, title: `${id} title`, lines: [`Purpose. ${id} purpose.`] }]));
  const app = express(); app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async (...a) => { log.push(a); }, getUsers: async () => [OFFICE, NP, CAREGIVER, CLIENT],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive: { downloadFileBuffer: async () => PNG, uploadStaffDocumentFile: async () => ({ fileId: 'F1' }), describeDriveError: (e) => ({ reason: e.message }) },
    detectFileType: () => 'image/png', uuidv4: () => Math.random().toString(36).slice(2),
    sourceLoader: {
      manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }),
      checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }),
      sops: async () => ({ ok: true, version: '1.2', ids: new Set(WRITTEN), sections })
    }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* binary */ }
    return { status: res.status, data };
  };
  return { log, call, as: (u) => { current = u; } };
}

test('a caregiver sees every training, before her onboarding starts, with the pending ones greyed and their policy linked', async (t) => {
  const h = await mount(t);
  const office = (await h.call('GET', '/api/onboarding/admin/library')).data;
  h.as(CAREGIVER);
  const r = await h.call('GET', '/api/onboarding/library');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.onboardingStarted, false);
  assert.strictEqual(r.data.modules.length, office.modules.length, 'the same trainings the office library lists');
  const sop = r.data.modules.find(m => m.id === 'TRN-207');
  assert.strictEqual(sop.ready, true); assert.strictEqual(sop.comingSoon, false);
  const pending = r.data.modules.find(m => m.id === 'TRN-201');
  assert.strictEqual(pending.ready, false); assert.strictEqual(pending.comingSoon, true, 'greyed out while its SOP is written');
  assert.ok(r.data.modules.some(m => m.comingSoon && m.policy && m.policy.url), 'a greyed training still links the policy or SOP it ties to');
  assert.ok(r.data.modules.every(m => m.assigned === false));
  // The label says what is attached (2026-11-16): an SOP-backed "video" reads as Read; an empty one is planned.
  assert.strictEqual(sop.shownFormat, 'READ'); assert.strictEqual(sop.formatPlanned, false);
  assert.strictEqual(pending.shownFormat, 'VIDEO'); assert.strictEqual(pending.formatPlanned, true);
  // Nothing the office works from reaches staff.
  for (const m of r.data.modules) {
    for (const k of ['nextStep', 'officeNote', 'officeEditedBy', 'material', 'review', 'flag', 'forTypes', 'catalogPolicy']) assert.ok(!(k in m), `${k} stays office-only`);
  }
});

test('staff open a ready training even when it is not on their own onboarding; a pending or unknown one is refused', async (t) => {
  const h = await mount(t);
  h.as(CAREGIVER);
  let r = await h.call('GET', '/api/onboarding/library/TRN-207/material');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.sops.length > 0 && r.data.sops[0].lines, 'the SOP text is served');
  assert.ok(h.log.some(a => a[2] === 'onboarding_library_read'), 'the read is logged');
  r = await h.call('GET', '/api/onboarding/library/TRN-201/material');
  assert.strictEqual(r.data.code, 'MODULE_NO_MATERIAL');
  r = await h.call('GET', '/api/onboarding/library/NOPE-1/material');
  assert.strictEqual(r.status, 404);
  r = await h.call('GET', '/api/onboarding/library/TRN-201/material/files/x');
  assert.strictEqual(r.data.code, 'MODULE_NO_MATERIAL', 'no file is served from a training with no material');
});

test('a training on her own onboarding is marked, and a client is refused the library', async (t) => {
  const h = await mount(t);
  let r = await h.call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { serviceLines: ['PRIVATE_PAY', 'IME'], credentials: ['FNP'] });
  assert.strictEqual(r.status, 200);
  h.as(NP);
  r = await h.call('GET', '/api/onboarding/library');
  assert.strictEqual(r.data.onboardingStarted, true);
  const mine = r.data.modules.filter(m => m.assigned);
  const track = (await h.call('GET', '/api/onboarding/me')).data.track;
  assert.strictEqual(track.modules.find(m => m.id === 'TRN-207').shownFormat, 'READ', 'her own Training tab prints the same label');
  h.as(OFFICE);
  assert.strictEqual((await h.call('GET', '/api/onboarding/admin/library')).data.modules.find(m => m.id === 'TRN-207').shownFormat, 'READ', 'and so does the office library');
  h.as(NP);
  assert.ok(mine.length > 0 && mine.length < r.data.modules.length, 'some trainings are hers, not all');
  h.as(CLIENT);
  r = await h.call('GET', '/api/onboarding/library');
  assert.strictEqual(r.status, 403);
});

test('the pages: staff reach the library, and Document Links lives in the Admin Hub', () => {
  const ob = read('public/onboarding.html');
  assert.ok(/const StaffLibrary = /.test(ob));
  assert.ok(ob.includes("['library', 'Library', 'ti-books']"), 'a Library tab on her onboarding');
  assert.ok(ob.includes("window.location.hash === '#library'"), '#library opens it');
  assert.ok(/!d\.started\) return [^\n]*<StaffLibrary \/>/.test(ob), 'open before her onboarding starts');
  assert.ok(!/DocumentLinks|document-links/.test(ob), 'Document Links left the Training Library');
  assert.ok(ob.includes("w.library ? `/api/onboarding/library/${m}/material`"));
  const hub = read('public/admin-hub.html');
  assert.ok(hub.includes("case 'policy_files': return <PolicyFilesPage token={token} />;"));
  assert.ok(hub.includes("{ id: 'policy_files', label: 'Policy & SOP Files'"));
  assert.ok(hub.includes('/api/onboarding/admin/document-links'));
  assert.ok(read('public/my-gfc.js').includes('/onboarding#library'));
  assert.ok(read('public/caregiver.html').includes('/onboarding#library'));
});
