'use strict';

// My GFC, the staff portal, through the real router over HTTP with a fake
// store and a fake Drive. Assertions read what was stored or returned.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const portal = require('../routes/staffPortal');

const ADMIN = { id: 'a1', name: 'Office Admin', role: 'admin' };
const NP = { id: 'n1', name: 'Bethel Godwins', role: 'user', accountType: 'provider', clinicalRole: 'provider', hasClinicalAccess: true };
const RN = { id: 'r1', name: 'Rae Nurse', role: 'user', accountType: 'rn', clinicalRole: 'rn', hasClinicalAccess: true };
const CG = { id: 'c1', name: 'Cara Giver', role: 'vendor', accountType: 'caregiver', licenseLevel: 'PCA' };
const CLIENT = { id: 'p1', name: 'Pat Client', role: 'client', accountType: 'client' };

// A tiny Drive: ROOT holds a subfolder SUB and a file; OTHER is a folder
// nobody assigned.
const TREE = {
  ROOT: [{ id: 'SUB', name: 'Forms', isFolder: true }, { id: 'F1', name: 'Protocol.pdf', isFolder: false, webViewLink: 'https://drive.google.com/file/d/F1/view' }],
  SUB: [{ id: 'F2', name: 'Intake form.docx', isFolder: false, webViewLink: 'https://drive.google.com/file/d/F2/view' }],
  OTHER: [{ id: 'SECRET', name: 'Payroll.xlsx', isFolder: false, webViewLink: 'x' }]
};

async function mount(t) {
  const store = {};
  const db = { get: async (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : null), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } };
  let current = ADMIN;
  const logged = [];
  const drive = {
    listFolderChildren: async (id) => { if (!TREE[id]) throw new Error('File not found'); return TREE[id]; },
    getFileFingerprint: async (id) => ({ mimeType: TREE[id] ? 'application/vnd.google-apps.folder' : 'application/pdf' }),
    downloadFileBuffer: async () => Buffer.from('%PDF-1.4 test'),
    describeDriveError: (e) => ({ reason: e.message })
  };
  const app = express();
  app.use(express.json());
  app.use(portal({
    db, uuidv4: () => Math.random().toString(36).slice(2), drive,
    logActivity: async (...a) => { logged.push(a); },
    getUsers: async () => [ADMIN, NP, RN, CG, CLIENT],
    authenticateToken: (req, _res, next) => { req.user = current; next(); }
  }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* binary */ }
    return { status: res.status, data };
  };
  return { store, logged, call, as: (u) => { current = u; } };
}

const addFolder = async (h, body) => {
  h.as(ADMIN);
  const r = await h.call('POST', '/api/my/admin/folders', Object.assign({ link: 'https://drive.google.com/drive/folders/ROOTROOTROOT', label: 'Clinical Forms' }, body));
  return r;
};

test('a folder assigned to clinicians reaches a clinician, not a caregiver or a client', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  const r = await addFolder(h, { types: ['provider'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(h.store.staff_portal_folders[0].folderId, 'ROOTROOTROOT');
  h.as(NP);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders.map(f => f.label), ['Clinical Forms']);
  h.as(RN);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders, []);
  h.as(CG);
  assert.deepStrictEqual((await h.call('GET', '/api/my/folders')).data.folders, []);
  h.as(CLIENT);
  assert.strictEqual((await h.call('GET', '/api/my/folders')).data.code, 'STAFF_PORTAL_STAFF_ONLY');
});

test('a folder assigned to one person by name reaches only that person', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  await addFolder(h, { userIds: [RN.id] });
  h.as(RN);
  assert.strictEqual((await h.call('GET', '/api/my/folders')).data.folders.length, 1);
  h.as(NP);
  assert.strictEqual((await h.call('GET', '/api/my/folders')).data.folders.length, 0);
});

test('she browses down into a subfolder, and never outside the folder assigned to her', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  await addFolder(h, { types: ['provider'] });
  const id = h.store.staff_portal_folders[0].id;
  h.as(NP);
  const top = await h.call('GET', `/api/my/folders/${id}/items`);
  assert.deepStrictEqual(top.data.items.map(i => i.name), ['Forms', 'Protocol.pdf']);
  assert.strictEqual(top.data.items[1].url, 'https://drive.google.com/file/d/F1/view');
  const sub = await h.call('GET', `/api/my/folders/${id}/items?path=SUB`);
  assert.deepStrictEqual(sub.data.items.map(i => i.name), ['Intake form.docx']);
  assert.deepStrictEqual(sub.data.crumbs, [{ id: 'SUB', name: 'Forms' }]);
  const escape = await h.call('GET', `/api/my/folders/${id}/items?path=OTHER`);
  assert.strictEqual(escape.status, 404);
  assert.strictEqual(escape.data.code, 'FOLDER_OUTSIDE_SCOPE');
  assert.ok(!JSON.stringify(escape.data).includes('Payroll'));
  // A file id is not a folder to step into either.
  assert.strictEqual((await h.call('GET', `/api/my/folders/${id}/items?path=F1`)).data.code, 'FOLDER_OUTSIDE_SCOPE');
  // Someone the folder is not assigned to cannot list it by id.
  h.as(CG);
  assert.strictEqual((await h.call('GET', `/api/my/folders/${id}/items`)).status, 404);
});

