'use strict';

// The Training Library is built on real SOPs (owner, 2026-11-09). A module is
// open to staff only when a written SOP or office-added material is behind it;
// "SOP not written" is the office's to see, never staff's. Through the real
// router over HTTP, with a fake store, Drive and SOP reader.

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const TM = require('../onboarding/trainingMaterial');
const P = require('../onboarding/sourceParsers');
const VF = require('../onboarding/versionFlags');
const { MODULES, findModule } = require('../onboarding/modules');

const OFFICE = { id: 'a1', name: 'Office Admin', role: 'admin' };
const NP = { id: 'n1', name: 'Jordan Ellis', role: 'user', hasClinicalAccess: true };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// What Drive's SOP Set 1 holds today: eight written procedures.
const WRITTEN = ['SOP-SYS-01', 'SOP-ESC-01', 'SOP-VIS-01', 'SOP-DOC-01', 'SOP-ORD-01', 'SOP-ORD-02', 'SOP-RX-01', 'SOP-EXM-01'];

async function mount(t, { sopsOk = true } = {}) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = OFFICE;
  const uploads = [];
  const drive = {
    uploadStaffDocumentFile: async (role, folder, name) => { uploads.push({ role, folder, name }); return { fileId: 'DRIVE_SECRET_9' }; },
    downloadFileBuffer: async () => PNG,
    describeDriveError: (e) => ({ reason: e.message })
  };
  const sections = Object.fromEntries(WRITTEN.map(id => [id, { id, title: `${id} title`, lines: [`Purpose. ${id} purpose.`] }]));
  const sourceLoader = {
    manualState: async () => ({ ok: true, currentVersion: '2.2', changeLog: VF.SEEDED_CHANGES.slice() }),
    checks: async () => ({ ok: true, sops: {}, library: {}, errors: [] }),
    sops: async () => (sopsOk ? { ok: true, version: '1.2', ids: new Set(WRITTEN), sections } : { ok: false, reason: 'Drive down', ids: null, sections: {} })
  };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/onboarding')({
    db, config: {}, logActivity: async () => {}, getUsers: async () => [OFFICE, NP],
    authenticateToken: (req, _res, next) => { req.user = current; next(); },
    drive, detectFileType: () => 'image/png', uuidv4: () => Math.random().toString(36).slice(2), sourceLoader
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + path, { method, headers: body && !isForm ? { 'Content-Type': 'application/json' } : {}, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* binary */ }
    return { status: res.status, data };
  };
  const startHer = async () => {
    current = OFFICE;
    const r = await call('PUT', `/api/onboarding/admin/people/${NP.id}/inputs`, { serviceLines: ['PRIVATE_PAY', 'IME'], credentials: ['FNP'] });
    assert.strictEqual(r.status, 200);
  };
  return { store, uploads, call, startHer, as: (u) => { current = u; } };
}

test('the four states are told apart, and only SOP or added material makes a module ready', () => {
  const ids = new Set(WRITTEN);
  assert.strictEqual(TM.materialFor(findModule('TRN-207'), null, ids).status, 'SOP_WRITTEN');
  assert.strictEqual(TM.materialFor(findModule('TRN-207'), null, ids).ready, true);
  const planned = TM.materialFor(findModule('TRN-201'), null, ids);
  assert.strictEqual(planned.status, 'SOP_NOT_WRITTEN');
  assert.strictEqual(planned.plannedSop, 'SOP-PAT-01');
  assert.strictEqual(planned.ready, false);
  assert.strictEqual(TM.materialFor(findModule('TRN-401'), null, ids).status, 'NO_MATERIAL');
  const added = TM.addLink(null, { label: 'Walkthrough', url: 'https://drive.google.com/x', kind: 'video' }, OFFICE, '2026-11-09T00:00:00Z', 'l1');
  const withLink = TM.materialFor(findModule('TRN-201'), added, ids);
  assert.strictEqual(withLink.status, 'MATERIAL_ADDED');
  assert.strictEqual(withLink.ready, true);
  // A removed link is kept on record but no longer counts.
  const removed = TM.remove(added, 'links', 'l1', OFFICE, '2026-11-09T01:00:00Z');
  assert.strictEqual(TM.materialFor(findModule('TRN-201'), removed, ids).ready, false);
  assert.ok(removed.links[0].removedAt, 'the row stays, stamped');
});

test('an SOP the catalog names but Drive does not hold is reported missing; an unreadable document is not', () => {
  const m = findModule('TRN-207');
  const missing = TM.materialFor(m, null, new Set(['SOP-SYS-01']));
  assert.strictEqual(missing.status, 'SOP_MISSING_FROM_DRIVE');
  assert.strictEqual(missing.ready, false);
  const unknown = TM.materialFor(m, null, null);
  assert.strictEqual(unknown.status, 'SOP_WRITTEN', 'a Drive outage never greys out a written procedure');
  assert.strictEqual(unknown.ready, true);
});

test('staff are told ready or not, never which SOP is unwritten', () => {
  const s = TM.forStaff(TM.materialFor(findModule('TRN-201'), null, new Set(WRITTEN)));
  assert.deepStrictEqual(s, { ready: false });
});

test('links are https only and named', () => {
  assert.throws(() => TM.validateLink({ label: 'x', url: 'http://example.com' }), e => e.code === 'LINK_URL_INVALID');
  assert.throws(() => TM.validateLink({ label: 'x', url: 'javascript:alert(1)' }), e => e.code === 'LINK_URL_INVALID');
  assert.throws(() => TM.validateLink({ label: '', url: 'https://example.com' }), e => e.code === 'LINK_LABEL_REQUIRED');
  assert.throws(() => TM.validateLink({ label: 'x', url: 'https://example.com', kind: 'podcast' }), e => e.code === 'LINK_KIND_INVALID');
});

test('the SOP parser returns each procedure up to its check questions, never the answers', () => {
  const lines = ['Front matter', 'SOP-RX-01 · Prescribing, Refills, and Controlled Substances', 'Manual: 2.5, 12', '',
    'Purpose. Prescribe within authority.', 'Check questions', '*What is required?*', 'Answer: Check the PDMP.',
    'SOP-EXM-01 · Independent Medical Examination Workflow', 'Purpose. Examine.', 'Set 2 · Planned', '| SOP-PAT-01 | Referral | 6 |'];
  const s = P.sopSections(lines);
  assert.deepStrictEqual(Object.keys(s), ['SOP-RX-01', 'SOP-EXM-01']);
  assert.strictEqual(s['SOP-RX-01'].title, 'Prescribing, Refills, and Controlled Substances');
  assert.ok(s['SOP-RX-01'].lines.includes('Purpose. Prescribe within authority.'));
  assert.ok(!s['SOP-RX-01'].lines.some(l => /Answer:/.test(l)), 'answers stay out of the training text');
  assert.deepStrictEqual(s['SOP-EXM-01'].lines, ['Purpose. Examine.'], 'a planned SOP is not read as written');
});

test('today\'s catalog against today\'s Drive: 12 modules open on a written SOP, the rest greyed for staff', () => {
  const ids = new Set(WRITTEN);
  const ready = MODULES.filter(m => TM.materialFor(m, null, ids).ready);
  assert.strictEqual(ready.length, 12, 'TRN-101 (SOP-EXM-01) was retired 2026-11-10');
  assert.strictEqual(MODULES.filter(m => TM.materialFor(m, null, ids).status === 'SOP_NOT_WRITTEN').length, 10);
});

test('her door: a module with no material is greyed out, carries nothing to read, and cannot be completed', async (t) => {
  const h = await mount(t);
  await h.startHer();
  h.as(NP);
  const me = await h.call('GET', '/api/onboarding/me');
  const t001 = me.data.track.modules.find(m => m.id === 'TRN-001');
  assert.deepStrictEqual(t001.material, { ready: false });
  assert.strictEqual(t001.available, false);
  assert.ok(!JSON.stringify(me.data.track.modules).includes('SOP_NOT_WRITTEN'), 'the unwritten-SOP state is the office\'s');
  const done = await h.call('POST', '/api/onboarding/me/modules/TRN-001/complete', {});
  assert.strictEqual(done.data.code, 'MODULE_NO_MATERIAL');
  assert.ok(!(h.store.onboarding_records[0].training || {})['TRN-001'], 'nothing was written');
  const read = await h.call('GET', '/api/onboarding/me/modules/TRN-001/material');
  assert.strictEqual(read.data.code, 'MODULE_NO_MATERIAL');
});

test('her door: an SOP module opens with the procedure read from Drive', async (t) => {
  const h = await mount(t);
  await h.startHer();
  h.as(NP);
  const r = await h.call('GET', '/api/onboarding/me/modules/TRN-003/material');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.sops[0].id, 'SOP-SYS-01');
  assert.deepStrictEqual(r.data.sops[0].lines, ['Purpose. SOP-SYS-01 purpose.']);
});