test('only an administrator adds folders, and a bad link or a file is refused before anything is stored', async (t) => {
  const h = await mount(t);
  h.as(NP);
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'ROOTROOTROOT', label: 'x', types: ['provider'] })).data.code, 'STAFF_PORTAL_ADMIN_ONLY');
  h.as(ADMIN);
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'not a link', label: 'x', types: ['provider'] })).data.code, 'FOLDER_LINK_INVALID');
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'https://drive.google.com/drive/folders/ROOTROOTROOT', label: 'x' })).data.code, 'FOLDER_AUDIENCE_REQUIRED');
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'https://drive.google.com/file/d/APDFFILE1234/view', label: 'x', types: ['provider'] })).data.code, 'FOLDER_LINK_INVALID');
  assert.strictEqual((await h.call('POST', '/api/my/admin/folders', { link: 'APDFFILE1234', label: 'x', types: ['provider'] })).data.code, 'FOLDER_NOT_A_FOLDER');
  assert.strictEqual(h.store.staff_portal_folders, undefined);
});

test('removing a folder takes it off everyone\'s list', async (t) => {
  const h = await mount(t);
  TREE.ROOTROOTROOT = TREE.ROOT;
  await addFolder(h, { types: ['provider'] });
  const id = h.store.staff_portal_folders[0].id;
  await h.call('DELETE', `/api/my/admin/folders/${id}`);
  assert.deepStrictEqual(h.store.staff_portal_folders, []);
  h.as(NP);
  assert.strictEqual((await h.call('GET', `/api/my/folders/${id}/items`)).status, 404);
});

test('my documents are mine: another person\'s reads as absent and no Drive id leaves the server', async (t) => {
  const h = await mount(t);
  h.store.caregiver_documents = [
    { id: 'd1', caregiver_id: NP.id, kind: 'clinician_onboarding', file_name: 'license.pdf', drive_file_id: 'DRIVE_SECRET', status: 'accepted', uploaded_at: '2026-11-01', uploaded_by_office: true, uploaded_by_name: 'Office Admin' },
    { id: 'd2', caregiver_id: CG.id, kind: 'timesheet', file_name: 'week.pdf', drive_file_id: 'DRIVE_OTHER', status: 'received', uploaded_at: '2026-11-02' }
  ];
  h.as(NP);
  const list = await h.call('GET', '/api/my/documents');
  assert.deepStrictEqual(list.data.documents.map(d => d.id), ['d1']);
  assert.strictEqual(list.data.documents[0].filedByOffice, true);
  assert.ok(!JSON.stringify(list.data).includes('DRIVE_SECRET'));
  assert.strictEqual((await h.call('GET', '/api/my/documents/d2/file')).status, 404);
  const own = await h.call('GET', '/api/my/documents/d1/file');
  assert.strictEqual(own.status, 200);
  assert.ok(h.logged.some(a => a[2] === 'staff_portal_document_read'));
});

test('policies follow the role: the Clinical P&P for clinicians, the Administrative P&P for the office', () => {
  const ids = (t) => portal.policiesFor(t).map(p => p.id);
  assert.ok(ids('provider').includes('CLINICAL_MANUAL'));
  assert.ok(!ids('provider').includes('ADMIN_MANUAL'));
  assert.ok(ids('admin').includes('ADMIN_MANUAL'));
  assert.ok(!ids('admin').includes('CLINICAL_MANUAL'));
  assert.ok(!ids('caregiver').includes('CLINICAL_MANUAL'));
  assert.ok(ids('caregiver').includes('FIELD_ADDENDUM'));
  assert.ok(!ids('admin').includes('FIELD_ADDENDUM'));
  const clin = portal.policiesFor('provider').find(p => p.id === 'CLINICAL_MANUAL');
  assert.strictEqual(clin.version, '2.2');
  assert.ok(clin.links[0].includes('1LBCQ-OHx1x6be9TfiXOTg7-O0a3-rwN6'), 'the canonical copy in Policies / Current');
});

test('a shared file is never streamed by the app: the folder route returns Drive links only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'staffPortal.js'), 'utf8');
  const at = src.indexOf("router.get('/api/my/folders/:id/items'");
  const body = src.slice(at, src.indexOf('router.get(\'/api/my/admin/folders\'', at));
  assert.ok(at > 0 && body.length > 200);
  assert.ok(!/downloadFileBuffer|res\.send\(/.test(body));
});

test('the portal page and the ways into it', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  assert.match(read('clinical.html'), /href="\/my"[^>]*>.*My Portal/);
  assert.ok(!/href="\/onboarding"/.test(read('clinical.html')), 'clinicians reach onboarding through My GFC now');
  assert.match(read('caregiver.html'), /window\.location\.href = '\/my'/);
  const at = require('../accountTypes');
  for (const t of ['admin', 'manager', 'coordinator']) assert.strictEqual(at.hubTilesFor(at.fieldsFor(t))[0].id, 'myGfc', t);
  const page = read('my.html');
  assert.match(page, /<script src="\/session-guard\.js"><\/script>/);
  assert.ok(!/drive_file_id|driveFileId/.test(page), 'the page never handles a Drive id');
});