test('the office adds material, and the module opens for her; removing it greys it again', async (t) => {
  const h = await mount(t);
  await h.startHer();
  h.as(NP);
  assert.strictEqual((await h.call('POST', '/api/onboarding/admin/library/TRN-001/material/links', { label: 'x', url: 'https://a.b' })).status, 403, 'only the office adds material');
  h.as(OFFICE);
  const bad = await h.call('POST', '/api/onboarding/admin/library/TRN-001/material/links', { label: 'Welcome video', url: 'http://insecure' });
  assert.strictEqual(bad.data.code, 'LINK_URL_INVALID');
  const add = await h.call('POST', '/api/onboarding/admin/library/TRN-001/material/links', { label: 'Welcome video', url: 'https://drive.google.com/file/d/abc/view', kind: 'video' });
  assert.strictEqual(add.status, 200);
  assert.strictEqual(add.data.material.status, 'MATERIAL_ADDED');
  const stored = h.store.onboarding_training_materials['TRN-001'];
  assert.strictEqual(stored.links[0].addedByName, 'Office Admin');
  h.as(NP);
  let me = await h.call('GET', '/api/onboarding/me');
  assert.strictEqual(me.data.track.modules.find(m => m.id === 'TRN-001').material.ready, true);
  const read = await h.call('GET', '/api/onboarding/me/modules/TRN-001/material');
  assert.strictEqual(read.data.links[0].label, 'Welcome video');
  assert.strictEqual((await h.call('POST', '/api/onboarding/me/modules/TRN-001/complete', {})).status, 200);
  h.as(OFFICE);
  await h.call('DELETE', `/api/onboarding/admin/library/TRN-002/material/links/nope`);
  const linkId = stored.links[0].id;
  assert.strictEqual((await h.call('DELETE', `/api/onboarding/admin/library/TRN-001/material/links/${linkId}`)).status, 200);
  assert.ok(h.store.onboarding_training_materials['TRN-001'].links[0].removedAt, 'kept, stamped removed');
});

test('a file the office uploads is stored in Drive, opened through the app, and its Drive id never leaves the server', async (t) => {
  const h = await mount(t);
  await h.startHer();
  h.as(OFFICE);
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'bag-technique.png');
  const up = await h.call('POST', '/api/onboarding/admin/library/TRN-204/material/files', fd);
  assert.strictEqual(up.status, 200);
  assert.strictEqual(h.uploads[0].role, 'GFC Training Material');
  assert.ok(!JSON.stringify(up.data).includes('DRIVE_SECRET_9'));
  const lib = await h.call('GET', '/api/onboarding/admin/library');
  assert.ok(!JSON.stringify(lib.data).includes('DRIVE_SECRET_9'));
  const row = lib.data.modules.find(m => m.id === 'TRN-204');
  assert.strictEqual(row.material.status, 'MATERIAL_ADDED');
  const mat = await h.call('GET', '/api/onboarding/admin/library/TRN-204/material');
  assert.strictEqual(mat.data.files[0].name, 'bag-technique.png');
  const res = await h.call('GET', `/api/onboarding/admin/library/TRN-204/material/files/${mat.data.files[0].id}`);
  assert.strictEqual(res.status, 200);
  const note = await h.call('PUT', '/api/onboarding/admin/library/TRN-204/material/note', { note: 'Watch, then practice.' });
  assert.strictEqual(note.data.material.note, 'Watch, then practice.');
});

test('the office library names each module\'s state, including the unwritten SOP', async (t) => {
  const h = await mount(t);
  h.as(OFFICE);
  const lib = await h.call('GET', '/api/onboarding/admin/library');
  const t201 = lib.data.modules.find(m => m.id === 'TRN-201');
  assert.strictEqual(t201.material.status, 'SOP_NOT_WRITTEN');
  assert.strictEqual(t201.material.plannedSop, 'SOP-PAT-01');
  assert.strictEqual(lib.data.sopDocument.version, '1.2');
});

test('when Drive cannot be read, SOP modules stay open and the library says why', async (t) => {
  const h = await mount(t, { sopsOk: false });
  await h.startHer();
  h.as(NP);
  const me = await h.call('GET', '/api/onboarding/me');
  assert.strictEqual(me.data.track.modules.find(m => m.id === 'TRN-003').material.ready, true);
  const mat = await h.call('GET', '/api/onboarding/me/modules/TRN-003/material');
  assert.strictEqual(mat.data.sops[0].unreadable, true);
  assert.strictEqual(mat.data.sopDocument.readError, 'Drive down');
  h.as(OFFICE);
  const lib = await h.call('GET', '/api/onboarding/admin/library');
  assert.strictEqual(lib.data.sopDocument.ok, false);
});
